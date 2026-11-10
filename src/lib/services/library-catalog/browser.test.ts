import { afterEach, describe, expect, it, vi } from "vitest";
import type { Options } from "../library";

const nativeInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: nativeInvoke }));

import { createWebLibrarySetup, webLibraryCatalog } from "./web";

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
				json({
					id: "configured-library",
					name: "Library",
					readOnly: false,
					canEdit: true,
				}),
			),
		);
		const library = await webLibraryCatalog.open(remote());
		expect(library.readOnly).toBe(false);
		expect(library.uploads).toBeDefined();
	});

	it("opens a writable library read-only for a view-only user", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				json({
					id: "configured-library",
					name: "Library",
					readOnly: false,
					canEdit: false,
				}),
			),
		);
		const library = await webLibraryCatalog.open(remote());
		expect(library.readOnly).toBe(true);
		expect(library.uploads).toBeUndefined();
	});

	it("checks the configured library before returning a read-only HTTP connection", async () => {
		const requests: Request[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (request: Request) => {
				requests.push(request);
				return new URL(request.url).pathname === "/api/library"
					? json({
							id: "configured-library",
							name: "Library",
							readOnly: true,
							canEdit: false,
						})
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

	it("reaches the setup routes with the session and passes the server's words through", async () => {
		const requests: Request[] = [];
		const bodies: unknown[] = [];
		const served = {
			id: "f0b2afca",
			name: "Shelf",
			path: "/srv/books",
			readOnly: false,
			available: true,
			problem: null,
			schemaVersion: 28,
			upgradeAvailable: false,
		};
		const inspection = {
			path: "/srv/books",
			name: "books",
			status: "missing",
			library: null,
			message: null,
		};
		const listing = {
			path: "/srv",
			parent: "/",
			entries: [{ name: "books", path: "/srv/books", isLibrary: false }],
		};
		const responses = [
			json({ library: null, browseRoot: "/home/citadel" }),
			json(inspection),
			json(listing),
			json(listing),
			json(served),
			json(
				{ code: "conflict", message: "This server already serves a library" },
				409,
			),
			json(served),
			json({ from: 26, to: 28, backup: "/srv/books/metadata.db.backup-26-1" }),
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (request: Request) => {
				requests.push(request);
				if (request.method === "POST" && request.headers.get("content-type"))
					bodies.push(await request.json());
				return responses.shift();
			}),
		);
		const setup = createWebLibrarySetup("https://citadel.test");
		expect(await setup.status()).toEqual({
			library: null,
			browseRoot: "/home/citadel",
		});
		expect(await setup.inspect("/srv/books")).toEqual(inspection);
		expect(bodies[0]).toEqual({ path: "/srv/books" });
		expect(await setup.listDirectory("/srv")).toEqual(listing);
		expect(requests[2]?.url).toBe(
			"https://citadel.test/api/setup/directories?path=%2Fsrv",
		);
		await setup.listDirectory();
		expect(requests[3]?.url).toBe("https://citadel.test/api/setup/directories");
		expect(
			await setup.choose({
				mode: "create",
				path: "/srv/books",
				name: "Shelf",
				upgrade: false,
			}),
		).toEqual(served);
		expect(bodies[1]).toEqual({
			mode: "create",
			path: "/srv/books",
			name: "Shelf",
			upgrade: false,
		});
		await expect(
			setup.choose({
				mode: "adopt",
				path: "/srv/other",
				name: null,
				upgrade: false,
			}),
		).rejects.toThrow("This server already serves a library");
		expect(await setup.reopen()).toEqual(served);
		expect((await setup.upgrade()).to).toBe(28);
	});
});
