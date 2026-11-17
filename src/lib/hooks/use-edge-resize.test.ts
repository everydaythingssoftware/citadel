import { describe, expect, it } from "vitest";
import { some } from "@/lib/option";
import { draggedWidth, keyedWidth, ResizeEdge } from "./use-edge-resize";

const panel = (edge: ResizeEdge) => ({ width: 400, min: 300, max: 600, edge });

describe("draggedWidth", () => {
	it("widens a right edge as the pointer moves right", () => {
		expect(draggedWidth({ x: 100, width: 220 }, 130, ResizeEdge.right)).toBe(
			250,
		);
	});

	it("widens a left edge as the pointer moves left", () => {
		expect(draggedWidth({ x: 800, width: 500 }, 760, ResizeEdge.left)).toBe(
			540,
		);
		expect(draggedWidth({ x: 800, width: 500 }, 830, ResizeEdge.left)).toBe(
			470,
		);
	});
});

describe("keyedWidth", () => {
	it("grows toward the outside of the panel", () => {
		expect(keyedWidth("ArrowRight", false, panel(ResizeEdge.right))).toEqual(
			some(410),
		);
		expect(keyedWidth("ArrowLeft", false, panel(ResizeEdge.left))).toEqual(
			some(410),
		);
		expect(keyedWidth("ArrowRight", false, panel(ResizeEdge.left))).toEqual(
			some(390),
		);
	});

	it("moves five steps with Shift", () => {
		expect(keyedWidth("ArrowLeft", true, panel(ResizeEdge.left))).toEqual(
			some(450),
		);
	});

	it("jumps to the limits with Home and End", () => {
		expect(keyedWidth("Home", false, panel(ResizeEdge.left))).toEqual(
			some(300),
		);
		expect(keyedWidth("End", false, panel(ResizeEdge.left))).toEqual(some(600));
	});

	it("ignores other keys", () => {
		expect(keyedWidth("a", false, panel(ResizeEdge.left)).isSome).toBe(false);
	});
});
