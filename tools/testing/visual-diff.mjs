#!/usr/bin/env node
/**
 * Visual diff report: pairs screenshots by file name across two folders and
 * writes a page that shows each as a triptych (before, after, difference).
 * The difference is computed in the browser, so the tool has no dependencies.
 *
 *   bun tools/testing/visual-diff.mjs <before-dir> <after-dir> <out-dir> [--fragment]
 *
 * Serve <out-dir> over HTTP and open index.html, e.g.
 *   bunx serve <out-dir>   or   python3 -m http.server -d <out-dir>
 * (browsers refuse to read pixels from file:// pages, so the difference
 * column needs a server). --fragment leaves out the <!doctype>/<html>
 * wrapper, for hosts (such as Claude artifacts) that add their own.
 */
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/* The page. Diffs are drawn on canvas once each image pair has loaded. */
const TEMPLATE = String.raw`<title>Citadel Visual Diff</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
/* Layout: a sticky filter bar over a list of before · after · diff triptychs, worst change first. */
:root {
	--bg: oklch(95.5% 0.004 90);
	--panel: oklch(97.5% 0.003 90);
	--ink: oklch(21% 0.004 270);
	--ink-soft: oklch(45% 0.005 270);
	--line: oklch(21% 0.004 270 / 0.16);
	--accent: oklch(25% 0.005 270);
	--accent-ink: oklch(97.5% 0.003 90);
	--changed: oklch(62% 0.25 340);
	--added: oklch(55% 0.14 150);
	--font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
	--font-data: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
	:root:not([data-theme="light"]) {
		--bg: oklch(18.5% 0.004 270);
		--panel: oklch(21% 0.004 270);
		--ink: oklch(94% 0.003 90);
		--ink-soft: oklch(70% 0.004 90);
		--line: oklch(94% 0.003 90 / 0.12);
		--accent: oklch(94% 0.003 90);
		--accent-ink: oklch(20% 0.004 270);
		--changed: oklch(70% 0.22 340);
		--added: oklch(72% 0.14 150);
		color-scheme: dark;
	}
}
:root[data-theme="dark"] {
	--bg: oklch(18.5% 0.004 270);
	--panel: oklch(21% 0.004 270);
	--ink: oklch(94% 0.003 90);
	--ink-soft: oklch(70% 0.004 90);
	--line: oklch(94% 0.003 90 / 0.12);
	--accent: oklch(94% 0.003 90);
	--accent-ink: oklch(20% 0.004 270);
	--changed: oklch(70% 0.22 340);
	--added: oklch(72% 0.14 150);
	color-scheme: dark;
}
* { box-sizing: border-box; }
body {
	margin: 0;
	background: var(--bg);
	color: var(--ink);
	font: 14px/1.45 var(--font-ui);
	-webkit-font-smoothing: antialiased;
}
body::before {
	content: "";
	position: fixed;
	inset: 0 0 auto;
	height: env(safe-area-inset-top, 0px);
	z-index: 10;
	background: var(--panel);
}
.bar {
	position: sticky;
	top: env(safe-area-inset-top, 0px);
	z-index: 5;
	background: var(--panel);
	border-bottom: 1px solid var(--line);
}
.bar-inner, main {
	max-width: 1680px;
	margin: 0 auto;
	padding-left: max(16px, env(safe-area-inset-left, 0px));
	padding-right: max(16px, env(safe-area-inset-right, 0px));
}
.bar-inner {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 10px 16px;
	padding-block: 12px;
}
h1 {
	margin: 0 12px 0 0;
	font-size: 16px;
	font-weight: 600;
}
.summary {
	color: var(--ink-soft);
	font-size: 13px;
	font-variant-numeric: tabular-nums;
}
.spacer { flex: 1; }
.seg {
	display: inline-flex;
	padding: 2px;
	border-radius: 7px;
	background: var(--line);
}
.seg button {
	height: 24px;
	padding: 0 10px;
	border: 0;
	border-radius: 5px;
	background: transparent;
	color: var(--ink);
	font: 500 12px var(--font-ui);
	cursor: pointer;
}
.seg button[aria-pressed="true"] {
	background: var(--panel);
	box-shadow: 0 0.5px 1.5px oklch(0% 0 0 / 0.2);
}
.seg button:focus-visible, input:focus-visible, .shot:focus-visible {
	outline: 2px solid var(--accent);
	outline-offset: 2px;
}
input[type="search"] {
	width: 200px;
	max-width: 100%;
	height: 28px;
	padding: 0 10px;
	border: 1px solid var(--line);
	border-radius: 999px;
	background: var(--bg);
	color: var(--ink);
	font: 13px var(--font-ui);
}
.legend {
	display: flex;
	gap: 14px;
	font-size: 12px;
	color: var(--ink-soft);
}
.legend span::before {
	content: "";
	display: inline-block;
	width: 9px;
	height: 9px;
	margin-right: 5px;
	border-radius: 2px;
	vertical-align: -1px;
	background: var(--changed);
}
.legend .same::before { background: var(--ink-soft); opacity: 0.35; }
main {
	display: grid;
	gap: 28px;
	padding-block: 24px 64px;
}
.screen {
	display: grid;
	gap: 10px;
	min-width: 0;
}
.screen-head {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 6px 12px;
}
.screen-head h2 {
	margin: 0;
	font-size: 14px;
	font-weight: 600;
}
.tag {
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	color: var(--ink-soft);
}
.stat {
	margin-left: auto;
	font-family: var(--font-data);
	font-size: 12px;
	font-variant-numeric: tabular-nums;
	color: var(--ink-soft);
}
.stat[data-level="high"] { color: var(--changed); }
.stat[data-level="new"] { color: var(--added); }
.trip {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 10px;
}
.trip[data-phone] { grid-template-columns: repeat(3, minmax(0, 260px)); }
figure {
	margin: 0;
	display: grid;
	gap: 6px;
	min-width: 0;
}
figcaption {
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	color: var(--ink-soft);
}
.shot {
	display: block;
	width: 100%;
	max-width: 100%;
	height: auto;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--panel);
	cursor: zoom-in;
}
.missing {
	display: grid;
	place-items: center;
	aspect-ratio: 1280 / 820;
	border: 1px dashed var(--line);
	border-radius: 6px;
	color: var(--ink-soft);
	font-size: 12px;
}
.trip[data-phone] .missing { aspect-ratio: 390 / 844; }
.empty {
	padding: 48px 0;
	text-align: center;
	color: var(--ink-soft);
}
dialog {
	width: min(1400px, calc(100vw - 32px));
	max-height: calc(100vh - 32px);
	padding: 0;
	border: 1px solid var(--line);
	border-radius: 10px;
	background: var(--panel);
	color: var(--ink);
	box-shadow: 0 16px 48px oklch(0% 0 0 / 0.35);
}
.close {
	height: 28px;
	padding: 0 12px;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--bg);
	color: var(--ink);
	font: 500 12px var(--font-ui);
	cursor: pointer;
}
dialog::backdrop { background: oklch(0% 0 0 / 0.5); }
.zoom-head {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 10px 14px;
	border-bottom: 1px solid var(--line);
}
.zoom-head strong { flex: 1; min-width: 0; font-size: 13px; }
.zoom-body { overflow: auto; max-height: calc(100vh - 100px); padding: 14px; }
.zoom-body canvas, .zoom-body img { display: block; max-width: 100%; height: auto; margin: 0 auto; }
@media (max-width: 760px) {
	.trip, .trip[data-phone] { grid-template-columns: minmax(0, 1fr); }
	.spacer { display: none; }
}
@media (prefers-reduced-motion: no-preference) {
	.shot { transition: border-color 120ms ease-out; }
}
.shot:hover { border-color: var(--ink-soft); }
</style>

<header class="bar">
	<div class="bar-inner">
		<h1>Citadel Visual Diff</h1>
		<span class="summary" id="summary">Comparing…</span>
		<span class="spacer"></span>
		<div class="seg" role="group" aria-label="Show">
			<button type="button" id="show-changed" data-show="changed" aria-pressed="true">Changed</button>
			<button type="button" id="show-all" data-show="all" aria-pressed="false">All</button>
		</div>
		<div class="seg" role="group" aria-label="Theme">
			<button type="button" id="theme-both" data-theme-filter="both" aria-pressed="true">Both</button>
			<button type="button" id="theme-light" data-theme-filter="light" aria-pressed="false">Light</button>
			<button type="button" id="theme-dark" data-theme-filter="dark" aria-pressed="false">Dark</button>
		</div>
		<input type="search" id="filter" placeholder="Filter screens" aria-label="Filter screens">
		<div class="legend"><span>Changed pixels</span><span class="same">Unchanged, dimmed</span></div>
	</div>
</header>
<main id="list"></main>
<dialog id="zoom">
	<div class="zoom-head">
		<strong id="zoom-title"></strong>
		<div class="seg" role="group" aria-label="View">
			<button type="button" id="zoom-before" data-view="before" aria-pressed="false">Before</button>
			<button type="button" id="zoom-after" data-view="after" aria-pressed="true">After</button>
			<button type="button" id="zoom-diff" data-view="diff" aria-pressed="false">Difference</button>
		</div>
		<form method="dialog"><button type="submit" class="close">Close</button></form>
	</div>
	<div class="zoom-body" id="zoom-body"></div>
</dialog>

<script>
const ENTRIES = /*__ENTRIES__*/[];
const THRESHOLD = 24; // summed RGB difference below which a pixel counts as unchanged
const state = { show: "changed", theme: "both", query: "" };
const results = new Map(); // name -> { ratio, canvas }

const load = (src) =>
	new Promise((resolve) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => resolve(null);
		img.src = src;
	});

/* Dim the after image to grey, then paint every changed pixel in the accent. */
function diff(before, after) {
	const w = Math.max(before.naturalWidth, after.naturalWidth);
	const h = Math.max(before.naturalHeight, after.naturalHeight);
	const read = (img) => {
		const c = document.createElement("canvas");
		c.width = w; c.height = h;
		const x = c.getContext("2d", { willReadFrequently: true });
		x.drawImage(img, 0, 0);
		return x.getImageData(0, 0, w, h).data;
	};
	const a = read(before), b = read(after);
	const out = document.createElement("canvas");
	out.width = w; out.height = h;
	const ctx = out.getContext("2d");
	const img = ctx.createImageData(w, h);
	const d = img.data;
	const mark = getComputedStyle(document.documentElement).getPropertyValue("--changed");
	const probe = document.createElement("canvas").getContext("2d");
	probe.fillStyle = mark.trim() || "#e0218a";
	probe.fillRect(0, 0, 1, 1);
	const [mr, mg, mb] = probe.getImageData(0, 0, 1, 1).data;
	let changed = 0;
	for (let i = 0; i < d.length; i += 4) {
		const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
		if (delta > THRESHOLD) {
			changed++;
			d[i] = mr; d[i + 1] = mg; d[i + 2] = mb; d[i + 3] = 255;
		} else {
			const grey = (b[i] * 0.3 + b[i + 1] * 0.59 + b[i + 2] * 0.11) | 0;
			const v = 128 + ((grey - 128) * 0.25) | 0;
			d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
		}
	}
	ctx.putImageData(img, 0, 0);
	return { ratio: changed / (w * h), canvas: out };
}

function level(r) {
	if (r === null) return "new";
	if (r > 0.05) return "high";
	return r > 0 ? "low" : "none";
}

function describe(entry, r) {
	if (!entry.before) return "New screen";
	if (!entry.after) return "Removed";
	if (!r) return "Comparing…";
	if (r.ratio === 0) return "No change";
	const pct = r.ratio * 100;
	return (pct < 0.1 ? "<0.1" : pct.toFixed(pct < 10 ? 1 : 0)) + "% of pixels changed";
}

function visible(entry) {
	const r = results.get(entry.name);
	if (state.theme !== "both" && entry.theme !== state.theme) return false;
	if (state.query && !(entry.title + " " + entry.group + " " + entry.key).toLowerCase().includes(state.query)) return false;
	if (state.show === "changed") {
		if (!entry.before || !entry.after) return true;
		return r ? r.ratio > 0 : true;
	}
	return true;
}

function order(a, b) {
	const ra = results.get(a.name), rb = results.get(b.name);
	// Biggest changes first; screens with only one side go last.
	const score = (e, r) => (!e.before || !e.after ? -1 : r ? r.ratio : 0);
	return score(b, rb) - score(a, ra) || a.name.localeCompare(b.name);
}

function figure(caption, node) {
	const f = document.createElement("figure");
	const c = document.createElement("figcaption");
	c.textContent = caption;
	f.append(c, node);
	return f;
}

function missing(text) {
	const m = document.createElement("div");
	m.className = "missing";
	m.textContent = text;
	return m;
}

function shot(src, entry, view) {
	const img = document.createElement("img");
	img.className = "shot";
	img.src = src;
	img.alt = entry.title + " (" + entry.theme + "), " + view;
	img.loading = "lazy";
	img.tabIndex = 0;
	img.addEventListener("click", () => openZoom(entry, view));
	img.addEventListener("keydown", (e) => { if (e.key === "Enter") openZoom(entry, view); });
	return img;
}

function render() {
	const list = document.getElementById("list");
	const shown = ENTRIES.filter(visible).sort(order);
	list.replaceChildren();
	if (shown.length === 0) {
		const p = document.createElement("p");
		p.className = "empty";
		p.textContent = state.show === "changed" ? "No screens changed with these filters. Choose All to see every screen." : "No screens match this filter.";
		list.append(p);
	}
	for (const entry of shown) {
		const r = results.get(entry.name);
		const section = document.createElement("section");
		section.className = "screen";
		const head = document.createElement("div");
		head.className = "screen-head";
		const h = document.createElement("h2");
		h.textContent = entry.title;
		const tag = document.createElement("span");
		tag.className = "tag";
		tag.textContent = entry.group + " · " + entry.theme;
		const stat = document.createElement("span");
		stat.className = "stat";
		stat.dataset.level = !entry.before ? "new" : level(r ? r.ratio : 0);
		stat.textContent = describe(entry, r);
		head.append(h, tag, stat);
		const trip = document.createElement("div");
		trip.className = "trip";
		if (entry.group === "Phone") trip.dataset.phone = "";
		trip.append(
			figure("Before", entry.before ? shot("before/" + entry.name, entry, "before") : missing("Not captured before")),
			figure("After", entry.after ? shot("after/" + entry.name, entry, "after") : missing("Not captured now")),
			figure("Difference", r ? diffNode(r, entry) : missing(entry.before && entry.after ? "Comparing…" : "Nothing to compare")),
		);
		section.append(head, trip);
		list.append(section);
	}
	const done = ENTRIES.filter((e) => e.before && e.after && results.has(e.name));
	const changed = done.filter((e) => results.get(e.name).ratio > 0).length;
	const added = ENTRIES.filter((e) => !e.before).length;
	document.getElementById("summary").textContent =
		changed + " of " + done.length + " screens changed" + (added ? " · " + added + " new" : "") + " · " + shown.length + " shown";
}

function diffNode(r, entry) {
	const c = document.createElement("canvas");
	c.width = r.canvas.width; c.height = r.canvas.height;
	c.getContext("2d").drawImage(r.canvas, 0, 0);
	c.className = "shot";
	c.tabIndex = 0;
	c.setAttribute("role", "img");
	c.setAttribute("aria-label", entry.title + " (" + entry.theme + "), difference");
	c.addEventListener("click", () => openZoom(entry, "diff"));
	c.addEventListener("keydown", (e) => { if (e.key === "Enter") openZoom(entry, "diff"); });
	return c;
}

let zoomEntry = null;
function openZoom(entry, view) {
	zoomEntry = entry;
	document.getElementById("zoom-title").textContent = entry.title + " · " + entry.theme;
	setZoomView(view);
	const dlg = document.getElementById("zoom");
	if (!dlg.open) dlg.showModal();
}
function setZoomView(view) {
	for (const b of document.querySelectorAll("[data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === view));
	const body = document.getElementById("zoom-body");
	const r = results.get(zoomEntry.name);
	if (view === "diff") body.replaceChildren(r ? diffNode(r, zoomEntry) : missing("Nothing to compare"));
	else if (zoomEntry[view]) {
		const img = document.createElement("img");
		img.src = view + "/" + zoomEntry.name;
		img.alt = zoomEntry.title + ", " + view;
		body.replaceChildren(img);
	} else body.replaceChildren(missing("Not captured " + (view === "before" ? "before" : "now")));
}
for (const b of document.querySelectorAll("[data-view]")) b.addEventListener("click", () => setZoomView(b.dataset.view));
document.addEventListener("keydown", (e) => {
	if (!document.getElementById("zoom").open) return;
	const views = ["before", "after", "diff"];
	const current = document.querySelector('[data-view][aria-pressed="true"]')?.dataset.view;
	if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
		const i = views.indexOf(current) + (e.key === "ArrowRight" ? 1 : -1);
		setZoomView(views[(i + 3) % 3]);
	}
});

for (const b of document.querySelectorAll("[data-show]")) b.addEventListener("click", () => {
	state.show = b.dataset.show;
	for (const o of document.querySelectorAll("[data-show]")) o.setAttribute("aria-pressed", String(o === b));
	render();
});
for (const b of document.querySelectorAll("[data-theme-filter]")) b.addEventListener("click", () => {
	state.theme = b.dataset.themeFilter;
	for (const o of document.querySelectorAll("[data-theme-filter]")) o.setAttribute("aria-pressed", String(o === b));
	render();
});
document.getElementById("filter").addEventListener("input", (e) => {
	state.query = e.target.value.trim().toLowerCase();
	render();
});

render();
(async () => {
	for (const entry of ENTRIES) {
		if (!entry.before || !entry.after) continue;
		const [a, b] = await Promise.all([load("before/" + entry.name), load("after/" + entry.name)]);
		if (!a || !b) continue;
		try {
			results.set(entry.name, diff(a, b));
		} catch {
			document.getElementById("summary").textContent =
				"Can't compare pixels on a file:// page. Serve this folder over HTTP (for example python3 -m http.server) and reload.";
			return;
		}
	}
	render();
})();
</script>`;

const args = process.argv.slice(2);
const fragment = args.includes("--fragment");
const [beforeDir, afterDir, outDir] = args.filter((a) => !a.startsWith("--"));
if (!beforeDir || !afterDir || !outDir) {
	console.error(
		"usage: visual-diff.mjs <before-dir> <after-dir> <out-dir> [--fragment]",
	);
	process.exit(1);
}

const pngs = (dir) =>
	new Set(readdirSync(dir).filter((name) => name.endsWith(".png")));
const before = pngs(beforeDir);
const after = pngs(afterDir);

mkdirSync(join(outDir, "before"), { recursive: true });
mkdirSync(join(outDir, "after"), { recursive: true });

const THEME = /-(light|dark)\.png$/;
const label = (name) => {
	const base = name.replace(THEME, "").replace(/\.png$/, "");
	const story = base.startsWith("sb-");
	const words = base
		.replace(/^sb-/, "")
		.replace(/^\d+-/, "")
		.replace(/^(atoms|molecules|organisms|ui|pages)-/, "")
		.replace(/--/, " · ")
		.replace(/-/g, " ");
	return {
		group: story ? "Storybook" : /^2\d-/.test(base) ? "Phone" : "Desktop",
		title: words.charAt(0).toUpperCase() + words.slice(1),
		key: base,
	};
};

const entries = [...new Set([...before, ...after])].sort().map((name) => {
	if (before.has(name)) copyFileSync(join(beforeDir, name), join(outDir, "before", name));
	if (after.has(name)) copyFileSync(join(afterDir, name), join(outDir, "after", name));
	return {
		name,
		theme: name.match(THEME)?.[1] ?? "light",
		before: before.has(name),
		after: after.has(name),
		...label(name),
	};
});

const page = TEMPLATE.replace(
	"/*__ENTRIES__*/[]",
	JSON.stringify(entries).replace(/</g, "\\u003c"),
);
writeFileSync(
	join(outDir, "index.html"),
	fragment
		? page
		: `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${page}\n</body>\n</html>\n`,
);
console.log(`${entries.length} screens → ${join(outDir, "index.html")}`);
