# Design

Citadel's visual system. Tokens live in `src/styles.css` (`--ctd-*`, light +
dark via `data-theme` on `<html>`, set by `src/lib/theme-manager.ts`).

## Direction

Native macOS materials. The chrome is neutral and recedes; book covers are the
only saturated decoration. Reference lineage: Things, Bear, NetNewsWire, Apple
Books. Anti-reference: Calibre's cluttered chrome, generic web-app SaaS.

## Color

- All chrome colors in OKLCH, near-neutral, never pure black/white.
  - Light: warm-paper whisper, hue 80, chroma 0.001–0.008.
  - Dark: cool graphite, hue 260, chroma 0.003–0.005.
- Strategy: Restrained. One accent — macOS-blue `--ctd-accent`
  (oklch 58%/0.17/255 light, 66%/0.15/255 dark) — used only for primary
  actions, current selection, links, and state. Never decoration.
- Danger is macOS-red territory (hue 27).
- Layering: `--ctd-bg` (window) → `--ctd-surface*` (content) → controls.
  Sidebar/toolbar use `--ctd-nav-bg`/`--ctd-header-bg` with hairline
  `--ctd-border` separators. No gradients in chrome.
- Book-cover faces (`BookCover.tsx` placeholder art) are content: the serif
  type and spine-shading gradients there are intentional and stay.

## Typography

- System stack everywhere: `-apple-system, BlinkMacSystemFont, "SF Pro Text"…`.
  Headings same family at 600. No display/serif fonts in UI chrome.
- Root size 14px (desktop density). Sidebar section headers: 12px, 600,
  uppercase, 0.05em tracking, `--ctd-ink-soft`.
- Page titles are modest (`h3`-level, ~16px), toolbar-scale, not hero-scale.

## Materials (Liquid Glass)

- On macOS the webview is transparent over an `NSVisualEffectView` (Tauri
  `set_effects` with `Effect::Popover` + `EffectState::FollowsWindowActiveState`,
  applied in `src-tauri/src/main.rs`). The toolbar + sidebar L-region is real
  glass: desktop color shows through.
- `:root[data-vibrancy]` (set in `src/main.tsx` on macOS only) swaps
  `--ctd-nav-bg`/`--ctd-header-bg` to faint tints (alpha 0.2–0.3) and the
  page background to transparent. Elsewhere the opaque fallbacks apply —
  never assume transparency exists.
- The native window appearance is kept in sync with the app theme via
  `setTheme` (`useNativeThemeSync` in `src/routes/__root.tsx`), so forced
  dark Citadel gets dark glass on a light desktop. Requires the
  `core:window:allow-set-theme` capability.
- Content floats: pages render inside one opaque panel
  (`--ctd-content-bg`, `--ctd-radius-panel`, hairline border, soft shadow)
  mounted in `__root.tsx`. The panel is the scroll container; sticky
  status bars pin to its bottom edge.
- Glass is structural, not decorative: exactly one vibrancy region (the
  chrome), exactly one floating panel. No additional blurred/translucent
  layers inside content.

## Layout

- Inside the content panel: chrome-free lists and grids separated by 1px
  `--ctd-border` hairlines; 20–24px insets at panel edges (the cover grid
  uses `20px 24px 24px`). Page headers are compact control rows, not hero
  titles.
- Buttons: filled accent only for the primary action of a form/dialog;
  `variant="default"` (neutral bordered) for everything else. Buttons that
  open a dialog end with an ellipsis ("Add Book…").
- Shadows are reserved for overlays (menus, modals, drawers) and book covers.

## Motion

- 140–200ms, ease-out, state changes only. `prefers-reduced-motion` is
  honored globally in styles.css. No hover lifts or decorative transitions.

## Accessibility

- WCAG AA: `--ctd-ink-soft` is tuned to stay ≥4.5:1 on `--ctd-bg`; keep it
  that way when adjusting. UI components ≥3:1 against adjacent colors.
- Don't communicate state by color alone (read/unread also uses position or
  iconography).
