import { beforeEach, describe, expect, it } from "vitest";
import type { LibraryBook } from "@/bindings";
import { useLibraryStore } from "@/stores/library/store";
import {
	closeBooksEdit,
	closeBooksEditForLibrary,
	requestBooksEdit,
	useEditBooksStore,
} from "./store";

const books = [{ id: "1" }, { id: "2" }] as LibraryBook[];

describe("edit books store", () => {
	beforeEach(() => {
		closeBooksEdit();
		useLibraryStore.setState({ confirmedLibraryPath: "/a" });
	});

	it("remembers the library that the books belong to", () => {
		requestBooksEdit(books);
		expect(useEditBooksStore.getState()).toEqual({
			step: "editing",
			books,
			libraryPath: "/a",
		});
	});

	it("changes nothing when no library is confirmed", () => {
		useLibraryStore.setState({ confirmedLibraryPath: null });
		const idle = useEditBooksStore.getState();
		requestBooksEdit(books);
		expect(useEditBooksStore.getState()).toBe(idle);
	});

	it("closes when the confirmed library changes", () => {
		requestBooksEdit(books);
		closeBooksEditForLibrary("/b");
		expect(useEditBooksStore.getState().step).toBe("idle");
	});

	it("stays idle, with no new state, when no sheet is open", () => {
		const idle = useEditBooksStore.getState();
		closeBooksEditForLibrary("/b");
		expect(useEditBooksStore.getState()).toBe(idle);
		expect(idle.step).toBe("idle");
	});

	it("stays open for the same library", () => {
		requestBooksEdit(books);
		closeBooksEditForLibrary("/a");
		expect(useEditBooksStore.getState().step).toBe("editing");
	});
});
