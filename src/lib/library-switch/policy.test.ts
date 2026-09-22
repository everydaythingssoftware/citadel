import { describe, expect, it } from "vitest";

import { decideCurtainSwitch } from "./policy";

const A = "/users/phil/Calibre Library";
const B = "/users/phil/Research";

const decide = (
	overrides: Partial<Parameters<typeof decideCurtainSwitch>[0]> = {},
) =>
	decideCurtainSwitch({
		curtainUp: false,
		wasReady: true,
		targetPath: B,
		confirmedPath: A,
		...overrides,
	});

describe("decideCurtainSwitch", () => {
	it("arms the deadline for a switch away from a ready library with no curtain", () => {
		expect(decide()).toEqual({ kind: "arm-deadline" });
	});

	it("ignores path changes while the store has never been ready and no curtain is up (boot)", () => {
		expect(decide({ wasReady: false, confirmedPath: null })).toEqual({
			kind: "ignore",
		});
	});

	it("cancels when the target equals the confirmed library (rapid A→B→A)", () => {
		expect(decide({ targetPath: A, confirmedPath: A })).toEqual({
			kind: "cancel",
		});
	});

	it("cancel wins even while the curtain is up", () => {
		expect(
			decide({ curtainUp: true, targetPath: A, confirmedPath: A }),
		).toEqual({ kind: "cancel" });
	});

	it("shows immediately on a re-switch while the curtain is already up", () => {
		expect(decide({ curtainUp: true })).toEqual({ kind: "show-immediately" });
	});

	it("shows immediately even mid-reveal", () => {
		expect(decide({ curtainUp: true, wasReady: false })).toEqual({
			kind: "show-immediately",
		});
	});

	it("never cancels before the first confirmed library (confirmedPath null)", () => {
		expect(decide({ confirmedPath: null })).toEqual({
			kind: "arm-deadline",
		});
	});
});
