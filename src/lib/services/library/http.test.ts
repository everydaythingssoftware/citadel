import { describe, expect, it, vi } from "vitest";
import type { BookEdit, LibraryBook, LibraryBookQuery } from "@/bindings";
import { ServerUnreachableError } from "@/lib/api/client";
import { createHttpLibrary } from "./http";
import { CoverExpiredError, DeviceType, UnknownOutcomeError } from "./types";

const query: LibraryBookQuery = {
	text: "search",
	author_id: "1",
	series_id: null,
	tag_id: 2,
	publisher_id: null,
	hide_read: false,
	sort: "AuthorAsc",
	limit: 100,
	offset: 200,
};
const book: LibraryBook = {
	id: "7",
	uuid: null,
	title: "A book",
	author_list: [],
	tag_list: [],
	sortable_title: null,
	file_list: [{ Remote: { url: "/api/books/7/files/epub/A%20book.epub" } }],
	cover_image: {
		kind: "Remote",
		local_path: null,
		url: "/api/books/7/cover",
	},
	identifier_list: [],
	description: null,
	is_read: false,
	series: null,
	series_index: null,
	publisher: null,
	language_list: [],
	added_at: "2025-03-12T10:00:00Z",
};
const edit: BookEdit = {
	book_id: "7",
	series: null,
	add_tags: ["Epic"],
	remove_tags: [],
	add_languages: [],
	remove_languages: [],
	publisher: null,
};
const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
const html = (status: number) =>
	new Response("<html><body>Proxy error</body></html>", {
		status,
		headers: { "content-type": "text/html" },
	});

describe("HTTP Library", () => {
	it("preserves paged search/facets and resolves cover/download URLs without local paths", async () => {
		const requests: Request[] = [];
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async (request) => {
				requests.push(request);
				return request.method === "POST"
					? json({ items: [book], total: 300 })
					: json({ ...book, cover_image: null });
			},
		});
		const page = await library.queryBooks(query);
		expect(requests[0]?.url).toBe("https://citadel.test/api/books/query");
		expect(await requests[0]?.json()).toEqual(query);
		expect(page.total).toBe(300);
		expect(page.items[0]?.cover_image?.url).toBe(
			"https://citadel.test/api/books/7/cover",
		);
		expect(page.items[0]?.file_list[0]).toEqual({
			Remote: {
				url: "https://citadel.test/api/books/7/files/epub/A%20book.epub",
			},
		});
		expect(library.getCoverUrlForBook("7")).toBe(
			"https://citadel.test/api/books/7/cover",
		);
		expect(library.getCoverPathForBook("7")).toBeUndefined();
		expect(library.getDefaultFilePathForBook("7")).toBeUndefined();
		await library.getBook("7");
		expect(requests[1]?.url).toBe("https://citadel.test/api/books/7");
		expect(library.getCoverUrlForBook("7")).toBeUndefined();
	});

	it.each([
		null,
		250,
	])("pages a series request with limit %s within the HTTP bound", async (limit) => {
		const bodies: LibraryBookQuery[] = [];
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async (request) => {
				const body = (await request.json()) as LibraryBookQuery;
				bodies.push(body);
				const offset = body.offset ?? 0;
				const length = Math.min(body.limit ?? 0, 451 - offset);
				return json({
					items: Array.from({ length }, (_, index) => ({
						...book,
						id: String(offset + index + 1),
					})),
					total: 451,
				});
			},
		});
		const result = await library.queryBooks({
			...query,
			series_id: 8,
			limit,
			offset: 1,
		});
		expect(result.total).toBe(451);
		expect(result.items).toHaveLength(limit ?? 450);
		expect(result.items[0]?.id).toBe("2");
		expect(result.items.at(-1)?.id).toBe(String((limit ?? 450) + 1));
		expect(bodies.map(({ limit, offset }) => ({ limit, offset }))).toEqual(
			limit === null
				? [
						{ limit: 200, offset: 1 },
						{ limit: 200, offset: 201 },
						{ limit: 200, offset: 401 },
					]
				: [
						{ limit: 200, offset: 1 },
						{ limit: 50, offset: 201 },
					],
		);
		for (const body of bodies)
			expect(body).toMatchObject({
				...query,
				series_id: 8,
				limit: expect.any(Number),
				offset: expect.any(Number),
			});
	});

	it("preserves a count-only query without fetching books", async () => {
		const bodies: LibraryBookQuery[] = [];
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async (request) => {
				bodies.push((await request.json()) as LibraryBookQuery);
				return json({ items: [], total: 451 });
			},
		});
		const countQuery = { ...query, limit: 0 };
		expect(await library.queryBooks(countQuery)).toEqual({
			items: [],
			total: 451,
		});
		expect(bodies).toEqual([countQuery]);
	});

	it("routes facet and custom-field reads through the generated HTTP contract", async () => {
		const paths: string[] = [];
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async (request) => {
				paths.push(new URL(request.url).pathname);
				return json([]);
			},
		});
		await library.listAuthors();
		await library.listSeries();
		await library.listTags();
		await library.listPublishers();
		await library.listCustomColumns();
		await library.getCustomValuesForBook("7");
		expect(paths).toEqual([
			"/api/authors",
			"/api/series",
			"/api/tags",
			"/api/publishers",
			"/api/custom-columns",
			"/api/books/7/custom-values",
		]);
	});

	it("batches thumbnail requests and leaves whole-library warming to the server", async () => {
		const batches: string[][] = [];
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async (request) => {
				if (request.method === "GET") return json([]);
				const { book_ids } = (await request.json()) as { book_ids: string[] };
				batches.push(book_ids);
				return json(
					book_ids.map((id) => ({
						book_id: id,
						url: `/api/books/${id}/thumbnail`,
						width: 200,
						height: 300,
					})),
				);
			},
		});
		const thumbs = await library.ensureCoverThumbnails(
			Array.from({ length: 201 }, (_, index) => String(index + 1)),
		);
		expect(batches.map((batch) => batch.length)).toEqual([200, 1]);
		expect(thumbs).toHaveLength(201);
		expect(thumbs[0]?.url).toBe("https://citadel.test/api/books/1/thumbnail");
		expect(await library.listCoverThumbnails()).toEqual([]);
		expect(await library.warmCoverThumbnails()).toEqual([]);
	});

	it("propagates structured authentication and library errors", async () => {
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async () =>
				json({ code: "unauthorized", message: "Authentication required" }, 401),
		});
		await expect(library.queryBooks(query)).rejects.toThrow(
			"Authentication required",
		);
		await expect(library.listAuthors()).rejects.toThrow(
			"Authentication required",
		);
	});

	it("keeps devices to the desktop", async () => {
		const fetch = vi.fn();
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch,
		});
		await expect(
			library.sendToDevice({} as LibraryBook, {
				type: DeviceType.externalDrive,
				path: "/Volumes/Kindle",
			}),
		).rejects.toThrow("isn't available in the browser");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("edits books and authors through the HTTP contract", async () => {
		const requests: Request[] = [];
		const library = createHttpLibrary(
			{
				baseUrl: "https://citadel.test",
				fetch: async (request) => {
					requests.push(request.clone());
					return request.url.endsWith("/api/authors")
						? json([
								{ id: "9", name: "New", sortable_name: "New", book_count: 0 },
							])
						: new Response(null, { status: 204 });
				},
			},
			{ writable: true },
		);
		expect(library.readOnly).toBe(false);
		const update = {
			title: "Changed",
			author_id_list: ["1", "9"],
			tag_list: null,
			timestamp: null,
			publication_date: null,
			is_read: true,
			description: null,
			series: null,
			series_index: null,
			language_list: null,
		};
		await library.updateBook("7", update);
		await library.updateAuthor("9", {
			full_name: "Renamed",
			sortable_name: null,
			external_url: null,
		});
		expect(
			await library.createAuthors([{ name: "New", sortable_name: null }]),
		).toEqual([{ id: "9", name: "New", sortable_name: "New", book_count: 0 }]);
		await library.upsertBookIdentifier("7", null, "isbn", "9780000000002");
		await library.upsertBookIdentifier("7", 4, "isbn", "9780000000019");
		await library.deleteBookIdentifier("7", 4);
		await library.setCustomValue("7", 3, { Text: "Signed" });
		await library.setCustomValue("7", 3, null);
		await library.addBookGenres("7", ["Fiction"]);

		const sent = await Promise.all(
			requests.map(async (request) => ({
				method: request.method,
				path: new URL(request.url).pathname,
				body: request.method === "DELETE" ? null : await request.json(),
			})),
		);
		expect(sent).toEqual([
			{ method: "PATCH", path: "/api/books/7", body: update },
			{
				method: "PATCH",
				path: "/api/authors/9",
				body: { full_name: "Renamed", sortable_name: null, external_url: null },
			},
			{
				method: "POST",
				path: "/api/authors",
				body: { authors: [{ name: "New", sortable_name: null }] },
			},
			{
				method: "POST",
				path: "/api/books/7/identifiers",
				body: { label: "isbn", value: "9780000000002", existing_id: null },
			},
			{
				method: "POST",
				path: "/api/books/7/identifiers",
				body: { label: "isbn", value: "9780000000019", existing_id: 4 },
			},
			{ method: "DELETE", path: "/api/books/7/identifiers/4", body: null },
			{
				method: "PUT",
				path: "/api/books/7/custom-values/3",
				body: { value: { Text: "Signed" } },
			},
			{
				method: "PUT",
				path: "/api/books/7/custom-values/3",
				body: { value: null },
			},
			{
				method: "POST",
				path: "/api/books/7/genres",
				body: { genres: ["Fiction"] },
			},
		]);
	});

	it("surfaces the server's message when an edit is refused", async () => {
		const library = createHttpLibrary(
			{
				baseUrl: "https://citadel.test",
				fetch: async () =>
					json(
						{ code: "invalidArgument", message: "Unknown author id '-1'" },
						400,
					),
			},
			{ writable: true },
		);
		await expect(
			library.updateAuthor("1", {
				full_name: "X",
				sortable_name: null,
				external_url: null,
			}),
		).rejects.toThrow("Unknown author id '-1'");
		await expect(library.addBookGenres("7", ["Fiction"])).rejects.toThrow(
			"Unknown author id '-1'",
		);
	});

	it("reports the status when the error body of a write is not JSON", async () => {
		const library = createHttpLibrary(
			{ baseUrl: "https://citadel.test", fetch: async () => html(413) },
			{ writable: true },
		);
		await expect(library.addBookGenres("7", ["Fiction"])).rejects.toThrow(
			"Library request failed (413)",
		);
	});

	it("reports the status when the error body of a cover write is not JSON", async () => {
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async () => html(413),
		});
		await expect(
			library.setBookCoverFromMetadata("7", "cover-1"),
		).rejects.toThrow("Library request failed (413)");
		await expect(
			library.setBookCoverFromFile("7", new Blob([], { type: "image/jpeg" })),
		).rejects.toThrow("Library request failed (413)");
	});

	it("reports an expired cover when the 410 body is not JSON", async () => {
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async () => html(410),
		});
		await expect(
			library.setBookCoverFromMetadata("7", "stale"),
		).rejects.toThrow(new CoverExpiredError());
	});

	it("reports an expired cover with the default message when the 410 body has no text message", async () => {
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async () => json({ code: "notFound", message: 42 }, 410),
		});
		await expect(
			library.setBookCoverFromMetadata("7", "stale"),
		).rejects.toThrow(new CoverExpiredError());
	});

	it("sets covers by cover ID or uploaded image, never by URL", async () => {
		const requests: Request[] = [];
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async (request) => {
				requests.push(request.clone());
				if (request.method === "POST") {
					const { coverId } = (await request.json()) as { coverId: string };
					return coverId === "stale"
						? json({ code: "notFound", message: "Search again" }, 410)
						: new Response(null, { status: 204 });
				}
				return new Response(null, { status: 204 });
			},
		});
		await library.setBookCoverFromMetadata("7", "cover-1");
		await expect(
			library.setBookCoverFromMetadata("7", "stale"),
		).rejects.toBeInstanceOf(CoverExpiredError);
		const image = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], {
			type: "image/jpeg",
		});
		await library.setBookCoverFromFile("7", image);

		expect(requests.map((request) => request.method)).toEqual([
			"POST",
			"POST",
			"PUT",
		]);
		expect(new URL(requests[0]?.url ?? "").pathname).toBe("/api/books/7/cover");
		expect(await requests[0]?.json()).toEqual({ coverId: "cover-1" });
		const upload = requests[2];
		expect(upload?.headers.get("content-type")).toBe("image/jpeg");
		expect(new Uint8Array(await (upload as Request).arrayBuffer())).toEqual(
			new Uint8Array([0xff, 0xd8, 0xff]),
		);
	});

	it("deletes books and authors permanently through the HTTP contract", async () => {
		const requests: Request[] = [];
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async (request) => {
				requests.push(request);
				return request.method === "DELETE"
					? new Response(null, { status: 204 })
					: json({ deleted: 2, folder_failures: ["Author/Book (8): busy"] });
			},
		});
		expect(library.bookDeletion).toBe("permanent");
		expect(await library.deleteBooks(["7", "8"])).toEqual({
			deleted: 2,
			folder_failures: ["Author/Book (8): busy"],
		});
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.url).toBe("https://citadel.test/api/books/delete");
		expect(await requests[0]?.json()).toEqual({ book_ids: ["7", "8"] });
		await library.deleteAuthor("3");
		expect(requests[1]?.method).toBe("DELETE");
		expect(requests[1]?.url).toBe("https://citadel.test/api/authors/3");
	});

	it("reports a read-only library's refusal to delete", async () => {
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async () =>
				json({ code: "readOnly", message: "This library is read-only" }, 403),
		});
		await expect(library.deleteBooks(["7"])).rejects.toThrow(
			"This library is read-only",
		);
		await expect(library.deleteAuthor("3")).rejects.toThrow(
			"This library is read-only",
		);
	});

	it("sends every edit in one request and gives back the undo edits", async () => {
		const requests: Request[] = [];
		const undo: BookEdit[] = [{ ...edit, add_tags: [], remove_tags: ["Epic"] }];
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async (request) => {
				requests.push(request);
				return json({ undo });
			},
		});
		expect(await library.editBooks([edit])).toEqual({ undo });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.url).toBe("https://citadel.test/api/books/edit");
		expect(await requests[0]?.json()).toEqual({ edits: [edit] });
	});

	it.each([
		["a 502", () => html(502)],
		["a 504", () => html(504)],
		[
			"a 503 that timed out",
			() => json({ code: "timedOut", message: "Too slow" }, 503),
		],
		["a 503 with an HTML body", () => html(503)],
	])("reports an unknown outcome for %s", async (_, answer) => {
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async () => answer(),
		});
		const failure = library.editBooks([edit]);
		await expect(failure).rejects.toBeInstanceOf(UnknownOutcomeError);
		await expect(failure).rejects.toThrow(
			"No answer from the server. Some books may have changed.",
		);
	});

	it("keeps the status as the cause of an unknown outcome", async () => {
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async () => html(504),
		});
		const logged = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const failure = await library
			.editBooks([edit])
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(UnknownOutcomeError);
		const cause = (failure as Error).cause;
		expect(cause).toEqual(new Error("Library request failed (504)"));
		expect(logged).toHaveBeenCalledWith(expect.any(String), cause);
		logged.mockRestore();
	});

	it("reports a 503 that refuses the edit before any work as a plain error", async () => {
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async () =>
				json({ code: "unavailable", message: "Library unavailable" }, 503),
		});
		const failure = library.editBooks([edit]);
		await expect(failure).rejects.toThrow("Library unavailable");
		await expect(failure).rejects.not.toBeInstanceOf(UnknownOutcomeError);
	});

	it("reports an unknown outcome for a failed fetch", async () => {
		const offline = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async () => {
				throw new TypeError("Failed to fetch");
			},
		});
		await expect(offline.editBooks([edit])).rejects.toBeInstanceOf(
			UnknownOutcomeError,
		);
	});

	it("keeps the error of a failed fetch as the cause of an unknown outcome", async () => {
		const offlineError = new TypeError("Failed to fetch");
		const offline = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async () => {
				throw offlineError;
			},
		});
		const logged = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const failure = await offline
			.editBooks([edit])
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(UnknownOutcomeError);
		expect((failure as Error).message).toBe(
			"No answer from the server. Some books may have changed.",
		);
		const cause = (failure as Error).cause;
		expect(cause).toBeInstanceOf(ServerUnreachableError);
		expect((cause as Error).cause).toBe(offlineError);
		expect(logged).toHaveBeenCalledWith(expect.any(String), cause);
		logged.mockRestore();
	});

	it("reports the status of an edit refusal whose body is not JSON", async () => {
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async () => html(413),
		});
		const failure = library.editBooks([edit]);
		await expect(failure).rejects.toThrow("Library request failed (413)");
		await expect(failure).rejects.not.toBeInstanceOf(UnknownOutcomeError);
	});

	it.each([
		[400, "invalidArgument", "Unknown book id '99'"],
		[403, "readOnly", "This library is read-only"],
		[413, "tooLarge", "Payload Too Large"],
		[500, "internal", "Library operation failed"],
	])("reports a %i refusal of an edit as a plain error", async (status, code, message) => {
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch: async () => json({ code, message }, status),
		});
		const failure = library.editBooks([edit]);
		await expect(failure).rejects.toThrow(message);
		await expect(failure).rejects.not.toBeInstanceOf(UnknownOutcomeError);
	});
});
