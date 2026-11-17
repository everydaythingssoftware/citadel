//! The menu bar's pure half: which command each item sends, the state the
//! frontend pushes, and the labels and checkmarks that state produces.
//! Only macOS has a menu bar to show them; the tests run everywhere.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use serde::{Deserialize, Serialize};

/// A menu choice delivered to the library window.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum MenuCommand {
    AddBook,
    NewShelf,
    AddLibrary,
    ShowLibraryInFileManager,
    Find,
    Undo,
    Redo,
    BookShowDetails,
    BookOpen,
    BookEdit,
    BookMarkFinished,
    BookShowInFileManager,
    BookCopyTitle,
    BookDelete,
    ToggleSidebar,
    ToggleUnreadOnly,
    Sort(MenuSortOrder),
    Go(GoDestination),
    GoBack,
    GoForward,
    #[serde(rename = "switchLibrary")]
    SwitchLibrary(String),
}

impl MenuCommand {
    /// The menu item id: the command's wire form, so ids that are not
    /// commands ("settings", "help") never parse as one.
    pub fn menu_id(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub fn from_menu_id(id: &str) -> Option<Self> {
        serde_json::from_str(id).ok()
    }

    pub fn accelerator(&self) -> Option<&'static str> {
        MENU_ACCELERATORS
            .commands
            .iter()
            .find(|(command, _)| command == self)
            .map(|(_, accelerator)| *accelerator)
    }
}

/// Every menu bar key equivalent. The frontend binds the same chords itself
/// where there is no menu bar (`src/lib/app-shortcuts.ts`).
#[derive(Serialize, specta::Type)]
pub struct MenuAccelerators {
    pub commands: &'static [(MenuCommand, &'static str)],
    /// Settings… is the app menu's own item, not a [`MenuCommand`].
    pub settings: &'static str,
}

pub const MENU_ACCELERATORS: MenuAccelerators = MenuAccelerators {
    commands: &[
        (MenuCommand::AddBook, "CmdOrCtrl+N"),
        (MenuCommand::Undo, "CmdOrCtrl+Z"),
        (MenuCommand::Redo, "CmdOrCtrl+Shift+Z"),
        (MenuCommand::Find, "CmdOrCtrl+F"),
        (MenuCommand::BookShowDetails, "CmdOrCtrl+I"),
        (MenuCommand::BookOpen, "CmdOrCtrl+O"),
        (MenuCommand::BookEdit, "CmdOrCtrl+E"),
        (MenuCommand::BookShowInFileManager, "CmdOrCtrl+Shift+R"),
        (MenuCommand::BookDelete, "CmdOrCtrl+Backspace"),
        (MenuCommand::ToggleSidebar, "Ctrl+Cmd+S"),
        (MenuCommand::Go(GoDestination::AllBooks), "CmdOrCtrl+1"),
        (MenuCommand::Go(GoDestination::Authors), "CmdOrCtrl+2"),
        (MenuCommand::Go(GoDestination::Series), "CmdOrCtrl+3"),
        (MenuCommand::Go(GoDestination::Tags), "CmdOrCtrl+4"),
        (MenuCommand::Go(GoDestination::Publishers), "CmdOrCtrl+5"),
        (MenuCommand::GoBack, "CmdOrCtrl+["),
        (MenuCommand::GoForward, "CmdOrCtrl+]"),
    ],
    settings: "CmdOrCtrl+,",
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum GoDestination {
    AllBooks,
    Authors,
    Series,
    Tags,
    Publishers,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum MenuSortOrder {
    #[default]
    NameAz,
    NameZa,
    AuthorAz,
    AuthorZa,
}

impl MenuSortOrder {
    pub const ALL: [MenuSortOrder; 4] = [
        MenuSortOrder::NameAz,
        MenuSortOrder::NameZa,
        MenuSortOrder::AuthorAz,
        MenuSortOrder::AuthorZa,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::NameAz => "Name (A–Z)",
            Self::NameZa => "Name (Z–A)",
            Self::AuthorAz => "Author (A–Z)",
            Self::AuthorZa => "Author (Z–A)",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct MenuLibrary {
    pub id: String,
    pub name: String,
    pub active: bool,
}

/// The selected books: the Book menu's enabled items and plural labels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MenuSelection {
    pub count: u32,
    pub all_finished: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MenuViewOptions {
    pub sidebar_visible: bool,
    pub unread_only: bool,
    pub sort_order: MenuSortOrder,
}

impl Default for MenuViewOptions {
    fn default() -> Self {
        Self {
            sidebar_visible: true,
            unread_only: false,
            sort_order: MenuSortOrder::NameAz,
        }
    }
}

/// Who Edit > Undo and Redo act on: a focused text field, whose typing the
/// native items undo, or the app's undo history.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "owner", rename_all = "camelCase")]
pub enum MenuUndo {
    #[default]
    TextField,
    App(AppUndo),
}

/// "Undo Mark as Finished"; an absent label disables the item.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppUndo {
    pub undo_label: Option<String>,
    pub redo_label: Option<String>,
}

/// One group of what the menu bar shows, replaced whole.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum MenuStateUpdate {
    Selection(MenuSelection),
    View(MenuViewOptions),
    Libraries(Vec<MenuLibrary>),
    Undo(MenuUndo),
    UpdateReady(Option<String>),
}

/// Everything the menu bar shows that only the frontend knows.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MenuState {
    pub selection: MenuSelection,
    pub view: MenuViewOptions,
    pub libraries: Vec<MenuLibrary>,
    pub undo: MenuUndo,
    pub update_ready_version: Option<String>,
}

impl MenuState {
    pub fn apply(&mut self, update: MenuStateUpdate) {
        match update {
            MenuStateUpdate::Selection(selection) => self.selection = selection,
            MenuStateUpdate::View(view) => self.view = view,
            MenuStateUpdate::Libraries(libraries) => self.libraries = libraries,
            MenuStateUpdate::Undo(undo) => self.undo = undo,
            MenuStateUpdate::UpdateReady(version) => self.update_ready_version = version,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ItemView {
    pub label: String,
    pub enabled: bool,
}

impl ItemView {
    fn new(label: impl Into<String>, enabled: bool) -> Self {
        Self {
            label: label.into(),
            enabled,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookMenuView {
    pub show_details: ItemView,
    pub open: ItemView,
    pub edit: ItemView,
    pub mark_finished: ItemView,
    pub show_in_file_manager: ItemView,
    pub copy_title: ItemView,
    pub delete: ItemView,
}

/// What every stateful item shows, derived from [`MenuState`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MenuView {
    pub book: BookMenuView,
    pub sidebar_label: &'static str,
    pub unread_only: bool,
    pub sort_order: MenuSortOrder,
    pub libraries: Vec<MenuLibrary>,
    pub restart_to_update: bool,
    /// Undo and Redo as the app's own items; `None` keeps the native ones.
    pub undo: Option<UndoMenuView>,
}

/// Edit > Undo and Redo, naming what they would do and disabled when there
/// is nothing to, as NSUndoManager's items are.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UndoMenuView {
    pub undo: ItemView,
    pub redo: ItemView,
}

pub fn undo_menu_view(undo_label: Option<&str>, redo_label: Option<&str>) -> UndoMenuView {
    UndoMenuView {
        undo: ItemView::new(undo_label.unwrap_or("Undo"), undo_label.is_some()),
        redo: ItemView::new(redo_label.unwrap_or("Redo"), redo_label.is_some()),
    }
}

pub const RESTART_TO_UPDATE_LABEL: &str = "Restart to Update…";

fn books(count: u32) -> String {
    format!("{count} Books")
}

/// Labels for the Book menu, matching the book's right-click menu
/// (`src/lib/book-menu.ts`). Open, Mark, Copy and Delete act on the whole
/// selection; the rest need exactly one book.
pub fn book_menu_view(selected: u32, all_finished: bool, file_manager_name: &str) -> BookMenuView {
    let single = selected == 1;
    let any = selected > 0;
    let plural = selected > 1;
    let finished = if all_finished {
        "Unfinished"
    } else {
        "Finished"
    };
    BookMenuView {
        show_details: ItemView::new("Show Details", single),
        open: ItemView::new(
            if plural {
                format!("Open {}", books(selected))
            } else {
                "Open".to_string()
            },
            any,
        ),
        edit: ItemView::new("Edit…", single),
        mark_finished: ItemView::new(format!("Mark as {finished}"), any),
        show_in_file_manager: ItemView::new(format!("Show in {file_manager_name}"), single),
        copy_title: ItemView::new(
            if plural {
                format!("Copy {selected} Titles")
            } else {
                "Copy Title".to_string()
            },
            any,
        ),
        delete: ItemView::new(
            if plural {
                format!("Delete {}…", books(selected))
            } else {
                "Delete…".to_string()
            },
            any,
        ),
    }
}

pub fn menu_view(state: &MenuState, file_manager_name: &str) -> MenuView {
    MenuView {
        book: book_menu_view(
            state.selection.count,
            state.selection.all_finished,
            file_manager_name,
        ),
        sidebar_label: if state.view.sidebar_visible {
            "Hide Sidebar"
        } else {
            "Show Sidebar"
        },
        unread_only: state.view.unread_only,
        sort_order: state.view.sort_order,
        libraries: state.libraries.clone(),
        restart_to_update: state.update_ready_version.is_some(),
        undo: match &state.undo {
            MenuUndo::TextField => None,
            MenuUndo::App(app) => Some(undo_menu_view(
                app.undo_label.as_deref(),
                app.redo_label.as_deref(),
            )),
        },
    }
}

/// Which parts of the menu bar must be touched to go from one view to the
/// next. `None` means nothing has been applied yet, so everything is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MenuChanges {
    pub book: bool,
    pub sidebar: bool,
    pub unread_only: bool,
    pub sort_order: bool,
    pub libraries: bool,
    pub restart_to_update: bool,
    pub undo: bool,
}

#[cfg(test)]
impl MenuChanges {
    pub fn any(&self) -> bool {
        self.book
            || self.sidebar
            || self.unread_only
            || self.sort_order
            || self.libraries
            || self.restart_to_update
            || self.undo
    }
}

pub fn menu_changes(previous: Option<&MenuView>, next: &MenuView) -> MenuChanges {
    let Some(previous) = previous else {
        return MenuChanges {
            book: true,
            sidebar: true,
            unread_only: true,
            sort_order: true,
            libraries: true,
            restart_to_update: true,
            undo: true,
        };
    };
    MenuChanges {
        book: previous.book != next.book,
        sidebar: previous.sidebar_label != next.sidebar_label,
        unread_only: previous.unread_only != next.unread_only,
        sort_order: previous.sort_order != next.sort_order,
        libraries: previous.libraries != next.libraries,
        restart_to_update: previous.restart_to_update != next.restart_to_update,
        undo: previous.undo != next.undo,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accelerators_are_looked_up_per_command() {
        assert_eq!(
            MenuCommand::Go(GoDestination::Tags).accelerator(),
            Some("CmdOrCtrl+4")
        );
        assert_eq!(MenuCommand::GoBack.accelerator(), Some("CmdOrCtrl+["));
        assert_eq!(MenuCommand::NewShelf.accelerator(), None);
    }

    #[test]
    fn menu_ids_round_trip_every_command_shape() {
        for command in [
            MenuCommand::AddBook,
            MenuCommand::Sort(MenuSortOrder::AuthorZa),
            MenuCommand::Go(GoDestination::AllBooks),
            MenuCommand::SwitchLibrary("a:b".into()),
        ] {
            assert_eq!(MenuCommand::from_menu_id(&command.menu_id()), Some(command));
        }
    }

    #[test]
    fn commands_have_the_frontend_shape() {
        let wire = |command: MenuCommand| serde_json::to_value(command).unwrap();
        assert_eq!(wire(MenuCommand::AddBook), serde_json::json!("add-book"));
        assert_eq!(
            wire(MenuCommand::Sort(MenuSortOrder::NameZa)),
            serde_json::json!({ "sort": "nameZa" })
        );
        assert_eq!(
            wire(MenuCommand::Go(GoDestination::AllBooks)),
            serde_json::json!({ "go": "allBooks" })
        );
        assert_eq!(
            wire(MenuCommand::SwitchLibrary("l1".into())),
            serde_json::json!({ "switchLibrary": "l1" })
        );
    }

    #[test]
    fn other_menu_ids_are_not_commands() {
        assert_eq!(MenuCommand::from_menu_id("settings"), None);
        assert_eq!(MenuCommand::from_menu_id("restart-to-update"), None);
    }

    #[test]
    fn an_update_replaces_only_its_group() {
        let mut state = MenuState {
            update_ready_version: Some("1.4".into()),
            ..MenuState::default()
        };
        state.apply(
            serde_json::from_value(serde_json::json!({
                "selection": { "count": 3, "allFinished": true }
            }))
            .unwrap(),
        );
        assert_eq!(
            state.selection,
            MenuSelection {
                count: 3,
                all_finished: true
            }
        );
        assert_eq!(state.update_ready_version.as_deref(), Some("1.4"));
        assert!(state.view.sidebar_visible);
    }

    #[test]
    fn updates_read_the_frontend_shape() {
        let mut state = MenuState::default();
        for update in [
            serde_json::json!({ "view": { "sidebarVisible": false, "unreadOnly": true, "sortOrder": "authorZa" } }),
            serde_json::json!({ "libraries": [{ "id": "l1", "name": "Books", "active": true }] }),
            serde_json::json!({ "undo": { "owner": "app", "undoLabel": "Undo Mark as Finished", "redoLabel": null } }),
            serde_json::json!({ "updateReady": null }),
        ] {
            state.apply(serde_json::from_value(update).unwrap());
        }
        assert_eq!(state.view.sort_order, MenuSortOrder::AuthorZa);
        assert_eq!(state.libraries.len(), 1);
        assert_eq!(
            state.undo,
            MenuUndo::App(AppUndo {
                undo_label: Some("Undo Mark as Finished".into()),
                redo_label: None,
            })
        );
    }

    #[test]
    fn the_book_menu_is_disabled_without_a_selection() {
        let view = book_menu_view(0, false, "Finder");
        for item in [
            &view.show_details,
            &view.open,
            &view.edit,
            &view.mark_finished,
            &view.show_in_file_manager,
            &view.copy_title,
            &view.delete,
        ] {
            assert!(!item.enabled, "{} should be disabled", item.label);
        }
        assert_eq!(view.delete.label, "Delete…");
    }

    #[test]
    fn one_book_gets_singular_labels() {
        let view = book_menu_view(1, false, "Finder");
        assert_eq!(view.open, ItemView::new("Open", true));
        assert_eq!(view.mark_finished, ItemView::new("Mark as Finished", true));
        assert_eq!(
            view.show_in_file_manager,
            ItemView::new("Show in Finder", true)
        );
        assert_eq!(view.delete, ItemView::new("Delete…", true));
        assert!(view.edit.enabled && view.show_details.enabled && view.copy_title.enabled);
    }

    #[test]
    fn several_books_get_plural_labels_and_single_book_items_disable() {
        let view = book_menu_view(2, true, "Finder");
        assert_eq!(view.open, ItemView::new("Open 2 Books", true));
        assert_eq!(
            view.mark_finished,
            ItemView::new("Mark as Unfinished", true)
        );
        assert_eq!(view.copy_title, ItemView::new("Copy 2 Titles", true));
        assert_eq!(view.delete, ItemView::new("Delete 2 Books…", true));
        assert!(!view.show_details.enabled);
        assert!(!view.edit.enabled);
        assert!(!view.show_in_file_manager.enabled);
    }

    #[test]
    fn restart_to_update_opens_with_an_ellipsis_as_the_issue_names_it() {
        assert_eq!(RESTART_TO_UPDATE_LABEL, "Restart to Update…");
    }

    #[test]
    fn the_sidebar_item_names_what_it_will_do() {
        let shown = menu_view(&MenuState::default(), "Finder");
        assert_eq!(shown.sidebar_label, "Hide Sidebar");
        let hidden = menu_view(
            &MenuState {
                view: MenuViewOptions {
                    sidebar_visible: false,
                    ..MenuViewOptions::default()
                },
                ..MenuState::default()
            },
            "Finder",
        );
        assert_eq!(hidden.sidebar_label, "Show Sidebar");
    }

    #[test]
    fn the_first_apply_touches_everything() {
        let view = menu_view(&MenuState::default(), "Finder");
        let changes = menu_changes(None, &view);
        assert!(changes.book && changes.libraries && changes.undo);
    }

    #[test]
    fn later_applies_touch_only_what_changed() {
        let before = menu_view(&MenuState::default(), "Finder");
        assert!(!menu_changes(Some(&before), &before).any());

        let after = menu_view(
            &MenuState {
                selection: MenuSelection {
                    count: 1,
                    all_finished: false,
                },
                update_ready_version: Some("1.4".into()),
                ..MenuState::default()
            },
            "Finder",
        );
        let changes = menu_changes(Some(&before), &after);
        assert_eq!(
            changes,
            MenuChanges {
                book: true,
                restart_to_update: true,
                ..MenuChanges::default()
            }
        );
    }

    #[test]
    fn undo_names_the_action_and_is_disabled_when_there_is_none() {
        let empty = undo_menu_view(None, None);
        assert_eq!(empty.undo, ItemView::new("Undo", false));
        assert_eq!(empty.redo, ItemView::new("Redo", false));
        let marked = undo_menu_view(Some("Undo Mark as Finished"), None);
        assert_eq!(marked.undo, ItemView::new("Undo Mark as Finished", true));
        assert!(!marked.redo.enabled);
    }

    #[test]
    fn a_focused_text_field_keeps_the_native_undo_items() {
        assert_eq!(menu_view(&MenuState::default(), "Finder").undo, None);
        let app = MenuState {
            undo: MenuUndo::App(AppUndo {
                undo_label: Some("Undo Mark as Finished".into()),
                redo_label: None,
            }),
            ..MenuState::default()
        };
        assert_eq!(
            menu_view(&app, "Finder").undo.map(|view| view.undo.label),
            Some("Undo Mark as Finished".to_string())
        );
    }
}
