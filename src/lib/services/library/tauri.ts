import {
	commands,
	type LibraryBook,
	type LibraryBookQuery,
	type LibraryError,
	type NewAuthor,
	type StagedFile,
} from "@/bindings";
import {
	BookDeletion,
	CoverExpiredError,
	type Library,
	type LocalBookImports,
	type StagedUpload,
	UploadError,
	UploadFailure,
} from "./types";

const unwrap = <T>(
	result: { status: "ok"; data: T } | { status: "error"; error: string },
): T => {
	if (result.status === "error") throw new Error(result.error);
	return result.data;
};

/** Files on this computer, staged by the backend where they are. */
export const createTauriBookImports = (): LocalBookImports => {
	const covers = new Map<string, string>();
	const staged = (file: StagedFile): StagedUpload => {
		if (file.book.coverUrl) covers.set(file.id, file.book.coverUrl);
		return {
			id: file.id,
			fileName: file.fileName,
			size: file.size,
			receivedBytes: file.size,
			book: file.book,
		};
	};
	const refused = (error: LibraryError) =>
		new UploadError(
			error.code === "invalidArgument" ||
				error.code === "notFound" ||
				error.code === "conflict"
				? UploadFailure.invalid
				: UploadFailure.server,
			error.message,
		);
	return {
		list: async () => {
			const result = await commands.clbQueryStagedBooks();
			if (result.status === "error") throw refused(result.error);
			return { uploads: result.data.map(staged) };
		},
		stage: async (path) => {
			const result = await commands.clbCmdStageBook(path);
			if (result.status === "error") throw refused(result.error);
			return staged(result.data);
		},
		coverUrl: (id) => covers.get(id) ?? "",
		commit: async (id, book) => {
			const result = await commands.clbCmdAddStagedBook(id, {
				title: book.title,
				authorNames: book.authorNames,
				identifier: book.identifier ?? null,
				publisher: book.publisher ?? null,
				language: book.language ?? null,
				tags: book.tags,
				publicationDate: book.publicationDate ?? null,
			});
			if (result.status === "error") throw new Error(result.error.message);
			covers.delete(id);
			return result.data;
		},
		cancel: async (id) => {
			await commands.clbCmdDiscardStagedBook(id);
			covers.delete(id);
		},
	};
};

export const createTauriLibrary = (): Library => {
	const bookCoverCache = new Map<
		LibraryBook["id"],
		{
			localPath: string;
			url: string;
		}
	>();
	const bookFilePath = new Map<
		LibraryBook["id"],
		{
			localPath: string;
			url: undefined;
		}
	>();

	return {
		readOnly: false,
		bookDeletion: BookDeletion.trash,
		uploads: createTauriBookImports(),
		listCustomColumns: async () =>
			unwrap(await commands.clbQueryListCustomColumns()),
		getCustomValuesForBook: async (id) =>
			unwrap(await commands.clbQueryGetCustomValuesForBook(id)),
		setCustomValue: async (id, columnId, value) => {
			unwrap(await commands.clbCmdSetCustomValue(id, columnId, value));
		},
		addBookGenres: async (id, genres) => {
			unwrap(await commands.clbCmdAddBookGenres(id, genres));
		},
		setBookCoverFromMetadata: async (id, coverId) => {
			const result = await commands.clbCmdSetBookCoverFromMetadata(id, coverId);
			if (
				result.status === "error" &&
				result.error === new CoverExpiredError().message
			)
				throw new CoverExpiredError();
			unwrap(result);
		},
		setBookCoverFromFile: async (id, image) => {
			const bytes = Array.from(new Uint8Array(await image.arrayBuffer()));
			unwrap(await commands.clbCmdSetBookCoverFromFile(id, bytes));
		},
		createAuthors: async (authorList: NewAuthor[]) => {
			const results = await commands.clbCmdCreateAuthors(authorList);
			if (results.status === "error") {
				throw new Error(results.error);
			}
			return results.data;
		},
		queryBooks: async (query: LibraryBookQuery) => {
			const results = await commands.clbQueryBooks(query);
			if (results.status === "error") {
				throw new Error(results.error.message);
			}

			for (const book of results.data.items) {
				bookCoverCache.set(book.id.toString(), {
					localPath: book.cover_image?.local_path ?? "",
					url: book.cover_image?.url ?? "",
				});
				const primaryFile = book.file_list[0];
				if (primaryFile !== undefined && "Local" in primaryFile) {
					bookFilePath.set(book.id.toString(), {
						localPath: primaryFile.Local.path,
						url: undefined,
					});
				}
			}

			return results.data;
		},
		ensureCoverThumbnails: async (bookIds) => {
			const results = await commands.clbCmdEnsureCoverThumbnails(bookIds);
			if (results.status === "error") {
				throw new Error(results.error);
			}
			return results.data;
		},
		listCoverThumbnails: async () => {
			const results = await commands.clbQueryListCoverThumbnails();
			if (results.status === "error") {
				throw new Error(results.error);
			}
			return results.data;
		},
		warmCoverThumbnails: async () => {
			const results = await commands.clbCmdWarmCoverThumbnails();
			if (results.status === "error") {
				throw new Error(results.error);
			}
			return results.data;
		},
		getBook: async (bookId) => {
			const result = await commands.clbQueryGetBook(bookId);
			if (result.status === "error") {
				throw new Error(result.error.message);
			}

			const book = result.data;
			bookCoverCache.set(book.id.toString(), {
				localPath: book.cover_image?.local_path ?? "",
				url: book.cover_image?.url ?? "",
			});
			const primaryFile = book.file_list[0];
			if (primaryFile !== undefined && "Local" in primaryFile) {
				bookFilePath.set(book.id.toString(), {
					localPath: primaryFile.Local.path,
					url: undefined,
				});
			}

			return book;
		},
		listAuthors: async () => {
			const results = await commands.clbQueryListAllAuthors();
			if (results.status === "error") {
				throw new Error(results.error);
			}
			return results.data;
		},
		listSeries: async () => {
			const results = await commands.clbQueryListSeries();
			if (results.status === "error") {
				throw new Error(results.error);
			}
			return results.data;
		},
		listTags: async () => {
			const results = await commands.clbQueryListTags();
			if (results.status === "error") {
				throw new Error(results.error);
			}
			return results.data;
		},
		listPublishers: async () => {
			const results = await commands.clbQueryListPublishers();
			if (results.status === "error") {
				throw new Error(results.error);
			}
			return results.data;
		},
		sendToDevice: () => {
			throw new Error("Not implemented");
		},
		updateBook: async (bookId, updates) => {
			const result = await commands.clbCmdUpdateBook(bookId, updates);
			if (result.status === "error") {
				throw new Error(result.error);
			}
		},
		updateAuthor: async (authorId, updates) => {
			const result = await commands.clbCmdUpdateAuthor(authorId, updates);
			if (result.status === "error") {
				throw new Error(result.error);
			}
		},
		deleteAuthor: async (authorId) => {
			const result = await commands.clbCmdDeleteAuthor(authorId);
			if (result.status === "error") {
				throw new Error(result.error);
			}
		},
		deleteBooks: async (bookIds) => {
			const result = await commands.clbCmdDeleteBooks(bookIds);
			if (result.status === "error") {
				throw new Error(result.error);
			}
			return result.data;
		},
		upsertBookIdentifier: async (bookId, identifierId, label, value) => {
			const result = await commands.clbCmdUpsertBookIdentifier(
				bookId,
				label,
				value,
				identifierId,
			);
			if (result.status === "error") {
				throw new Error(result.error);
			}
		},
		deleteBookIdentifier: async (bookId, identifierId) => {
			const result = await commands.clbCmdDeleteBookIdentifier(
				bookId,
				identifierId,
			);
			if (result.status === "error") {
				throw new Error(result.error);
			}
		},
		getCoverPathForBook: (bookId) => {
			return bookCoverCache.get(bookId)?.localPath;
		},
		getCoverUrlForBook: (bookId) => {
			return bookCoverCache.get(bookId)?.url;
		},
		getDefaultFilePathForBook: (bookId) => {
			return bookFilePath.get(bookId)?.localPath;
		},
	};
};
