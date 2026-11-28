# Design

Citadel's visual system. Tokens live in `src/styles.css` (`--ctd-*`, light +
dark via `data-theme` on `<html>`, set by `src/lib/theme-manager.ts`).

## Guiding principle

**"Mostly Mac", or "more Mac than Mac"; never a literal copy of the HIG.**
The HIG isn't enough on its own: decisions need taste, and Citadel is shared
across platforms. 90% Mac is good, 110% Mac is good; 100% is an odd middle
ground. Citadel keeps its own character everywhere: the monochrome ink
palette, the dim on finished books, hold-to-confirm, and its covers.

- **macOS** (desktop app *and* browser): native-leaning components.
- **Windows, Linux, other browsers**: clean, generic versions of the same UI,
  with Citadel's own icon pack.

Reference lineage: Things, Bear, NetNewsWire, Apple Books. Anti-reference:
Calibre's cluttered chrome, generic web-app SaaS.

## Platform-adaptive components

- `src/main.tsx` sets, before first render, `data-platform` on `<html>`
  (`macos`, `windows`, `linux`, `ios`, `android`, `other`, from
  `src/lib/platform/os.ts`) and `data-runtime` (`desktop` | `web`). Components
  read the OS with `usePlatform().os`; CSS adapts with
  `:root[data-platform="macos"] …`. `data-vibrancy` marks the macOS desktop
  window only.
- Prefer tokens that change per platform over per-component branches. Menus
  are the first example: `--ctd-menu-*` gives `ContextMenu` and `Select`'s
  list NSMenu's glass and ink highlight on macOS, and an opaque panel with a
  grey highlight elsewhere.
- A platform feature that may be missing is `Option`-typed
  (`platform.menu`, `fileOpener.quickLook`, `window.startDrag`;
  `src/lib/option.ts`): code acts on it when it is there, never through a
  `canX` flag beside a no-op. Hook results that may be absent are `Option`
  too.

## Color

- Monochrome marble: carved white marble and charcoal ink, drawn from the app
  icon. Stones (`--pal-*`) per theme; every `--ctd-*` token derives from them
  with OKLCH relative colour syntax (see the comment at the top of
  `styles.css`).
- `--ctd-accent` is ink (near-black in light, marble-white in dark), used for
  the default button, current selection, menu highlights and the focus ring.
  Never decoration. The system accent colour is never used.
- A few state colours, each only for its state, never chrome: link blue
  (`--ctd-text-link`) for links in prose; red for danger (`--ctd-danger-ink`
  for words, `--ctd-danger-bg` for the rare fill); brass (`--ctd-brass`) for
  time and drop targets; green (`--ctd-success`) for a finished book.
- The one deliberate exception: file-format badges are coloured.
- Layering: `--ctd-bg` (window) → `--ctd-surface*` (content) → controls.
  Sidebar/toolbar share `--ctd-nav-bg`/`--ctd-header-bg` with hairline
  `--ctd-border` separators. No gradients in chrome.
- Book-cover faces (`BookCover.tsx` placeholder art) are content: the serif
  type and spine-shading gradients there are intentional and stay.

## Typography

- System stack everywhere (`--ctd-font-ui`). Headings same family at 600.
  Book titles may use `--ctd-font-serif`; chrome never does.
- The root size is `87.5%` of the reader's default (14px at the usual
  16px), so a larger browser or system text setting scales the whole UI.
  `1rem` is that root, not 16px.
- **Text styles**: font sizes are Apple's text styles, by role, as
  `--ctd-text-*` in `src/styles.css`. Each has a macOS size and an iOS
  size, and the token is the iOS one where the pointer is a finger and the
  macOS one everywhere else:

  | Token | macOS | iOS | For |
  |---|---|---|---|
  | `large-title` | 26 | 34 | a book title, a display line or number |
  | `title-1` | 22 | 28 | a book title where room is short |
  | `title-2` | 17 | 22 | a page or sheet heading |
  | `title-3` | 15 | 20 | a small heading |
  | `headline` | 13 | 17 | body's size, with a bold weight |
  | `body` | 13 | 17 | controls, menus, rows, running text |
  | `callout` | 12 | 16 | secondary lines, small controls |
  | `subheadline` | 11 | 15 | pills, tags, sidebar section headings |
  | `footnote` | 10 | 13 | |
  | `caption-1` | 10 | 12 | |
  | `caption-2` | 10 | 11 | |

  Text that sets no size is `body`. CSS picks a style and never a raw px
  or rem size, and never sets a second size for touch: the token already
  changes with the device. An icon is sized by its width and height, not
  by a font size. A drawing that must not change with the device (a
  generated cover) uses the fixed `--ctd-type-mac-*` or `--ctd-type-ios-*`.
- **Line heights and weights** are Apple's for the same styles.
  `--ctd-leading-*` is each style's line height over its size (body is
  16/13 on macOS and 22/17 on iOS); the root's is body's, and a rule that
  sets a line height uses its style's token. A line height of `1` or in
  px sizes a glyph or a control and stays as it is. Emphasized text is
  600, and 700 in `large-title`, `title-1` and `title-2`.
- **No ALL CAPS anywhere**: no `text-transform: uppercase`, no small caps, no
  wide-tracked eyebrow labels. Text is written the way it shows ("Current"
  in a pill, not "current" uppercased by CSS). Acronyms (ISBN, EPUB) stay as
  they are; identifier sources get display names ("Open Library", not
  "OPENLIBRARY", `identifierDisplayName` in `src/lib/book-identifiers.ts`).
- **Sentence case** for titles, headings, buttons, labels and tooltips
  ("Create a new library?", "Save as shelf", "Try again", "Unread only").
  Proper names keep their capitals ("Open Library").
- **Title case** for menu items, in context menus and the menu bar ("Show
  Details", "Mark as Finished", "Delete 2 Books…"), and for the few buttons
  that already had it ("Add Book…").
- A menu item or button that opens a dialog ends in "…".

## Controls

- One height for every regular control, `--ctd-control-height`: **24px** on
  desktop-sized screens (web and desktop app), 36px on touch screens
  (`pointer: coarse`). Fields, pop-ups, segmented controls, buttons, icon
  buttons and the search field all line up on one row.
- Buttons: `primary` (filled ink) only for the default button of a form,
  sheet or dialog, the one Return presses; `default` (bordered) for
  everything else; `danger` is bordered with red text and is never the
  default.
- No icon-only buttons unless their meaning is truly obvious; icons must say
  what they do.
- Hold-to-confirm buttons stay for actions that would otherwise need a
  dialog mid-flow.
- Focus ring: monochrome ink (`--ctd-focus-ring`, with `--ctd-focus-border`
  on focused fields).

## Sheets and alerts

Follow `docs/adr/0014-in-place-feedback.md` for when to ask at all.

- `AlertDialog` is an NSAlert: a title that names the action ("Delete
  “Middlemarch”?", "Forget “Fiction”?"), a line saying what is and isn't
  affected, and two buttons with the default on the right. Return presses
  the default button wherever focus is; Escape cancels.
- In destructive alerts Cancel is the default (filled) and the destructive
  button is red text. In other alerts the confirm button is the default.
- No "Are you sure…" copy.
- `Sheet` is modal like a native sheet: a click outside does nothing;
  Escape, Cancel or Done close it. Titles in sentence case.

## Chrome behaves like an app, not a page

- `user-select: none` on the root. Fields, editable text and real content
  opt back in with `.ctd-selectable` / `data-selectable` (book descriptions,
  metadata values, error messages: anything a person would copy).
- ⌘A never selects chrome: it selects all in a field, the block of
  selectable content holding the selection, or whatever the app binds.
- Links and images don't drag out as web content (`-webkit-user-drag:
  none`); something meant to drag says `draggable="true"`.
- The browser's own context menu (Reload, Save Image As…) is blocked except
  in text fields and over selected content (`src/lib/chrome-guards.ts`).
  Right-click menus are `ContextMenu` + `useContextMenu`.
- Cursors follow AppKit: the arrow everywhere, buttons and links included;
  the I-beam in text.

## Selection and books

- **Clicks, everywhere (desktop app and browser):** a click or tap selects
  the book and shows its details (with the drawer open, it switches to that
  book); ⌘-click (Ctrl-click off macOS) toggles a book in the selection and
  ⇧-click extends it, both without the drawer; a double-click opens the
  book's preferred file (`src/lib/book-files.ts`) in its default app on the
  desktop, or downloads it in the browser. A triple-click still opens once,
  and the drawer the first click opened stays put (`bookClickIntent`).
- **Keys:** arrows move the selection, and an open drawer follows it; Return
  shows the details; ⌘O (Open) opens the file; ⌘A selects all, fetching
  pages it hasn't loaded when an action runs. Space is Quick Look on macOS
  (the system Quick Look panel; Space again closes it). Escape closes the
  details on the first press wherever focus is, unless a menu, pop-up,
  sheet or alert is on top or the search field has text to clear; the next
  Escape clears the selection. One press never does both.
- **Scope bar:** the search field fills what sort, Unread only and Save as
  shelf… leave it, never under 150 px. The bar reflows on its own width (a
  container query, since the sidebar and the window both move it): first
  Save as shelf… folds to its bookmark (tooltip and accessible name stay),
  then the search field takes its own row above the rest.
- **Panel widths:** the sidebar and the details drawer resize from their
  edge the same way (double-click resets; arrow keys, Home and End on the
  edge), each within its limits and a share of the space it sits in,
  through one store (`createPanelWidthStore`, `src/stores/panel-width.ts`). A saved
  width outside the limits is clamped on load.
- Dragging covers out copies their files on the desktop
  (`platform.window.startDrag`); drops that arrive while that drag is in
  flight are ignored (`src/lib/drag-out-guard.ts`), so dropping books back
  doesn't import copies. In the browser a dragged cover downloads its file
  where the browser reads `DownloadURL` (Chromium).
- The action that opens a book's file is **Open** ("Open 15 Books"), in the
  right-click menu, the Book menu and the drawer.
- Bulk actions are Mark as Finished and Delete; one confirmation for delete
  (ADR 0014). The status bar says "2 of 14 selected".
- **Details drawer:** one non-modal panel (`Drawer`) over the right of the
  content panel, under the toolbar, with no scrim: toolbar, sidebar, search
  and the covers beside it stay live, and app-wide shortcuts keep working.
  A click on another cover switches the book; Escape (see Keys), its close
  button or a click on empty grid closes it. The hero (cover, title, byline,
  Open and Edit) stays pinned while the body scrolls. Phones get a
  full-screen sheet that swipes closed from its inner edge. Grouped rounded
  sections ("Files", "Details"), label left, value right; file rows show
  what the platform can do with the file (open, show in the file manager,
  download).

## Menu bar and shortcuts

- macOS desktop has the full menu bar (Citadel · Library · Edit · Book ·
  View · Go · Window · Help, `src-tauri/src/menu/`). Each command's key
  equivalent is defined once there (`MENU_ACCELERATORS`, exported into
  `src/bindings.ts`). The library window pushes the menu state in groups
  (`MenuStateUpdate`: selection, view, libraries, undo, select all, update
  notice), each when it changes (`useMenuBarSync`), and runs the menu's
  commands through `useMenuCommands`. There the menu bar handles its own
  chords and the page doesn't bind them again.
- Elsewhere the page binds the same chords (`src/lib/app-shortcuts.ts`, which
  reads the Rust table and adds only what Rust doesn't know). Windows and
  Linux desktop bind them all except Hide Sidebar. A browser keeps its own
  chords (Ctrl/⌘+1…5, O, E, N, ⇧R, ","), so there only Undo, Redo, Find,
  Show Details and Delete are bound. Menus show a chord only where it works,
  as "⌘I" on macOS and "Ctrl+I" elsewhere. Keys that belong to one page
  (arrows, Return, Space and ⌘A in the grid, ⌘S in the book editor) live in
  that page's keymap.
- Each platform gets its own conventions, not the Mac's spelled with Ctrl.
  `mod` is ⌘ alone on macOS (and iPad) and Ctrl alone elsewhere
  (`setChordPlatform` in `src/lib/keymap.ts`). Windows and Linux add their
  own chords: Redo is also Ctrl+Y; Back and Forward are Alt+← / Alt+→ in the
  app; Show Details is also Alt+Enter in the app; Delete deletes. Menus show
  only the primary chord.
- **Undo** works like NSUndoManager: one history for the library window
  (`src/lib/undo-history.ts`, `src/stores/undo/store.ts`). Edit > Undo and
  Redo name the top entry ("Undo Mark as Finished") and are disabled when
  there is none; the keys do the same and are left to the browser when there
  is nothing to undo. A focused text field keeps its own typing undo, and
  the menu shows the native items.
- Edit > Select All selects every book on the Books page, unless the focus
  is in a text field, a sheet, an alert or a menu. Focus in the details
  counts as the Books page. Once text there is being selected (a
  description), Select All selects all of that text instead, as in a
  read-only text view. In those places and on the other pages, the menu
  shows the native item. ⌘A/Ctrl+A stays the grid's own key on every
  platform (`PAGE_OWNED` in `src/lib/app-shortcuts.ts`), because the chrome
  guard and the grid keymap decide what it selects.
- Every action that changes the library either registers an undo entry or,
  if it can't be undone, clears the history, so Undo never reaches back
  across it. A new action picks a side deliberately.
- The book editor saves with ⌘S/Ctrl+S everywhere. While it is open, Undo
  outside text fields is its own ("Undo Edit"), with no Redo.
- While a field or a sheet has the keyboard, the Book menu stands down, so
  ⌘⌫ deletes text, not books.

## Software update notice

- Desktop: once an update has downloaded, the sidebar footer (where the gear
  was) shows a quiet row, "Citadel 1.4 is ready" / "Restart to update"; a
  click restarts at once, right-click offers "Hide Until Next Update". On
  macOS Citadel > Restart to Update… appears too. No badge, notification or
  automatic restart; an ignored update installs at quit.
- Web: when the server's version changes under an open page, one toast,
  "Citadel was updated", with a Reload button. It stays until dismissed.
- The Settings gear is hidden on macOS desktop (⌘, and the app menu open
  Settings); it stays on the web and on Windows/Linux.

## Scrollbars

Overlay scrollbars that show only while scrolling and never shift content.
On macOS and mobile the system draws them (Citadel adds no
`::-webkit-scrollbar` styling, so macOS's "Show scroll bars" setting is
respected). Elsewhere a thin scrollbar's thumb stays transparent until the
scroller is hovered or scrolling (`data-scrolling`, from
`src/lib/overlay-scrollbars.ts`); scrollers that can grow into overflow add
`.ctd-scroller` to reserve the thin gutter up front.

## Materials (Liquid Glass)

- On macOS the webview is transparent over an `NSVisualEffectView` with the
  popover material (`apply_glass` in `src-tauri/src/window.rs`), so the
  desktop's colour reads through the toolbar and sidebar. The material
  follows the window's active state; while the window is in the background
  the chrome steps down with it (`data-window-inactive`,
  `--ctd-chrome-ink`/`--ctd-chrome-ink-soft`, still ≥ 3:1) and adds no tint
  of its own. Content (covers, titles, the details panel, the status bar)
  keeps its ink.
- `:root[data-vibrancy]` (macOS desktop only) swaps `--ctd-nav-bg`/
  `--ctd-header-bg` to transparent and the page background to transparent.
  Elsewhere the opaque fallbacks apply; never assume transparency exists.
- The native window appearance follows the app theme via `setTheme`
  (`useNativeThemeSync`), so forced-dark Citadel gets dark glass.
- Content floats: pages render inside one opaque panel (`--ctd-content-bg`,
  `--ctd-radius-panel`, hairline border, soft shadow) mounted in
  `__root.tsx`. The panel is the scroll container.
- Glass is structural: the chrome region and transient menus. No other
  blurred or translucent layers inside content.

## Layout

- Inside the content panel: chrome-free lists and grids separated by 1px
  `--ctd-border` hairlines; 20–24px insets at panel edges. Page headers are
  compact control rows, not hero titles.
- The cover grid is a centred block of fixed-width covers whose column
  count comes from the window as if the sidebar were open, so a sidebar
  toggle only slides the block. A resize keeps the top row's first book in
  place (`src/lib/grid-virtual.ts`). Covers sit on their row's bottom edge
  like books on a shelf.
- Shadows are reserved for overlays (menus, modals, drawers) and book
  covers.

## Motion

- 120–200ms, ease-out, for state changes. `prefers-reduced-motion` is
  honoured globally in `styles.css`.
- Menus appear at once, as on macOS, and fade quickly on dismiss.
- Hover feedback is a background tint on rows and controls. The one hover
  motion is on covers you can open: they lift 2px; display-only covers
  (details drawer, edit page) stay still. The lift moves the art inside the
  hit target, never the target itself, so the cover can't flicker under a
  resting pointer.

## Accessibility

- WCAG AA: `--ctd-ink-soft` is tuned to stay ≥4.5:1 on `--ctd-bg`; keep it
  that way when adjusting. UI components ≥3:1 against adjacent colours.
- Don't communicate state by colour alone (read/unread also uses position or
  iconography; destructive menu items also say so in their words).
