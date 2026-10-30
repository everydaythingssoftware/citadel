import {
	commands,
	type ImportableBookMetadata,
	type ImportableFile,
	type LibraryBook,
	type LibraryBookQuery,
	type NewAuthor,
} from "@/bindings";
import { BookDeletion, CoverExpiredError, type Library } from "./types";

const unwrap = <T>(
	result: { status: "ok"; data: T } | { status: "error"; error: string },
): T => {
	if (result.status === "error") throw new Error(result.error);
	return result.data;
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

		checkFileImportable: async (filePath: string) => {
			const result =
				(await commands.clbQueryIsFileImportable(filePath)) ?? undefined;
			return result;
		},
		getImportableFileMetadata: async (importableFile: ImportableFile) => {
			const result =
				(await commands.clbQueryImportableFileMetadata(importableFile)) ??
				undefined;
			return result;
		},
		addImportableFileByMetadata: async (metadata: ImportableBookMetadata) => {
			const result = await commands.clbCmdCreateBook(metadata);
			if (result.status === "error") {
				throw new Error(result.error);
			}
			return result.data;
		},
		listValidFileTypes: async () => {
			const result = await commands.clbQueryListAllFiletypes();
			return result.map(([mimetype, extension]) => ({
				extension,
				mimetype,
			}));
		},
	};
};
