# List-page regression tools

These development-only tools share deterministic fixtures and page adapters,
rather than maintaining a separate driver and preview for every feature.
They currently support Series and Authors. Production code imports none of them.

## Live application checks

Start one Citadel Dev instance with `bun run dev`, open a library, and use the
port printed in `[webdriver] listening on port <N>`:

```sh
bun run test:lists --port <N> --scenario series
bun run test:lists --port <N> --scenario series --count 12
bun run test:lists --port <N> --scenario authors --count 12 --allow-layout-warnings
```

The default fixture has 100,000 rows. The runner installs it in the frontend
store, navigates the real application route, checks the page, and restores the
original data, layout and route in a `finally` block. Author update/delete actions
are blocked while its fixture is installed. No database or settings files are
edited. Use an idle app and do not interact with it during a run.

The same checks run for each scenario:

- Full dataset scroll height and a viewport-dependent bound on mounted rows.
- Correct names, counts and route targets, including the final item.
- Contiguous rows, aligned count columns and visible content.
- Sticky header/footer geometry where those elements are present.
- Case-insensitive filtering from the bottom to one, ten and zero matches,
  followed by clearing search; exact matching content and footer totals.
- A narrower, shorter scroll region, and navigating the final item's link.

Snapshots and JSON evidence are saved under `/tmp/citadel-list-check/<scenario>`
unless `--output` is supplied. `--baseline` captures the initial layout without
regression assertions. `--allow-layout-warnings` explicitly records sticky-layout
failures instead of failing on them; content, filtering, scroll extent and
bounded-rendering checks remain strict. Default runs fail on layout problems.

**Do not edit frontend/configuration files while a check is running.** Vite HMR
can race the installed WebDriver plugin's pending-script callbacks, panic with
`no pending script with that id`, and poison its shared lock. When requests start
returning empty replies, restart Citadel Dev and use its newly printed port.
Cleanup errors are reported without hiding the original test failure. Fixtures
are in memory, so restarting the app removes them even if cleanup cannot run.

## Browser preview

With Vite running, open:

```text
http://localhost:1420/tools/testing/preview.html?scenario=series
http://localhost:1420/tools/testing/preview.html?scenario=authors&count=12
```

The preview imports the actual page components and shared shell CSS, with the
same fixtures as the live runner. Its surrounding navigation is a mock and its
book-link destination displays the query. It uses no library connection.

Use `count=0` for empty libraries, `count=120` for small fixtures, and `long=1`
for a very long final name. Focus “List viewport” and press End to inspect final
rows. Check searching, clearing, keyboard links, truncation and responsive widths.
The preview is covered by TypeScript, formatting and frontend lint checks.

The installed WebDriver plugin 0.1.3 reconstructs PNGs from serialized HTML in an
SVG foreignObject. This loses scroll positions, so deep-scroll captures can
look blank despite correct DOM geometry. Use its images only at scroll position
zero, and use genuine browser screenshots for deep-scroll visual verification.
For baseline comparisons, keep count, viewport, theme and screenshot backend
identical; tolerate caret/subpixel rasterization differences. Geometry and
content assertions remain necessary alongside image comparisons.

## Adding another list page

1. Register an adapter in `src/test/list-scenarios.ts`: route, search/row/column
   selectors, footer behavior, row-height/overscan metadata and navigation key.
2. Supply a deterministic `createItem(index, longName)` function and an
   `install(count, longName)` function returning a restore callback. Fixtures
   use sequential IDs starting at one and ascending padded names; the runner
   checks names/counts against this factory and understands JSON-encoded router
   IDs. Block any mutation actions exposed by the new page while testing it.
3. Add the actual page component to the browser preview's `pages` registry.
4. Run the existing command with `--scenario <name>`; no new runner, transport,
   snapshot script, scrolling logic or preview shell is needed.

`tools/testing/driver.py` is reusable for other debug-app checks. The two small
JS scripts implement shared fixture setup and DOM snapshots. Page-specific
behavior belongs in the adapters, not the transport or shared checks.

## Verified results and existing defects

Series passed the shared 100,000-row regression: 30/42/31 mounted rows at the
top/middle/end, with full scroll extent, filtering, resizing and navigation.
The original browser checks also covered long-name truncation, keyboard links
and empty states. A 120-row top comparison differed in only 52 pixels with no
visible row/column displacement.

Authors passes the small-fixture content/filter/navigation checks when existing
sticky-footer issues are explicitly reported as warnings. Its 100,000-row run
fails: the page reports approximately 1,275px of scrollable height rather than
reserving the full list height, and the final author is unreachable by jumping
to the bottom. This is an existing page-layout problem exposed by the second
adapter, not a regression from changing the runner. The harness keeps that
failure visible; repairing Authors is separate work.

## Automation backlog

- Repair Authors' virtual-list scroll extent and sticky footer; keep its large
  scenario as a regression check when fixed.
- Provide genuine native screenshots and protect pending-script callbacks from
  HMR/disconnect races in the debug WebDriver plugin.
- Add one command to launch an isolated Dev app, discover its port, run checks
  and stop it without competing instances or changes to user settings.
- Run the shared scenarios and genuine screenshot comparisons in CI, with
  artifact collection and tolerance for rasterization differences.
- Configure task-ledger endpoint, authentication and session identity explicitly;
  detect login redirects and preserve findings for later delivery.
- Clean up existing frontend/Rust lint warnings so new ones stand out.
