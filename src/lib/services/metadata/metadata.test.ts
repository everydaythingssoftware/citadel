import { beforeEach, describe, expect, it, vi } from "vitest";
const ipc = vi.hoisted(() => ({
	clbQueryMetadataSearch: vi.fn(),
	clbQueryMetadataByIsbn: vi.fn(),
	clbCmdTestMetadataProvider: vi.fn(),
}));
vi.mock("@/bindings", () => ({ commands: ipc }));
import { tauriMetadataService } from "./tauri";
import { createWebMetadataService } from "./web";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});

describe("Metadata transport", () => {
	beforeEach(() => vi.resetAllMocks());
	it("preserves provider selection, credentials and provider-reported failures", async () => {
		ipc.clbQueryMetadataSearch.mockResolvedValue({ status: "ok", data: [] });
		expect(
			await tauriMetadataService.search("hardcover", "a title", "key"),
		).toEqual([]);
		expect(ipc.clbQueryMetadataSearch).toHaveBeenCalledWith(
			"hardcover",
			"a title",
			"key",
		);
		ipc.clbCmdTestMetadataProvider.mockResolvedValue({
			status: "error",
			error: "invalid key",
		});
		expect(await tauriMetadataService.test("hardcover", "bad")).toEqual({
			ok: false,
			message: "invalid key",
		});
		ipc.clbQueryMetadataByIsbn.mockResolvedValue({
			status: "error",
			error: "provider unavailable",
		});
		await expect(
			tauriMetadataService.byIsbn("loc", "9781234567890", ""),
		).rejects.toThrow("provider unavailable");
	});
	it("looks up through the server in a browser, never sending a key or invoking Tauri", async () => {
		const requests: Request[] = [];
		const web = createWebMetadataService({
			baseUrl: "https://citadel.test",
			fetch: async (request) => {
				requests.push(request);
				const url = new URL(request.url);
				if (url.pathname === "/api/metadata/providers")
					return json([
						{
							provider: "hardcover",
							displayName: "Hardcover",
							requiresKey: true,
							available: false,
							unavailableReason: "Not set up",
						},
					]);
				if (url.pathname.endsWith("/test"))
					return json({ provider: "loc", is_valid: true, message: "ok" });
				if (url.searchParams.get("q") === "busy")
					return json(
						{ code: "rateLimited", message: "Too many lookups" },
						429,
					);
				return json([]);
			},
		});
		expect(web.credentials).toBe("server");
		expect(await web.search("openlibrary", "a title", "ignored")).toEqual([]);
		expect(await web.byIsbn("loc", "9781234567890", "ignored")).toEqual([]);
		await expect(web.search("loc", "busy", "")).rejects.toThrow(
			"Too many lookups",
		);
		expect(await web.test("loc", "")).toEqual({ ok: true, message: "ok" });
		expect(await web.availability()).toEqual([
			{ provider: "hardcover", available: false, reason: "Not set up" },
		]);
		const urls = requests.map((request) => new URL(request.url));
		expect(urls[0]?.pathname).toBe("/api/metadata/search");
		expect(urls[0]?.searchParams.get("provider")).toBe("openlibrary");
		expect(urls[1]?.pathname).toBe("/api/metadata/isbn/9781234567890");
		for (const url of urls) expect(url.search).not.toContain("ignored");
		expect(web.coverPreviewUrl("abc/def")).toBe(
			"https://citadel.test/api/metadata/covers/abc%2Fdef/preview",
		);
		for (const method of Object.values(ipc))
			expect(method).not.toHaveBeenCalled();
	});
});
