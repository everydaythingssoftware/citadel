//! Paths inside the container. EPUB 3.3 §4.1 makes every path a URL
//! relative to the container's root (or to the package document); none may
//! leave the container.

/// Joins `relative` to the directory `base` (no trailing slash; `""` for the
/// root), resolving `.` and `..`. `None` when the path would leave the root
/// or names the root itself.
pub(crate) fn join(base: &str, relative: &str) -> Option<String> {
    let mut segments: Vec<&str> = base.split('/').filter(|s| !s.is_empty()).collect();
    for segment in relative.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            segment => segments.push(segment),
        }
    }
    (!segments.is_empty()).then(|| segments.join("/"))
}

/// The directory holding `path`, `""` at the root.
pub(crate) fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

fn has_scheme(url: &str) -> bool {
    let end = url.find(['/', '?', '#']).unwrap_or(url.len());
    url[..end].contains(':')
}

fn percent_decoded(path: &str) -> Option<String> {
    percent_encoding::percent_decode_str(path)
        .decode_utf8()
        .ok()
        .map(|decoded| decoded.into_owned())
}

/// The archive entry a rootfile's `full-path` names, checked as EPUB 3.3
/// §4.2.6.3.1 requires: a non-empty path relative to the container root
/// that stays inside it. `Err` when the path is invalid, `Ok(None)` when it
/// is valid but the archive has no such entry.
pub(crate) fn rootfile(
    full_path: &str,
    exists: impl Fn(&str) -> bool,
) -> Result<Option<String>, ()> {
    if full_path.is_empty()
        || full_path.starts_with('/')
        || full_path.contains('\\')
        || has_scheme(full_path)
        || full_path.contains(['?', '#'])
    {
        return Err(());
    }
    let raw = join("", full_path).ok_or(())?;
    let decoded = join("", &percent_decoded(full_path).ok_or(())?).ok_or(())?;
    Ok([raw, decoded].into_iter().find(|name| exists(name)))
}

/// The archive entry a manifest `href` names, resolved against the package
/// document's directory. `None` for remote resources and paths that leave
/// the container.
pub(crate) fn resource(
    package_dir: &str,
    href: &str,
    exists: impl Fn(&str) -> bool,
) -> Option<String> {
    let href = href.trim();
    let href = &href[..href.find(['?', '#']).unwrap_or(href.len())];
    if href.is_empty() || has_scheme(href) {
        return None;
    }
    let (base, href) = match href.strip_prefix('/') {
        Some(rooted) => ("", rooted),
        None => (package_dir, href),
    };
    let raw = join(base, href);
    let decoded = percent_decoded(href).and_then(|decoded| join(base, &decoded));
    match (raw, decoded) {
        (Some(raw), _) if exists(&raw) => Some(raw),
        (_, decoded @ Some(_)) => decoded,
        (raw, None) => raw,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rootfiles_must_stay_inside_the_container() {
        let all = |_: &str| true;
        for invalid in [
            "",
            "/",
            "/content.opf",
            "../x.opf",
            "a/../../x.opf",
            ".",
            "a/..",
            "http://x/y.opf",
            "a\\b.opf",
        ] {
            assert_eq!(rootfile(invalid, all), Err(()), "{invalid:?}");
        }
        assert_eq!(rootfile("content.opf", all), Ok(Some("content.opf".into())));
        assert_eq!(
            rootfile("OEBPS/./a/../content.opf", all),
            Ok(Some("OEBPS/content.opf".into()))
        );
        assert_eq!(
            rootfile("OEBPS/my%20book.opf", |name| name == "OEBPS/my book.opf"),
            Ok(Some("OEBPS/my book.opf".into()))
        );
        assert_eq!(rootfile("content.opf", |_| false), Ok(None));
    }

    #[test]
    fn hrefs_resolve_against_the_package_directory() {
        let none = |_: &str| false;
        assert_eq!(
            resource("OEBPS", "images/c.jpg", none).as_deref(),
            Some("OEBPS/images/c.jpg")
        );
        assert_eq!(
            resource("OEBPS/text", "../c%20over.png#x", none).as_deref(),
            Some("OEBPS/c over.png")
        );
        assert_eq!(resource("", "c.png", none).as_deref(), Some("c.png"));
        assert_eq!(resource("OEBPS", "/c.png", none).as_deref(), Some("c.png"));
        assert_eq!(resource("OEBPS", "../../c.png", none), None);
        assert_eq!(resource("OEBPS", "https://example.com/c.png", none), None);
        assert_eq!(
            resource("", "100%25.png", |name| name == "100%25.png").as_deref(),
            Some("100%25.png")
        );
    }
}
