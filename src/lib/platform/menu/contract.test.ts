import { describe, expectTypeOf, it } from "vitest";
import type {
	MenuCommand as RustMenuCommand,
	MenuStatePatch as RustMenuStatePatch,
} from "@/bindings";
import type { MenuCommand, MenuState } from "../types";

describe("menu contract", () => {
	it("mirrors the Rust menu command and state", () => {
		expectTypeOf<MenuCommand>().toEqualTypeOf<RustMenuCommand>();
		expectTypeOf<Partial<MenuState>>().toExtend<RustMenuStatePatch>();
	});
});
