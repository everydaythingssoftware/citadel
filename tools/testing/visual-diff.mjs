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
const TEMPLATE = `<title>Citadel Visual Diff</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
/* Layout: a sticky control bar over wrapping horizontal strips (before · after · difference), each a synced pan-and-zoom viewport, worst change first. */
:root {
	--bg: oklch(95.5% 0.004 90);
	--panel: oklch(97.5% 0.003 90);
	--well: oklch(91% 0.004 90);
	--ink: oklch(21% 0.004 270);
	--ink-soft: oklch(45% 0.005 270);
	--line: oklch(21% 0.004 270 / 0.16);
	--accent: oklch(25% 0.005 270);
	--changed: oklch(62% 0.25 340);
	--added: oklch(55% 0.14 150);
	--chip-bg: oklch(21% 0.004 270 / 0.72);
	--chip-ink: oklch(98% 0.003 90);
	--font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
	--font-data: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
	--h: 300px;
}
@media (prefers-color-scheme: dark) {
	:root:not([data-theme="light"]) {
		--bg: oklch(18.5% 0.004 270);
		--panel: oklch(21% 0.004 270);
		--well: oklch(15% 0.004 270);
		--ink: oklch(94% 0.003 90);
		--ink-soft: oklch(70% 0.004 90);
		--line: oklch(94% 0.003 90 / 0.12);
		--accent: oklch(94% 0.003 90);
		--changed: oklch(70% 0.22 340);
		--added: oklch(72% 0.14 150);
		--chip-bg: oklch(10% 0.004 270 / 0.72);
		--chip-ink: oklch(96% 0.003 90);
		color-scheme: dark;
	}
}
:root[data-theme="dark"] {
	--bg: oklch(18.5% 0.004 270);
	--panel: oklch(21% 0.004 270);
	--well: oklch(15% 0.004 270);
	--ink: oklch(94% 0.003 90);
	--ink-soft: oklch(70% 0.004 90);
	--line: oklch(94% 0.003 90 / 0.12);
	--accent: oklch(94% 0.003 90);
	--changed: oklch(70% 0.22 340);
	--added: oklch(72% 0.14 150);
	--chip-bg: oklch(10% 0.004 270 / 0.72);
	--chip-ink: oklch(96% 0.003 90);
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
button { font: inherit; color: inherit; }
.bar {
	position: sticky;
	top: env(safe-area-inset-top, 0px);
	z-index: 5;
	background: var(--panel);
	border-bottom: 1px solid var(--line);
}
.bar-inner, main {
	padding-left: max(16px, env(safe-area-inset-left, 0px));
	padding-right: max(16px, env(safe-area-inset-right, 0px));
}
.bar-inner {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 10px 16px;
	padding-block: 10px;
}
h1 { margin: 0 4px 0 0; font-size: 16px; font-weight: 600; }
.summary { color: var(--ink-soft); font-size: 13px; font-variant-numeric: tabular-nums; }
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
	font-size: 12px;
	font-weight: 500;
	cursor: pointer;
}
.seg button[aria-pressed="true"] {
	background: var(--panel);
	box-shadow: 0 0.5px 1.5px oklch(0% 0 0 / 0.2);
}
.size {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	font-size: 12px;
	color: var(--ink-soft);
}
.size input { width: 120px; accent-color: var(--accent); }
.size output { min-width: 4ch; font-family: var(--font-data); font-variant-numeric: tabular-nums; }
input[type="search"] {
	width: 180px;
	max-width: 100%;
	height: 28px;
	padding: 0 10px;
	border: 1px solid var(--line);
	border-radius: 999px;
	background: var(--bg);
	color: var(--ink);
	font: 13px var(--font-ui);
}
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.hint { font-size: 12px; color: var(--ink-soft); }
.hint kbd {
	padding: 0 4px;
	border: 1px solid var(--line);
	border-radius: 4px;
	font: 11px var(--font-data);
}
main {
	display: grid;
	gap: 36px;
	padding-block: 20px 64px;
}
.areas {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	padding-block: 12px 0;
	padding-left: max(16px, env(safe-area-inset-left, 0px));
	padding-right: max(16px, env(safe-area-inset-right, 0px));
}
.areas a {
	padding: 3px 10px;
	border: 1px solid var(--line);
	border-radius: 99px;
	color: var(--ink);
	font-size: 12px;
	text-decoration: none;
}
.areas a:hover { background: var(--line); }
.area { display: grid; gap: 14px; scroll-margin-top: 90px; }
.area > h2 {
	display: flex;
	align-items: baseline;
	gap: 10px;
	margin: 0;
	padding-bottom: 8px;
	border-bottom: 1px solid var(--line);
	font-size: 17px;
	font-weight: 600;
}
.area > h2 span { font-size: 12px; font-weight: 500; color: var(--ink-soft); }
.area-strips {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-start;
	gap: 24px 28px;
}
.strip {
	display: grid;
	gap: 8px;
	min-width: 0;
	max-width: 100%;
}
.strip-head {
	display: flex;
	align-items: baseline;
	gap: 4px 10px;
	min-width: 0;
}
.strip-head h3 {
	margin: 0;
	font-size: 13px;
	font-weight: 600;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	min-width: 0;
}
.tag {
	flex: none;
	font-size: 10.5px;
	font-weight: 600;
	letter-spacing: 0.05em;
	text-transform: uppercase;
	color: var(--ink-soft);
}
.stat {
	flex: none;
	margin-left: auto;
	font-family: var(--font-data);
	font-size: 11.5px;
	font-variant-numeric: tabular-nums;
	color: var(--ink-soft);
}
.stat[data-level="high"] { color: var(--changed); }
.stat[data-level="new"] { color: var(--added); }
.tools { flex: none; display: inline-flex; gap: 2px; }
.tool {
	height: 22px;
	padding: 0 7px;
	border: 1px solid transparent;
	border-radius: 5px;
	background: transparent;
	font-size: 11.5px;
	color: var(--ink-soft);
	cursor: pointer;
}
.tool:hover { border-color: var(--line); color: var(--ink); }
.panes {
	display: flex;
	gap: 6px;
	overflow-x: auto;
	max-width: 100%;
	touch-action: pan-x pan-y;
	cursor: grab;
	user-select: none;
	-webkit-user-select: none;
	border-radius: 7px;
}
.panes[data-zoomed] { touch-action: none; }
.panes:active { cursor: grabbing; }
.pane {
	position: relative;
	flex: none;
	height: var(--h);
	overflow: hidden;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--well);
}
.layer {
	position: absolute;
	inset: 0;
	transform-origin: 0 0;
	will-change: transform;
}
.layer > img, .layer > canvas {
	display: block;
	width: 100%;
	height: 100%;
	-webkit-user-drag: none;
}
.panes[data-pixelated] .layer > * { image-rendering: pixelated; }
.chip {
	position: absolute;
	top: 6px;
	left: 6px;
	z-index: 1;
	padding: 1px 6px;
	border-radius: 4px;
	background: var(--chip-bg);
	color: var(--chip-ink);
	font-size: 10px;
	font-weight: 600;
	letter-spacing: 0.05em;
	text-transform: uppercase;
	pointer-events: none;
}
.zoomed {
	position: absolute;
	right: 6px;
	bottom: 6px;
	z-index: 1;
	padding: 1px 6px;
	border-radius: 4px;
	background: var(--chip-bg);
	color: var(--chip-ink);
	font: 10px var(--font-data);
	pointer-events: none;
}
.missing {
	position: absolute;
	inset: 0;
	display: grid;
	place-items: center;
	padding: 8px;
	text-align: center;
	color: var(--ink-soft);
	font-size: 12px;
	background: repeating-linear-gradient(135deg, transparent 0 8px, var(--line) 8px 9px);
}
.empty { width: 100%; padding: 48px 0; text-align: center; color: var(--ink-soft); }
dialog {
	width: calc(100vw - 32px);
	max-width: none;
	max-height: calc(100vh - 32px);
	padding: 0;
	border: 1px solid var(--line);
	border-radius: 10px;
	background: var(--panel);
	color: var(--ink);
	box-shadow: 0 16px 48px oklch(0% 0 0 / 0.35);
}
dialog::backdrop { background: oklch(0% 0 0 / 0.55); }
.big-head {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 10px 14px;
	border-bottom: 1px solid var(--line);
}
.big-head strong { flex: 1; min-width: 0; font-size: 13px; }
.close {
	height: 28px;
	padding: 0 12px;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--bg);
	font-size: 12px;
	font-weight: 500;
	cursor: pointer;
}
.big-body { display: grid; place-items: center; padding: 14px; overflow: auto; }
@media (max-width: 760px) {
	.spacer, .hint { display: none; }
}
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
		<label class="size" for="height">Height
			<input type="range" id="height" min="120" max="720" step="20" value="300">
			<output id="height-out" for="height">300</output>
		</label>
		<input type="search" id="filter" placeholder="Filter screens" aria-label="Filter screens">
		<span class="hint">Pinch or <kbd>⌥</kbd>+scroll to zoom · drag to pan · <kbd>double-click</kbd> resets · Expand for a big view</span>
	</div>
</header>
<nav class="areas" id="areas" aria-label="Areas"></nav>
<main id="list"></main>
<dialog id="big" aria-labelledby="big-title">
	<div class="big-head">
		<strong id="big-title"></strong>
		<span class="hint">Scroll to zoom · drag to pan · <kbd>0</kbd> resets</span>
		<form method="dialog"><button type="submit" class="close">Close</button></form>
	</div>
	<div class="big-body" id="big-body"></div>
</dialog>

<script>
const ENTRIES = /*__ENTRIES__*/[];
const AREAS = /*__AREAS__*/[];
const THRESHOLD = 24; // summed RGB difference below which a pixel counts as unchanged
const MAX_ZOOM = 24;
const state = { show: "changed", theme: "both", query: "", height: 300 };
const results = new Map(); // name -> { ratio, canvas }
const sizes = new Map(); // name -> [w, h] of the captured image
const DEFAULT_SIZE = { Desktop: [1280, 820], Phone: [390, 844], Storybook: [1100, 760] };

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
	const probe = document.createElement("canvas").getContext("2d");
	probe.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--changed").trim() || "#e0218a";
	probe.fillRect(0, 0, 1, 1);
	const [mr, mg, mb] = probe.getImageData(0, 0, 1, 1).data;
	let changed = 0;
	for (let i = 0; i < d.length; i += 4) {
		const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
		if (delta > THRESHOLD) {
			changed++;
			d[i] = mr; d[i + 1] = mg; d[i + 2] = mb; d[i + 3] = 255;
		} else {
			const grey = b[i] * 0.3 + b[i + 1] * 0.59 + b[i + 2] * 0.11;
			const v = (128 + (grey - 128) * 0.25) | 0;
			d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
		}
	}
	ctx.putImageData(img, 0, 0);
	return { ratio: changed / (w * h), canvas: out };
}

function level(entry, r) {
	if (!entry.before) return "new";
	if (!r) return "none";
	return r.ratio > 0.05 ? "high" : r.ratio > 0 ? "low" : "none";
}

function describe(entry, r) {
	if (!entry.before) return "Not captured before";
	if (!entry.after) return "Removed";
	if (!r) return "Comparing…";
	if (r.ratio === 0) return "No change";
	const pct = r.ratio * 100;
	return (pct < 0.1 ? "<0.1" : pct.toFixed(pct < 10 ? 1 : 0)) + "% changed";
}

function visible(entry) {
	const r = results.get(entry.name);
	if (state.theme !== "both" && entry.theme !== state.theme) return false;
	if (state.query && !(entry.title + " " + entry.group + " " + entry.key).toLowerCase().includes(state.query)) return false;
	if (state.show === "changed" && entry.before && entry.after) return r ? r.ratio > 0 : true;
	return true;
}

// Within an area: by screen, light then dark side by side.
function order(a, b) {
	return a.key.localeCompare(b.key) || (a.theme === "light" ? -1 : 1);
}

const slug = (text) => "area-" + text.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "");

/* ---- Synced pan and zoom: one transform drives all three panes. ---- */
function makeZoom(panes, layers, readout, size, freeWheel) {
	const z = { s: 1, x: 0, y: 0 };
	const box = () => {
		const pane = layers[0].parentElement;
		return { w: pane.clientWidth, h: pane.clientHeight };
	};
	const clamp = () => {
		const { w, h } = box();
		z.s = Math.min(MAX_ZOOM, Math.max(1, z.s));
		z.x = Math.min(0, Math.max(w - w * z.s, z.x));
		z.y = Math.min(0, Math.max(h - h * z.s, z.y));
	};
	const apply = () => {
		clamp();
		const t = "translate(" + z.x + "px," + z.y + "px) scale(" + z.s + ")";
		for (const l of layers) l.style.transform = t;
		// Past the screenshot's own resolution, show pixels as pixels.
		const shown = box().h * z.s;
		if (shown > size()[1] * 1.5) panes.dataset.pixelated = "";
		else delete panes.dataset.pixelated;
		for (const r of readout) r.textContent = z.s > 1.01 ? z.s.toFixed(z.s < 10 ? 1 : 0) + "×" : "";
		for (const r of readout) r.hidden = z.s <= 1.01;
		// Unzoomed strips let the page scroll under a finger; zoomed ones pan.
		if (z.s > 1.01) panes.dataset.zoomed = "";
		else delete panes.dataset.zoomed;
	};
	const zoomAt = (factor, px, py) => {
		const next = Math.min(MAX_ZOOM, Math.max(1, z.s * factor));
		z.x = px - (px - z.x) * (next / z.s);
		z.y = py - (py - z.y) * (next / z.s);
		z.s = next;
		apply();
	};
	// Any pane's point maps to the same image point in every pane.
	const local = (e) => {
		const pane = e.target.closest(".pane") || layers[0].parentElement;
		const r = pane.getBoundingClientRect();
		return [e.clientX - r.left, e.clientY - r.top];
	};
	panes.addEventListener("wheel", (e) => {
		// Pinch arrives as ctrl+wheel. In the overview a plain wheel scrolls
		// the page, or pans a strip that is already zoomed.
		const zoomGesture = freeWheel || e.ctrlKey || e.metaKey || e.altKey;
		if (!zoomGesture) {
			if (z.s <= 1.01) return;
			e.preventDefault();
			z.x -= e.deltaX;
			z.y -= e.deltaY;
			apply();
			return;
		}
		e.preventDefault();
		const [px, py] = local(e);
		zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), px, py);
	}, { passive: false });
	const pointers = new Map();
	let pinch = null;
	panes.addEventListener("pointerdown", (e) => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		panes.setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, [e.clientX, e.clientY]);
		if (pointers.size === 2) {
			const [[ax, ay], [bx, by]] = [...pointers.values()];
			pinch = { d: Math.hypot(ax - bx, ay - by) };
		}
	});
	panes.addEventListener("pointermove", (e) => {
		const prev = pointers.get(e.pointerId);
		if (!prev) return;
		pointers.set(e.pointerId, [e.clientX, e.clientY]);
		if (pointers.size === 2 && pinch) {
			const [[ax, ay], [bx, by]] = [...pointers.values()];
			const d = Math.hypot(ax - bx, ay - by);
			const pane = layers[0].parentElement.getBoundingClientRect();
			zoomAt(d / pinch.d, (ax + bx) / 2 - pane.left, (ay + by) / 2 - pane.top);
			pinch.d = d;
		} else if (pointers.size === 1 && (z.s > 1.01 || e.pointerType === "mouse")) {
			z.x += e.clientX - prev[0];
			z.y += e.clientY - prev[1];
			apply();
		}
	});
	const lift = (e) => {
		pointers.delete(e.pointerId);
		if (pointers.size < 2) pinch = null;
	};
	panes.addEventListener("pointerup", lift);
	panes.addEventListener("pointercancel", lift);
	const reset = () => { z.s = 1; z.x = 0; z.y = 0; apply(); };
	panes.addEventListener("dblclick", reset);
	panes.tabIndex = 0;
	panes.addEventListener("keydown", (e) => {
		const { w, h } = box();
		const step = 40;
		if (e.key === "+" || e.key === "=") zoomAt(1.5, w / 2, h / 2);
		else if (e.key === "-") zoomAt(1 / 1.5, w / 2, h / 2);
		else if (e.key === "0") reset();
		else if (e.key === "ArrowLeft") { z.x += step; apply(); }
		else if (e.key === "ArrowRight") { z.x -= step; apply(); }
		else if (e.key === "ArrowUp") { z.y += step; apply(); }
		else if (e.key === "ArrowDown") { z.y -= step; apply(); }
		else return;
		e.preventDefault();
	});
	apply();
	const set = (v) => { Object.assign(z, v); apply(); };
	return { z, apply, reset, set };
}

function sizeOf(entry) {
	return sizes.get(entry.name) || DEFAULT_SIZE[entry.group] || DEFAULT_SIZE.Desktop;
}

/* One horizontal triptych at a given pane height. */
function buildStrip(entry, height, freeWheel) {
	const r = results.get(entry.name);
	const [w, h] = sizeOf(entry);
	const paneW = Math.round((height * w) / h);
	const panes = document.createElement("div");
	panes.className = "panes";
	panes.setAttribute("role", "group");
	panes.setAttribute("aria-label", entry.title + " " + entry.theme + ": before, after and difference. Plus and minus zoom, arrows pan, 0 resets.");
	const layers = [], readouts = [];
	const pane = (label, content) => {
		const p = document.createElement("div");
		p.className = "pane";
		p.style.width = paneW + "px";
		p.style.height = height + "px";
		const chip = document.createElement("span");
		chip.className = "chip";
		chip.textContent = label;
		const layer = document.createElement("div");
		layer.className = "layer";
		const zoomed = document.createElement("span");
		zoomed.className = "zoomed";
		zoomed.hidden = true;
		if (content) layer.append(content);
		else {
			const m = document.createElement("div");
			m.className = "missing";
			m.textContent = label === "Difference" ? (entry.before && entry.after ? "Comparing…" : "Nothing to compare") : "Not captured " + (label === "Before" ? "before" : "now");
			layer.append(m);
		}
		p.append(layer, chip, zoomed);
		layers.push(layer);
		readouts.push(zoomed);
		panes.append(p);
	};
	const img = (side) => {
		if (!entry[side]) return null;
		const i = document.createElement("img");
		i.src = side + "/" + entry.name;
		i.alt = "";
		i.draggable = false;
		i.decoding = "async";
		return i;
	};
	let diffCanvas = null;
	if (r) {
		diffCanvas = document.createElement("canvas");
		diffCanvas.width = r.canvas.width;
		diffCanvas.height = r.canvas.height;
		diffCanvas.getContext("2d").drawImage(r.canvas, 0, 0);
	}
	pane("Before", img("before"));
	pane("After", img("after"));
	pane("Difference", diffCanvas);
	const zoom = makeZoom(panes, layers, readouts, () => sizeOf(entry), freeWheel);
	return { panes, zoom, height };
}

function render() {
	const list = document.getElementById("list");
	const shown = ENTRIES.filter(visible).sort(order);
	list.replaceChildren();
	const nav = document.getElementById("areas");
	nav.replaceChildren();
	const groups = new Map();
	for (const area of AREAS) {
		const inArea = shown.filter((e) => e.area === area);
		if (inArea.length === 0) continue;
		const section = document.createElement("section");
		section.className = "area";
		section.id = slug(area);
		const h = document.createElement("h2");
		h.textContent = area;
		const count = document.createElement("span");
		count.textContent = inArea.length + (inArea.length === 1 ? " capture" : " captures");
		h.append(count);
		const strips = document.createElement("div");
		strips.className = "area-strips";
		section.append(h, strips);
		list.append(section);
		groups.set(area, strips);
		const link = document.createElement("a");
		link.href = "#" + section.id;
		link.textContent = area;
		nav.append(link);
	}
	if (shown.length === 0) {
		const p = document.createElement("p");
		p.className = "empty";
		p.textContent = state.show === "changed" ? "No screens changed with these filters. Choose All to see every screen." : "No screens match this filter.";
		list.append(p);
	}
	for (const entry of shown) {
		const r = results.get(entry.name);
		const section = document.createElement("section");
		section.className = "strip";
		const strip = buildStrip(entry, state.height);
		section.style.width = "min(100%, " + (strip.panes.scrollWidth || 0) + "px)";
		const head = document.createElement("div");
		head.className = "strip-head";
		const h = document.createElement("h3");
		h.textContent = entry.title;
		h.title = entry.name;
		const tag = document.createElement("span");
		tag.className = "tag";
		tag.textContent = entry.group + " · " + entry.theme;
		const stat = document.createElement("span");
		stat.className = "stat";
		stat.dataset.level = level(entry, r);
		stat.textContent = describe(entry, r);
		const tools = document.createElement("span");
		tools.className = "tools";
		const reset = document.createElement("button");
		reset.type = "button";
		reset.className = "tool";
		reset.textContent = "Reset";
		reset.addEventListener("click", strip.zoom.reset);
		const expand = document.createElement("button");
		expand.type = "button";
		expand.className = "tool";
		expand.textContent = "Expand";
		expand.addEventListener("click", () => openBig(entry, strip));
		tools.append(reset, expand);
		head.append(h, tag, stat, tools);
		section.append(head, strip.panes);
		groups.get(entry.area)?.append(section);
		requestAnimationFrame(() => {
			section.style.width = "min(100%, " + strip.panes.scrollWidth + "px)";
		});
	}
	const done = ENTRIES.filter((e) => e.before && e.after && results.has(e.name));
	const changed = done.filter((e) => results.get(e.name).ratio > 0).length;
	const added = ENTRIES.filter((e) => !e.before).length;
	document.getElementById("summary").textContent =
		changed + " of " + done.length + " captures changed" + (added ? " · " + added + " not captured before" : "") + " · " + shown.length + " shown";
}

function openBig(entry, from) {
	const [w, h] = sizeOf(entry);
	const gaps = 2 * 6 + 2 * 3;
	const fitW = (window.innerWidth - 80 - gaps) / 3;
	const height = Math.max(160, Math.floor(Math.min(window.innerHeight - 140, (fitW * h) / w)));
	const k = height / from.height;
	const big = buildStrip(entry, height, true);
	document.getElementById("big-title").textContent = entry.title + " · " + entry.group + " · " + entry.theme + " · " + describe(entry, results.get(entry.name));
	document.getElementById("big-body").replaceChildren(big.panes);
	const dlg = document.getElementById("big");
	dlg.showModal();
	// Carry the strip's view over once the panes have their size: offsets
	// scale with the pane.
	big.zoom.set({ s: from.zoom.z.s, x: from.zoom.z.x * k, y: from.zoom.z.y * k });
	big.panes.focus();
}

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
const heightInput = document.getElementById("height");
try {
	const saved = Number(localStorage.getItem("visual-diff-height"));
	if (saved >= 120 && saved <= 720) heightInput.value = String(saved);
} catch {}
const setHeight = () => {
	state.height = Number(heightInput.value);
	document.getElementById("height-out").textContent = String(state.height);
	try { localStorage.setItem("visual-diff-height", String(state.height)); } catch {}
};
setHeight();
heightInput.addEventListener("input", () => { setHeight(); render(); });

render();
(async () => {
	for (const entry of ENTRIES) {
		const [a, b] = await Promise.all([
			entry.before ? load("before/" + entry.name) : null,
			entry.after ? load("after/" + entry.name) : null,
		]);
		const any = b || a;
		if (any) sizes.set(entry.name, [any.naturalWidth, any.naturalHeight]);
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

/* Where each capture belongs, by file-name pattern; the first match wins.
   Anything unmatched lands in "Other". Areas render in this order. */
const AREAS = [
	["Sign-in & setup", /^(0[12]|20|3\d)-|setup|signin/],
	["Library", /^(0[3-6]|17|2[12])-|books-grid|search/],
	["Book editor", /^(0[7-9]|16|23)-|book-edit/],
	["Lists", /^(1[0-35]|24)-|authors|series|tags|publishers/],
	[
		"Settings & libraries",
		/^(14|25)-|settings|softwareupdate|currentlibrary|librarylist|switchlibrary/,
	],
	["Adding books", /upload|dropoverlay|addbook|bookuploads/],
	["Recovery & switching", /recovery|curtain/],
];
const areaOf = (key) =>
	AREAS.find(([, pattern]) => pattern.test(key))?.[0] ?? "Other";
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
		area: areaOf(base),
	};
};

const entries = [...new Set([...before, ...after])].sort().map((name) => {
	if (before.has(name))
		copyFileSync(join(beforeDir, name), join(outDir, "before", name));
	if (after.has(name))
		copyFileSync(join(afterDir, name), join(outDir, "after", name));
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
).replace(
	"/*__AREAS__*/[]",
	JSON.stringify([...AREAS.map(([name]) => name), "Other"]),
);
writeFileSync(
	join(outDir, "index.html"),
	fragment
		? page
		: `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${page}\n</body>\n</html>\n`,
);
console.log(`${entries.length} screens → ${join(outDir, "index.html")}`);
