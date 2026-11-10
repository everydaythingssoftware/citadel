# 14. In-place feedback, rare banners, few dialogs

Status: Accepted - 2026-11-10.

## Context

Citadel had one toast style, a top-right banner, used mostly for failures and
background progress. Designing "remove a library" raised the question of where
the confirmation and an Undo should live. A toast repeated what the list
already showed, at the far side of the window from the action, and a dialog
before every removal guarded a change that is easy to undo. Without a rule,
each feature would pick its own.

## Decision

Feedback has three tiers. Use the first that fits.

1. **In place (the default).** An action taken on screen confirms on screen,
   where it happened: a row changes or leaves, a checkmark moves, a field shows
   its own error, an Undo appears in the spot it undoes. If the change is
   visible, nothing else announces it.
2. **Banners (rare).** The top-right toast (`ui/toast.tsx`) is for things that
   happen out of view or in the background: an import finishing, an update
   ready, background work failing, or a failure with no surface left to show
   it on. It does not confirm something the person just did, and has no action
   buttons.
3. **Dialogs (rarer).** Only before something that can't be undone in place,
   such as removing the last library or deleting books from disk. Anything
   that can be undone skips the dialog.

### Undo in place

The pattern, first used for removing a library (`LibraryListCard`,
`useRemoveLibrary`):

- The action happens at once; there is no "are you sure".
- The item's row turns into a short "Removed “…” · Undo" placeholder in the
  same spot. The border below rises over the row while its text stays fixed,
  then the placeholder fades in.
- After 8 seconds the placeholder closes the same way. Several can be pending
  at once, each with its own timer, and each keeps its place in the list
  whatever else is removed or restored.
- Undo puts the item back exactly: same place, same state. The backend keeps
  what it needs for that (`CitadelStore::restore_library` restores the
  library's order and grants), rather than re-creating the item.
- A failed Undo says so in the placeholder, not in a banner.
- Buttons for actions that act at once have no ellipsis ("Remove"); one that
  opens a dialog does ("Remove…").
- Motion respects `prefers-reduced-motion`.

## Consequences

- New features start from "where on screen does this show?" rather than
  reaching for a toast.
- Undo needs real support from the data layer: a snapshot to restore from, not
  a second "create".
- Edit → Undo (⌘Z) should undo the same actions as the in-place Undo. It isn't
  wired up yet; when it is, the in-place Undo stays as the visible shortcut.
