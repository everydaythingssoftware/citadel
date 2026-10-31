# Developer flags

Some design choices are still open. Until each is decided, the app reads a
developer flag from the browser's local storage; set one in the console, then
reload. On a device without a console (an iPhone), put it in the address
instead, without the `citadel:` prefix, e.g.
`http://192.168.1.20:8081/?touchCovers=physics&viewportDebug=on`; it's
remembered until set again the same way. Unknown values fall back to the
default. Storybook shows every variant
side by side (`bun run storybook`).

| Flag | Values (default first) | Where |
| --- | --- | --- |
| `citadel:placeholderCovers` | `paintings`, `patterns` | Books without a cover: Citadel's paintings or generated motif covers |
| `citadel:dropFan` | `paintings`, `motifs`, `plain` | The fan of books on the drag-and-drop overlay |
| `citadel:reviewIndicator` | `arrival`, `download` | The toolbar's icon for new books waiting for review |
| `citadel:addedMotion` | `deal`, `shelve`, `lift` | How a reviewed book leaves the card when added |
| `citadel:viewportDebug` | `off`, `on` | Shows the visible viewport, keyboard and focus as the app sees them (for phone layout bugs) |
| `citadel:touchCovers` | `native`, `physics` | How the upload review's covers move on touch screens: native scrolling, or the momentum and settling used with a mouse or trackpad |

```js
localStorage.setItem("citadel:placeholderCovers", "patterns");
```

The flags live in `src/lib/dev-flags.ts`; remove a flag (and its losing
variants) once the choice is made.
