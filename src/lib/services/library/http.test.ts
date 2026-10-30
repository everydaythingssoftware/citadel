import { describe, expect, it, vi } from "vitest";
import type { LibraryBook, LibraryBookQuery } from "@/bindings";
import { createHttpLibrary } from "./http";
import { CoverExpiredError } from "./types";

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
	language_list: [],
};
const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
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

	it("rejects writes/imports before issuing any request", async () => {
		const fetch = vi.fn();
		const library = createHttpLibrary({
			baseUrl: "https://citadel.test",
			fetch,
		});
		await expect(
			library.updateBook("7", {
				title: "Changed",
				author_id_list: null,
				tag_list: null,
				timestamp: null,
				publication_date: null,
				is_read: null,
				description: null,
				series: null,
				series_index: null,
				language_list: null,
			}),
		).rejects.toThrow("browsing and downloads only");
		await expect(
			library.checkFileImportable("/server/book.epub"),
		).rejects.toThrow("browsing and downloads only");
		expect(fetch).not.toHaveBeenCalled();
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
});
