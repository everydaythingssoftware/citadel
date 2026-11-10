# 14. In-place feedback, rare banners, few dialogs

Status: Accepted - 2026-11-10.

## Context

Citadel had one toast style, a top-right banner, used mostly for failures and
background progress. Designing how to take a library out of Citadel raised
where confirmation, reassurance and any Undo should live. We tried a toast
(it repeated what the list already showed, far from the action), Undo with no
dialog (nothing told people their books were safe, so nobody would risk the
button), and a dialog plus Undo (redundant). Without a rule, each feature
would pick its own.

## Decision

Feedback has three tiers. Use the first that fits.

1. **In place (the default).** An action taken on screen confirms on screen,
   where it happened: a row changes or leaves, a checkmark moves, a field shows
   its own error. If the change is visible, nothing else announces it.
2. **Banners (rare).** The top-right toast (`ui/toast.tsx`) is for things that
   happen out of view or in the background: an import finishing, an update
   ready, background work failing, or a failure with no surface left to show
   it on. It does not confirm something the person just did, and has no action
   buttons.
3. **Dialogs (rare, for rare actions).** See below.

### Confirmation or Undo

- **Frequent, low-stakes actions act at once and offer Undo in place.** A
  dialog every time would be friction.
- **Rare, deliberate actions get one confirmation and no Undo**, the way the
  system's "Forget This Network…" does. The dialog costs little because the
  action is rare, and it is the right moment to say what happens.
- Either way, **say what is and isn't affected before people act**, when they
  might fear losing data. The best place is the action's own name; a dialog's
  text is next. Hint text beside a button is a patch for a label that isn't
  doing its job.
- A button that opens a dialog ends in "…"; one that acts at once doesn't.
- Motion respects `prefers-reduced-motion`.

### Example: forgetting a library

- The action is **Forget…**, on the library's row menu and as the last row of
  the Current Library card. "Forget" is the system's word for "stop
  remembering this; nothing is deleted", so the label reassures before the
  click.
- One dialog: "Forget “…”? Citadel will stop showing this library. Your books
  stay where they are." Forgetting the only library adds that Citadel returns
  to the welcome screen.
- Then the row wipes away in place: the border below rises over it while its
  text stays fixed. No banner, no Undo.

## Consequences

- New features start from "where on screen does this show?" rather than
  reaching for a toast.
- Choosing Undo means real support from the data layer (a snapshot to restore
  from, not a second "create"), so it is reserved for actions frequent enough
  to need it.
