//! Disposes of deleted books' folders. The database rows go first; each folder
//! is then checked again and handed to the host's removal strategy: desktop
//! moves it to the system trash, the server removes it permanently.
use std::path::{Component, Path, PathBuf};

use crate::contracts::DeleteBooksOutcome;

/// Books already deleted from the database whose folders still need removing.
/// Removing them is a separate step so hosts can release the library lock
/// before touching the filesystem.
#[must_use = "the deleted books' folders are still on disk"]
pub struct DeletedBooks {
    pub(super) library_root: PathBuf,
    pub(super) folders: Vec<PathBuf>,
}

impl DeletedBooks {
    /// Removes each book folder with `remove`, then its author folder if that
    /// is left empty, as Calibre does. Failures are reported by path relative
    /// to the library, never with the library's own location.
    pub fn remove_folders(
        self,
        remove: impl Fn(&Path) -> Result<(), String>,
    ) -> DeleteBooksOutcome {
        let folder_failures = self
            .folders
            .iter()
            .filter_map(
                |folder| match remove_book_dir(&self.library_root, folder, &remove) {
                    Ok(true) => {
                        remove_empty_author_dir(&self.library_root, folder);
                        None
                    }
                    Ok(false) => None,
                    Err(error) => {
                        let relative = folder.strip_prefix(&self.library_root).unwrap_or(folder);
                        Some(format!("{}: {error}", relative.display()))
                    }
                },
            )
            .collect();
        DeleteBooksOutcome {
            deleted: u32::try_from(self.folders.len()).unwrap_or(u32::MAX),
            folder_failures,
        }
    }
}

/// Erases a book folder and everything in it. Symbolic links inside it are
/// removed, not followed.
pub fn remove_permanently(path: &Path) -> Result<(), String> {
    std::fs::remove_dir_all(path).map_err(|error| error.to_string())
}

/// Hands `dir` to `remove` only if it is still a real author/book directory
/// inside the library: never the root, never outside it, and never through a
/// symbolic link that appeared since the database named it. A folder that is
/// already gone is not an error and returns `false`.
fn remove_book_dir(
    library_root: &Path,
    dir: &Path,
    remove: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<bool, String> {
    let root = library_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let relative = dir
        .strip_prefix(&root)
        .map_err(|_| "The book folder is outside the library")?;
    let components: Vec<_> = relative.components().collect();
    if components.len() < 2
        || components
            .iter()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("The book folder is not a safe book directory".into());
    }
    let mut current = root.clone();
    for component in components {
        current.push(component.as_os_str());
        let metadata = match std::fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.to_string()),
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("The book folder changed or contains a symbolic link".into());
        }
    }
    let canonical = dir.canonicalize().map_err(|error| error.to_string())?;
    if canonical == root || !canonical.starts_with(&root) {
        return Err("The book folder changed or is outside the library".into());
    }
    remove(dir)?;
    Ok(true)
}

/// `remove_dir` refuses non-empty directories, so this never deletes anything
/// but an empty author folder.
fn remove_empty_author_dir(library_root: &Path, book_dir: &Path) {
    let Some(author_dir) = book_dir.parent() else {
        return;
    };
    if author_dir == library_root || !author_dir.starts_with(library_root) {
        return;
    }
    let _ = std::fs::remove_dir(author_dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestLibrary(tempfile::TempDir, PathBuf);
    impl TestLibrary {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap();
            std::fs::create_dir_all(root.join("Author/Book")).unwrap();
            Self(directory, root)
        }
        fn root(&self) -> &Path {
            &self.1
        }
        fn book(&self) -> PathBuf {
            self.1.join("Author/Book")
        }
        fn deleted(&self, folders: Vec<PathBuf>) -> DeletedBooks {
            DeletedBooks {
                library_root: self.1.clone(),
                folders,
            }
        }
    }

    #[test]
    fn removal_failure_is_reported_and_files_remain() {
        let lib = TestLibrary::new();
        std::fs::write(lib.book().join("book.epub"), "content").unwrap();
        let result = remove_book_dir(lib.root(), &lib.book(), |_| {
            Err("Permission denied by Trash".into())
        });
        assert_eq!(result.unwrap_err(), "Permission denied by Trash");
        assert!(lib.book().join("book.epub").exists());
    }

    #[test]
    fn missing_folder_is_not_removed() {
        let lib = TestLibrary::new();
        let result = remove_book_dir(lib.root(), &lib.root().join("Author/Missing"), |_| {
            panic!("missing folder must not be removed")
        });
        assert!(!result.unwrap());
    }

    #[test]
    fn library_root_cannot_be_removed() {
        let lib = TestLibrary::new();
        assert!(remove_book_dir(lib.root(), lib.root(), |_| panic!(
            "root must not be removed"
        ))
        .is_err());
    }

    #[test]
    fn author_folder_alone_cannot_be_removed() {
        let lib = TestLibrary::new();
        assert!(
            remove_book_dir(lib.root(), &lib.root().join("Author"), |_| panic!(
                "author folder must not be removed"
            ))
            .is_err()
        );
    }

    #[test]
    fn successful_move_is_reported() {
        let lib = TestLibrary::new();
        assert!(remove_book_dir(lib.root(), &lib.book(), |path| {
            std::fs::rename(path, lib.root().join("test-trash")).map_err(|e| e.to_string())
        })
        .unwrap());
        assert!(!lib.book().exists());
        assert!(lib.root().join("test-trash").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn changed_symlink_ancestor_is_not_followed() {
        let lib = TestLibrary::new();
        let outside = TestLibrary::new();
        std::fs::remove_dir_all(lib.root().join("Author")).unwrap();
        std::os::unix::fs::symlink(outside.root().join("Author"), lib.root().join("Author"))
            .unwrap();
        assert!(remove_book_dir(lib.root(), &lib.book(), |_| panic!(
            "symlink must not be followed"
        ))
        .is_err());
        assert!(outside.book().is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn access_errors_are_reported_instead_of_skipped() {
        use std::os::unix::fs::PermissionsExt;
        let lib = TestLibrary::new();
        let author = lib.root().join("Author");
        std::fs::set_permissions(&author, std::fs::Permissions::from_mode(0)).unwrap();
        let result = remove_book_dir(lib.root(), &lib.book(), |_| {
            panic!("inaccessible path must not be removed")
        });
        std::fs::set_permissions(&author, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn permanent_removal_erases_the_book_and_its_empty_author_folder() {
        let lib = TestLibrary::new();
        std::fs::write(lib.book().join("book.epub"), "content").unwrap();
        let outcome = lib
            .deleted(vec![lib.book()])
            .remove_folders(remove_permanently);
        assert_eq!(outcome.deleted, 1);
        assert!(outcome.folder_failures.is_empty());
        assert!(!lib.root().join("Author").exists());
        assert!(lib.root().is_dir());
    }

    #[test]
    fn author_folder_with_other_books_is_kept() {
        let lib = TestLibrary::new();
        std::fs::create_dir_all(lib.root().join("Author/Other Book")).unwrap();
        let outcome = lib
            .deleted(vec![lib.book()])
            .remove_folders(remove_permanently);
        assert!(outcome.folder_failures.is_empty());
        assert!(lib.root().join("Author/Other Book").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn permanent_removal_does_not_follow_symlinks_inside_the_book() {
        let lib = TestLibrary::new();
        let outside = TestLibrary::new();
        std::fs::write(outside.book().join("keep.epub"), "content").unwrap();
        std::os::unix::fs::symlink(outside.book(), lib.book().join("link")).unwrap();
        let outcome = lib
            .deleted(vec![lib.book()])
            .remove_folders(remove_permanently);
        assert!(outcome.folder_failures.is_empty());
        assert!(!lib.book().exists());
        assert!(outside.book().join("keep.epub").exists());
    }

    #[test]
    fn failures_name_the_folder_inside_the_library_only() {
        let lib = TestLibrary::new();
        let outcome = lib
            .deleted(vec![lib.book()])
            .remove_folders(|_| Err("Permission denied".into()));
        assert_eq!(outcome.deleted, 1);
        assert_eq!(
            outcome.folder_failures,
            vec![format!(
                "{}: Permission denied",
                Path::new("Author").join("Book").display()
            )]
        );
        assert!(lib.book().is_dir());
    }
}
