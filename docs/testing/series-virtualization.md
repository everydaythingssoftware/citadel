# Series virtualization regression

Issue: https://github.com/everydaythingssoftware/citadel/issues/170

## Repeatable live test

Start `bun run dev` in the main workspace and wait for `[webdriver] listening on
port <N>`. Open a library first. Run exactly one app instance; do not launch
`tauri-wd` alongside it.

```sh
python3 tools/check-series-virtualization.py --port <N>
python3 tools/check-series-virtualization.py --port <N> --count 120 --output /tmp/citadel-series-small
```

The default fixture has **100,000 series** with deterministic names, IDs and
varying book counts. It temporarily replaces the frontend store's series list,
uses the real Series route, and restores the original list and layout in a
`finally` block. It does not create or edit a Calibre database or app settings.
This isolates the rendering bottleneck; it is not a database-throughput test.
Use an idle debug app and avoid interacting with it during the run.

The runner asserts:

- Mounted row count bounded by viewport height / 40px plus overscan, independent of list size (30–42 rows in the tested desktop viewport).
- Correct names, counts and navigation targets, including the final row.
- Contiguous row bounds and aligned book-count columns.
- Visible rows at the top, middle and end, with sticky header/footer bounds.
- Filtering from the bottom to one match, ten matches, zero matches, then clearing.
- Correct filtered footer totals and no stale counts or links.
- A 420px-wide, 480px-high scroll region and its final row.
- Following the final series link produces the expected route query.

Each stage writes a PNG screenshot and geometry/content evidence to
`/tmp/citadel-series-check/results.json`. Native scroll delivery is asynchronous;
wait for visible content rather than assuming a short sleep has finished scrolling.
A failed assertion still restores the original store and container style.

## Visual comparisons

Before changing the renderer, capture a manageable fixture:

```sh
python3 tools/check-series-virtualization.py --port <N> --count 120 --baseline --output /tmp/citadel-series-before
```

After changing it, run the same count with `--output /tmp/citadel-series-after`
and compare `top.png`. Keep the app window size, theme and screenshot backend
identical. The test also captures middle/end, filtering and narrow layouts for
visual inspection. The installed WebDriver plugin 0.1.3 serializes HTML into an SVG foreignObject;
it does **not** take a native WKWebView snapshot. Serialization loses scroll
positions, so its middle/end screenshots can misleadingly show blank rows and
the unscrolled header. Use those images only at scroll position zero.
Geometry assertions establish scrolling/filtering behavior; use the browser
preview below for visual checks at deep scroll positions.

## Browser visual preview

With Vite running, open `http://localhost:1420/tools/series-preview.html`.
This development-only HTML entry renders the **actual Series component** and
shared shell CSS, with 100,000 in-memory series and no Tauri/backend access.
It is not included in the production application build.

- Use `?count=120` for a small fixture or `?count=0` for an empty list.
- Use `?long=1` to give the final series a very long name.
- Focus the “Series viewport” region and press End; wait for Series 099999.
  Inspect the final rows and sticky header/footer in a real browser screenshot.
- Search for `SERIES 099999`, then a nonexistent name, then clear search.
- Test a narrow viewport; the shared shell hides the sidebar at its breakpoint.
  The long final name should ellipsize and retain a 40px row height.
- Focus the final row link and press Enter; the preview displays its series query.

The preview has mock surrounding navigation, but Series itself is imported
without duplication. The live-app runner verifies the real application route
and container; this preview provides genuine scrolled screenshots and keyboard
interaction without touching any library. A native Dev screenshot path remains
useful future work for macOS-specific fidelity.

## Automation backlog / setup friction

- Add one command that starts an isolated debug app, discovers the dynamic
  WebDriver port, runs page checks and shuts down the app. It should refuse to
  start a competing instance and avoid changing a user's library/settings.
- Generalize the Series runner into a reusable Authors/Series list regression
  harness, with stable fixtures and screenshot artifact collection in CI.
- Automate baseline image comparison with configurable tolerance for the search
  caret and subpixel rasterization; retain geometry assertions as the primary
  layout checks. A 120-row top comparison on 2026-10-09 differed in 52 of 883,418
  pixels, with no visible row/column displacement.
- Configure remote task-ledger endpoint, session identity, and CLI authentication
  explicitly. Detect login redirects rather than reporting a JSON parse error;
  preserve unsent findings locally when the service is unavailable.
- Existing `bun lint` output includes three frontend warnings (reduced-motion
  `!important` and two unused autofocus suppressions) and Rust Clippy warnings.
  Track cleanup separately so new warnings are easier to identify.

## Implementation notes

Series uses the existing TanStack virtualizer dependency and shared application
scroll container. Rows are measured, with a 40px estimate and ten overscan rows.
Series IDs key virtualizer measurements across filtering. Search/list changes
reset scroll position so a short result cannot retain a deep-list offset.

The Series page uses `min-height: 100%`, and the rows/header/footer do not shrink.
The old fixed `height: 100%` allowed rows to overflow their page containing block,
which prevented the sticky header from remaining pinned during deep scrolling.

## Verified on 2026-10-09

- Live debug app: 100,000 series; top/middle/end mounted 30/42/31 rows;
  filtering, clearing, narrow layout and the final link passed.
- Browser preview: deep-scroll rows visible, sticky header/footer aligned,
  long-name ellipsis with 40px rows, keyboard link navigation, no-match search,
  clearing and a fully empty fixture passed.
- `bun format`, `bun run typecheck`, `bun lint`, and all 250 existing frontend
  tests passed. Lint has the pre-existing warnings described above.

The tests deliberately enforce bounded rendering and correct content rather
than a machine-dependent opening-time threshold. They do not benchmark query
speed, guarantee a particular frame rate during animated jumps, or establish
native macOS appearance.
