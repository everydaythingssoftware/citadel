//! The macOS menu bar: Citadel · Library · Edit · Book · View · Go · Window ·
//! Help. Items that change with the library window's state are kept here
//! and updated from [`MenuView`]s.

use tauri::{
    menu::{AboutMetadataBuilder, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Runtime,
};

use super::model::{
    menu_changes, ItemView, MenuCommand, MenuSortOrder, MenuView, RESTART_TO_UPDATE_LABEL,
};

pub const MENU_ID_SETTINGS: &str = "settings";
pub const MENU_ID_ADD_BOOK: &str = "add-book";
pub const MENU_ID_CHECK_FOR_UPDATES: &str = "check-for-updates";
pub const MENU_ID_HELP: &str = "help";
pub const FILE_MANAGER_NAME: &str = "Finder";

/// Below About and Check for Updates….
const RESTART_POSITION: usize = 2;

struct BookItems<R: Runtime> {
    show_details: MenuItem<R>,
    open: MenuItem<R>,
    edit: MenuItem<R>,
    mark_finished: MenuItem<R>,
    show_in_file_manager: MenuItem<R>,
    copy_title: MenuItem<R>,
    delete: MenuItem<R>,
}

pub struct MenuBar<R: Runtime> {
    app: AppHandle<R>,
    app_menu: Submenu<R>,
    restart: MenuItem<R>,
    edit_menu: Submenu<R>,
    native_undo: PredefinedMenuItem<R>,
    native_redo: PredefinedMenuItem<R>,
    app_undo: MenuItem<R>,
    app_redo: MenuItem<R>,
    switch_library: Submenu<R>,
    book: BookItems<R>,
    sidebar: MenuItem<R>,
    unread_only: CheckMenuItem<R>,
    sort: Vec<(MenuSortOrder, CheckMenuItem<R>)>,
}

fn command_item<R: Runtime>(
    app: &AppHandle<R>,
    command: MenuCommand,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, command.menu_id(), label, true, accelerator)
}

fn set_item<R: Runtime>(item: &MenuItem<R>, view: &ItemView) -> tauri::Result<()> {
    item.set_text(&view.label)?;
    item.set_enabled(view.enabled)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<(Menu<R>, MenuBar<R>)> {
    let app_name = app.package_info().name.clone();
    let separator = || PredefinedMenuItem::separator(app);

    let about_metadata = AboutMetadataBuilder::new()
        .name(Some(app_name.clone()))
        .version(Some(app.package_info().version.to_string()))
        .build();
    let restart = command_item(
        app,
        MenuCommand::RestartToUpdate,
        RESTART_TO_UPDATE_LABEL,
        None,
    )?;
    let app_menu = Submenu::with_items(
        app,
        &app_name,
        true,
        &[
            &PredefinedMenuItem::about(
                app,
                Some(&format!("About {app_name}")),
                Some(about_metadata),
            )?,
            &MenuItem::with_id(
                app,
                MENU_ID_CHECK_FOR_UPDATES,
                "Check for Updates…",
                true,
                None::<&str>,
            )?,
            &separator()?,
            &MenuItem::with_id(
                app,
                MENU_ID_SETTINGS,
                "Settings…",
                true,
                Some("CmdOrCtrl+,"),
            )?,
            &separator()?,
            &PredefinedMenuItem::services(app, None)?,
            &separator()?,
            &PredefinedMenuItem::hide(app, Some(&format!("Hide {app_name}")))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &separator()?,
            &PredefinedMenuItem::quit(app, Some(&format!("Quit {app_name}")))?,
        ],
    )?;

    let switch_library = Submenu::new(app, "Switch Library", false)?;
    let library_menu = Submenu::with_items(
        app,
        "Library",
        true,
        &[
            &MenuItem::with_id(
                app,
                MENU_ID_ADD_BOOK,
                "Add Book…",
                true,
                Some("CmdOrCtrl+N"),
            )?,
            &command_item(app, MenuCommand::NewShelf, "New Shelf…", None)?,
            &command_item(app, MenuCommand::AddLibrary, "Add Library…", None)?,
            &separator()?,
            &switch_library,
            &command_item(
                app,
                MenuCommand::ShowLibraryInFileManager,
                &format!("Show Library in {FILE_MANAGER_NAME}"),
                None,
            )?,
            &separator()?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    // Undo/Redo are the native responder-chain items while a text field has
    // the keyboard, so ⌘Z keeps undoing typing there; otherwise they swap for
    // items that send `undo`/`redo` to the app's undo history, named after
    // its top entry and disabled when it is empty.
    let native_undo = PredefinedMenuItem::undo(app, None)?;
    let native_redo = PredefinedMenuItem::redo(app, None)?;
    let app_undo = command_item(app, MenuCommand::Undo, "Undo", Some("CmdOrCtrl+Z"))?;
    let app_redo = command_item(app, MenuCommand::Redo, "Redo", Some("CmdOrCtrl+Shift+Z"))?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &native_undo,
            &native_redo,
            &separator()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &separator()?,
            &command_item(app, MenuCommand::Find, "Find", Some("CmdOrCtrl+F"))?,
        ],
    )?;

    let book = BookItems {
        show_details: command_item(
            app,
            MenuCommand::BookShowDetails,
            "Show Details",
            Some("CmdOrCtrl+I"),
        )?,
        open: command_item(app, MenuCommand::BookOpen, "Open", Some("CmdOrCtrl+O"))?,
        edit: command_item(app, MenuCommand::BookEdit, "Edit…", Some("CmdOrCtrl+E"))?,
        mark_finished: command_item(app, MenuCommand::BookMarkFinished, "Mark as Finished", None)?,
        show_in_file_manager: command_item(
            app,
            MenuCommand::BookShowInFileManager,
            &format!("Show in {FILE_MANAGER_NAME}"),
            Some("CmdOrCtrl+Shift+R"),
        )?,
        copy_title: command_item(app, MenuCommand::BookCopyTitle, "Copy Title", None)?,
        delete: command_item(
            app,
            MenuCommand::BookDelete,
            "Delete…",
            Some("CmdOrCtrl+Backspace"),
        )?,
    };
    let book_menu = Submenu::with_items(
        app,
        "Book",
        true,
        &[
            &book.show_details,
            &book.open,
            &book.edit,
            &separator()?,
            &book.mark_finished,
            &separator()?,
            &book.show_in_file_manager,
            &book.copy_title,
            &separator()?,
            &book.delete,
        ],
    )?;

    let sidebar = command_item(
        app,
        MenuCommand::ToggleSidebar,
        "Hide Sidebar",
        Some("Ctrl+Cmd+S"),
    )?;
    let sort = MenuSortOrder::ALL
        .iter()
        .map(|order| {
            CheckMenuItem::with_id(
                app,
                order.command().menu_id(),
                order.label(),
                true,
                false,
                None::<&str>,
            )
            .map(|item| (*order, item))
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let sort_menu = Submenu::new(app, "Sort By", true)?;
    for (_, item) in &sort {
        sort_menu.append(item)?;
    }
    let unread_only = CheckMenuItem::with_id(
        app,
        MenuCommand::ToggleUnreadOnly.menu_id(),
        "Unread Only",
        true,
        false,
        None::<&str>,
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &sidebar,
            &separator()?,
            &sort_menu,
            &unread_only,
            &separator()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let go_menu = Submenu::with_items(
        app,
        "Go",
        true,
        &[
            &command_item(
                app,
                MenuCommand::GoAllBooks,
                "All Books",
                Some("CmdOrCtrl+1"),
            )?,
            &command_item(app, MenuCommand::GoAuthors, "Authors", Some("CmdOrCtrl+2"))?,
            &command_item(app, MenuCommand::GoSeries, "Series", Some("CmdOrCtrl+3"))?,
            &command_item(app, MenuCommand::GoTags, "Tags", Some("CmdOrCtrl+4"))?,
            &command_item(
                app,
                MenuCommand::GoPublishers,
                "Publishers",
                Some("CmdOrCtrl+5"),
            )?,
            &separator()?,
            &command_item(app, MenuCommand::GoBack, "Back", Some("CmdOrCtrl+["))?,
            &command_item(app, MenuCommand::GoForward, "Forward", Some("CmdOrCtrl+]"))?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &separator()?,
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
        ],
    )?;
    window_menu.set_as_windows_menu_for_nsapp()?;

    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[&MenuItem::with_id(
            app,
            MENU_ID_HELP,
            format!("{app_name} Help"),
            true,
            None::<&str>,
        )?],
    )?;
    help_menu.set_as_help_menu_for_nsapp()?;

    let menu = Menu::with_items(
        app,
        &[
            &app_menu,
            &library_menu,
            &edit_menu,
            &book_menu,
            &view_menu,
            &go_menu,
            &window_menu,
            &help_menu,
        ],
    )?;

    Ok((
        menu,
        MenuBar {
            app: app.clone(),
            app_menu,
            restart,
            edit_menu,
            native_undo,
            native_redo,
            app_undo,
            app_redo,
            switch_library,
            book,
            sidebar,
            unread_only,
            sort,
        },
    ))
}

impl<R: Runtime> MenuBar<R> {
    /// Brings the menu bar from `previous` (what it shows now; `None` right
    /// after [`build`]) to `next`.
    pub fn apply(&self, previous: Option<&MenuView>, next: &MenuView) -> tauri::Result<()> {
        let changes = menu_changes(previous, next);
        if changes.book {
            let (items, views) = (&self.book, &next.book);
            set_item(&items.show_details, &views.show_details)?;
            set_item(&items.open, &views.open)?;
            set_item(&items.edit, &views.edit)?;
            set_item(&items.mark_finished, &views.mark_finished)?;
            set_item(&items.show_in_file_manager, &views.show_in_file_manager)?;
            set_item(&items.copy_title, &views.copy_title)?;
            set_item(&items.delete, &views.delete)?;
        }
        if changes.sidebar {
            self.sidebar.set_text(next.sidebar_label)?;
        }
        if changes.libraries {
            self.rebuild_libraries(next)?;
        }
        if changes.unread_only || changes.sort_order {
            self.set_checks(next)?;
        }

        let restart_shown = previous.is_some_and(|view| view.restart_to_update);
        if next.restart_to_update != restart_shown {
            if next.restart_to_update {
                self.app_menu.insert(&self.restart, RESTART_POSITION)?;
            } else {
                self.app_menu.remove(&self.restart)?;
            }
        }

        let app_undo_shown = previous.is_some_and(|view| view.undo.is_some());
        if next.undo.is_some() != app_undo_shown {
            if next.undo.is_some() {
                self.edit_menu.remove(&self.native_undo)?;
                self.edit_menu.remove(&self.native_redo)?;
                self.edit_menu.insert(&self.app_undo, 0)?;
                self.edit_menu.insert(&self.app_redo, 1)?;
            } else {
                self.edit_menu.remove(&self.app_undo)?;
                self.edit_menu.remove(&self.app_redo)?;
                self.edit_menu.insert(&self.native_undo, 0)?;
                self.edit_menu.insert(&self.native_redo, 1)?;
            }
        }
        if changes.undo {
            if let Some(undo) = &next.undo {
                set_item(&self.app_undo, &undo.undo)?;
                set_item(&self.app_redo, &undo.redo)?;
            }
        }
        Ok(())
    }

    /// Check items flip themselves when clicked; the frontend's state, not
    /// the click, decides what they show.
    pub fn set_checks(&self, view: &MenuView) -> tauri::Result<()> {
        self.unread_only.set_checked(view.unread_only)?;
        for (order, item) in &self.sort {
            item.set_checked(*order == view.sort_order)?;
        }
        for item in self.switch_library.items()? {
            if let Some(check) = item.as_check_menuitem() {
                let active = view.libraries.iter().any(|library| {
                    library.active
                        && MenuCommand::SwitchLibrary(library.id.clone()).menu_id()
                            == check.id().as_ref()
                });
                check.set_checked(active)?;
            }
        }
        Ok(())
    }

    fn rebuild_libraries(&self, view: &MenuView) -> tauri::Result<()> {
        for item in self.switch_library.items()? {
            self.switch_library.remove(&item)?;
        }
        for library in &view.libraries {
            let item = CheckMenuItem::with_id(
                &self.app,
                MenuCommand::SwitchLibrary(library.id.clone()).menu_id(),
                &library.name,
                true,
                library.active,
                None::<&str>,
            )?;
            self.switch_library.append(&item)?;
        }
        self.switch_library.set_enabled(!view.libraries.is_empty())
    }
}
