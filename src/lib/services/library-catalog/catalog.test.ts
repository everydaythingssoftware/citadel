import { beforeEach, describe, expect, it, vi } from "vitest";
const ipc = vi.hoisted(() => ({
	initClient: vi.fn(),
	clbCmdCreateLibrary: vi.fn(),
	clbQueryIsPathValidLibrary: vi.fn(),
	clbQueryDetectCalibreLibrary: vi.fn(),
	clbQueryDefaultNewLibraryPath: vi.fn(),
	clbQueryLibraryStats: vi.fn(),
	clbQueryPathSyncStatus: vi.fn(),
	clbCmdSetCustomValue: vi.fn(),
	clbCmdSetBookCoverFromMetadata: vi.fn(),
}));
vi.mock("@/bindings", () => ({ commands: ipc }));
import { tauriLibraryCatalog } from "./tauri";
import { webLibraryCatalog } from "./web";
import { CoverExpiredError } from "../library/types";

describe("catalog and library transports", () => {
	it("rejects unavailable remote connections before issuing desktop commands", async () => {
		await expect(
			tauriLibraryCatalog.open({
				libraryType: "calibre",
				connectionType: "remote",
				url: "https://example.test",
			}),
		).rejects.toThrow("Remote library connections");
		expect(ipc.initClient).not.toHaveBeenCalled();
	});
	beforeEach(() => vi.resetAllMocks());
	it("opens the selected path before returning a Library and propagates mutation errors", async () => {
		ipc.initClient.mockResolvedValue({
			status: "ok",
			data: { library_path: "/books" },
		});
		const library = await tauriLibraryCatalog.open({
			libraryType: "calibre",
			connectionType: "local",
			libraryPath: "/books",
		});
		expect(ipc.initClient).toHaveBeenCalledWith("/books");
		ipc.clbCmdSetCustomValue.mockResolvedValue({
			status: "error",
			error: "invalid custom field",
		});
		await expect(library.setCustomValue("1", 2, null)).rejects.toThrow(
			"invalid custom field",
		);
		ipc.clbCmdSetBookCoverFromMetadata.mockResolvedValue({
			status: "error",
			error: "download failed",
		});
		await expect(
			library.setBookCoverFromMetadata("1", "cover-1"),
		).rejects.toThrow("download failed");
		ipc.clbCmdSetBookCoverFromMetadata.mockResolvedValue({
			status: "error",
			error: "This cover is no longer available — search again.",
		});
		await expect(
			library.setBookCoverFromMetadata("1", "cover-1"),
		).rejects.toBeInstanceOf(CoverExpiredError);
	});
	it("propagates discovery/create errors without turning them into success", async () => {
		ipc.clbCmdCreateLibrary.mockResolvedValue({
			status: "error",
			error: "create-library/folder-not-empty",
		});
		await expect(tauriLibraryCatalog.create("/books")).rejects.toThrow(
			"create-library/folder-not-empty",
		);
		ipc.initClient.mockResolvedValue({ status: "error", error: "cannot open" });
		await expect(
			tauriLibraryCatalog.open({
				libraryType: "calibre",
				connectionType: "local",
				libraryPath: "/books",
			}),
		).rejects.toThrow("cannot open");
	});
	it("never invokes desktop discovery or opening from the web catalog", async () => {
		expect(await webLibraryCatalog.detect()).toBeNull();
		expect(await webLibraryCatalog.isValid("/server/private")).toBe(false);
		await expect(
			webLibraryCatalog.open({
				libraryType: "calibre",
				connectionType: "local",
				libraryPath: "/server/private",
			}),
		).rejects.toThrow("unavailable");
		await expect(webLibraryCatalog.create("/server/private")).rejects.toThrow(
			"unavailable",
		);
		for (const method of Object.values(ipc))
			expect(method).not.toHaveBeenCalled();
	});
});
