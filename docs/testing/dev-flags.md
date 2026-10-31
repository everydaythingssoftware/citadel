# Developer flags

Some design choices are still open. Until each is decided, the app reads a
developer flag from the browser's local storage; set one in the console, then
reload. Unknown values fall back to the default. Storybook shows every variant
side by side (`bun run storybook`).

| Flag | Values (default first) | Where |
| --- | --- | --- |
| `citadel:placeholderCovers` | `paintings`, `patterns` | Books without a cover: Citadel's paintings or generated motif covers |
| `citadel:dropFan` | `paintings`, `motifs`, `plain` | The fan of books on the drag-and-drop overlay |
| `citadel:hourglass` | `timer`, `sand`, `ring`, `bar` | How the toolbar's review indicator shows the time left |
| `citadel:addedMotion` | `deal`, `shelve`, `lift` | How a reviewed book leaves the card when added |

```js
localStorage.setItem("citadel:placeholderCovers", "patterns");
```

The flags live in `src/lib/dev-flags.ts`; remove a flag (and its losing
variants) once the choice is made.
