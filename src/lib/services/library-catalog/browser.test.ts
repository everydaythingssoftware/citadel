import { afterEach, describe, expect, it, vi } from "vitest";
import type { Options } from "../library";

const nativeInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: nativeInvoke }));

import { webLibraryCatalog } from "./web";

const remote = (url = "https://citadel.test"): Options => ({
	libraryType: "calibre",
	connectionType: "remote",
	url,
});
const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});

afterEach(() => {
	expect(nativeInvoke).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("browser library catalog", () => {
	it("offers uploads when the server opened its library for writing", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				json({ id: "configured-library", name: "Library", readOnly: false }),
			),
		);
		const library = await webLibraryCatalog.open(remote());
		expect(library.uploads).toBeDefined();
	});

	it("checks the configured library before returning a read-only HTTP connection", async () => {
		const requests: Request[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (request: Request) => {
				requests.push(request);
				return new URL(request.url).pathname === "/api/library"
					? json({ id: "configured-library", name: "Library", readOnly: true })
					: json([
							{
								id: "1",
								name: "An Author",
								sortable_name: "Author, An",
								book_count: 1,
							},
						]);
			}),
		);

		const library = await webLibraryCatalog.open(remote());
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://citadel.test/api/library");
		expect(requests[0]?.credentials).toBe("same-origin");
		expect(library.readOnly).toBe(true);
		expect(library.uploads).toBeUndefined();
		expect(await library.listAuthors()).toEqual([
			{
				id: "1",
				name: "An Author",
				sortable_name: "Author, An",
				book_count: 1,
			},
		]);
		expect(requests[1]?.url).toBe("https://citadel.test/api/authors");
		expect(requests[1]?.credentials).toBe("same-origin");
	});

	it("propagates a sign-in failure without returning a library", async () => {
		const fetch = vi.fn(async () =>
			json({ code: "unauthorized", message: "Sign in to Citadel" }, 401),
		);
		vi.stubGlobal("fetch", fetch);
		await expect(webLibraryCatalog.open(remote())).rejects.toThrow(
			"Sign in to Citadel",
		);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it.each([
		"file:///server/private/library",
		"javascript:alert(1)",
		"https://reader:secret@citadel.test",
		"https://reader@citadel.test",
		"not a URL",
	])("rejects invalid server URL %s before any request", async (url) => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(webLibraryCatalog.open(remote(url))).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects local paths instead of opening a server filesystem location", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(
			webLibraryCatalog.open({
				libraryType: "calibre",
				connectionType: "local",
				libraryPath: "/server/private/library",
			}),
		).rejects.toThrow("Local library management is unavailable in the browser");
		expect(fetch).not.toHaveBeenCalled();
	});
});
