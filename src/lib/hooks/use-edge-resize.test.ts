import { describe, expect, it } from "vitest";
import {
	draggedWidth,
	type EdgeResizeOptions,
	keyedWidth,
	ResizeEdge,
} from "./use-edge-resize";

const options = (edge: EdgeResizeOptions["edge"]): EdgeResizeOptions => ({
	width: 400,
	min: 300,
	max: 600,
	step: 10,
	edge,
	label: "Resize",
	setWidth: () => {},
	resetWidth: () => {},
});

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
		expect(keyedWidth("ArrowRight", false, options(ResizeEdge.right))).toBe(
			410,
		);
		expect(keyedWidth("ArrowLeft", false, options(ResizeEdge.left))).toBe(410);
		expect(keyedWidth("ArrowRight", false, options(ResizeEdge.left))).toBe(390);
	});

	it("moves five steps with Shift", () => {
		expect(keyedWidth("ArrowLeft", true, options(ResizeEdge.left))).toBe(450);
	});

	it("jumps to the limits with Home and End", () => {
		expect(keyedWidth("Home", false, options(ResizeEdge.left))).toBe(300);
		expect(keyedWidth("End", false, options(ResizeEdge.left))).toBe(600);
	});

	it("ignores other keys", () => {
		expect(keyedWidth("a", false, options(ResizeEdge.left))).toBeNull();
	});
});
