import type { ClientOptions } from "openapi-fetch";
import type { CoverThumbnail, LibraryBook } from "@/bindings";
import { createCitadelHttpClient } from "@/lib/api/client";
import { BookDeletion, CoverExpiredError, type Library } from "./types";
import { createHttpUploads } from "./uploads-http";

const unsupported = async (): Promise<never> => {
	throw new Error("This isn't available in the browser");
};

const unwrap = async <T>(
	request: Promise<{
		data?: T;
		error?: { message: string };
		response: Response;
	}>,
): Promise<T> => {
	const { data, error, response } = await request;
	if (error) throw new Error(error.message);
	if (!response.ok || data === undefined)
		throw new Error(`Library request failed (${response.status})`);
	return data;
};

/** For writes that answer 204 No Content, where openapi-fetch has no data. */
const succeed = async (
	request: Promise<{ error?: { message: string }; response: Response }>,
): Promise<void> => {
	const { error, response } = await request;
	if (error) throw new Error(error.message);
	if (!response.ok)
		throw new Error(`Library request failed (${response.status})`);
};

export const createHttpLibrary = (
	options: ClientOptions & { baseUrl: string },
	/** Whether the server opened its library for writing: editing and uploads. */
	{ writable = false }: { writable?: boolean } = {},
): Library => {
	const client = createCitadelHttpClient(options);
	const covers = new Map<string, string>();
	const assetUrl = (path: string): string =>
		new URL(path, options.baseUrl).toString();
	const rememberBook = (book: LibraryBook): LibraryBook => {
		const cover = book.cover_image;
		if (cover) covers.set(book.id, assetUrl(cover.url));
		else covers.delete(book.id);
		return {
			...book,
			cover_image: cover ? { ...cover, url: assetUrl(cover.url) } : null,
			file_list: book.file_list.map((file) =>
				"Remote" in file
					? { Remote: { ...file.Remote, url: assetUrl(file.Remote.url) } }
					: file,
			),
		};
	};
	const thumbnails = (items: CoverThumbnail[]): CoverThumbnail[] =>
		items.map((item) => ({ ...item, url: assetUrl(item.url) }));

	return {
		readOnly: !writable,
		bookDeletion: BookDeletion.permanent,
		uploads: writable
			? createHttpUploads(client, options.baseUrl, rememberBook)
			: undefined,
		queryBooks: async (query) => {
			if (query.limit !== null && query.limit <= 200) {
				const page = await unwrap(
					client.POST("/api/books/query", { body: query }),
				);
				return { ...page, items: page.items.map(rememberBook) };
			}

			const items: LibraryBook[] = [];
			const offset = query.offset ?? 0;
			const requestedLimit = query.limit ?? Number.POSITIVE_INFINITY;
			let total = 0;
			while (items.length < requestedLimit) {
				const page = await unwrap(
					client.POST("/api/books/query", {
						body: {
							...query,
							limit: Math.min(200, requestedLimit - items.length),
							offset: offset + items.length,
						},
					}),
				);
				total = page.total;
				items.push(...page.items.map(rememberBook));
				if (page.items.length === 0 || offset + items.length >= total) break;
			}
			return { items, total };
		},
		getBook: async (bookId) =>
			rememberBook(
				await unwrap(
					client.GET("/api/books/{book_id}", {
						params: { path: { book_id: bookId } },
					}),
				),
			),
		listAuthors: () => unwrap(client.GET("/api/authors")),
		listSeries: () => unwrap(client.GET("/api/series")),
		listTags: () => unwrap(client.GET("/api/tags")),
		listPublishers: () => unwrap(client.GET("/api/publishers")),
		listCustomColumns: () => unwrap(client.GET("/api/custom-columns")),
		getCustomValuesForBook: (bookId) =>
			unwrap(
				client.GET("/api/books/{book_id}/custom-values", {
					params: { path: { book_id: bookId } },
				}),
			),
		ensureCoverThumbnails: async (bookIds) => {
			const result: CoverThumbnail[] = [];
			for (let start = 0; start < bookIds.length; start += 200) {
				result.push(
					...thumbnails(
						await unwrap(
							client.POST("/api/covers/thumbnails", {
								body: { book_ids: bookIds.slice(start, start + 200) },
							}),
						),
					),
				);
			}
			return result;
		},
		listCoverThumbnails: async () =>
			thumbnails(await unwrap(client.GET("/api/covers/thumbnails"))),
		// HTTP clients request thumbnails for visible pages, not the entire server library.
		warmCoverThumbnails: async () => [],
		getCoverUrlForBook: (id) => covers.get(id),
		getCoverPathForBook: () => undefined,
		getDefaultFilePathForBook: () => undefined,
		setCustomValue: (bookId, columnId, value) =>
			succeed(
				client.PUT("/api/books/{book_id}/custom-values/{column_id}", {
					params: { path: { book_id: bookId, column_id: columnId } },
					body: { value },
				}),
			),
		addBookGenres: (bookId, genres) =>
			succeed(
				client.POST("/api/books/{book_id}/genres", {
					params: { path: { book_id: bookId } },
					body: { genres },
				}),
			),
		setBookCoverFromMetadata: async (bookId, coverId) => {
			const { error, response } = await client.POST(
				"/api/books/{book_id}/cover",
				{
					params: { path: { book_id: bookId } },
					body: { coverId },
				},
			);
			if (response.status === 410) throw new CoverExpiredError(error?.message);
			if (error) throw new Error(error.message);
			if (!response.ok)
				throw new Error(`Library request failed (${response.status})`);
		},
		setBookCoverFromFile: async (bookId, image) => {
			const { error, response } = await client.PUT(
				"/api/books/{book_id}/cover",
				{
					params: { path: { book_id: bookId } },
					body: image as unknown as number[],
					bodySerializer: (body) => body as unknown as Blob,
					headers: { "content-type": image.type || "application/octet-stream" },
				},
			);
			if (error) throw new Error(error.message);
			if (!response.ok)
				throw new Error(`Library request failed (${response.status})`);
		},
		createAuthors: (authors) =>
			unwrap(client.POST("/api/authors", { body: { authors } })),
		// Devices and local files are on the desktop's side; a browser has no path to name.
		sendToDevice: unsupported,
		updateBook: (bookId, updates) =>
			succeed(
				client.PATCH("/api/books/{book_id}", {
					params: { path: { book_id: bookId } },
					body: updates,
				}),
			),
		updateAuthor: (authorId, updates) =>
			succeed(
				client.PATCH("/api/authors/{author_id}", {
					params: { path: { author_id: authorId } },
					body: updates,
				}),
			),
		deleteAuthor: (authorId) =>
			succeed(
				client.DELETE("/api/authors/{author_id}", {
					params: { path: { author_id: authorId } },
				}),
			),
		deleteBooks: (bookIds) =>
			unwrap(client.POST("/api/books/delete", { body: { book_ids: bookIds } })),
		deleteBookIdentifier: (bookId, identifierId) =>
			succeed(
				client.DELETE("/api/books/{book_id}/identifiers/{identifier_id}", {
					params: {
						path: { book_id: bookId, identifier_id: identifierId },
					},
				}),
			),
		upsertBookIdentifier: (bookId, identifierId, label, value) =>
			succeed(
				client.POST("/api/books/{book_id}/identifiers", {
					params: { path: { book_id: bookId } },
					body: { label, value, existing_id: identifierId },
				}),
			),
		checkFileImportable: unsupported,
		getImportableFileMetadata: unsupported,
		addImportableFileByMetadata: unsupported,
		listValidFileTypes: unsupported,
	};
};
