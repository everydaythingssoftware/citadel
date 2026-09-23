import {
	commands,
	type ImportableBookMetadata,
	type ImportableFile,
	type LibraryBook,
	type LibraryBookQuery,
	type NewAuthor,
	type RemoteFile,
} from "@/bindings";
import type {
	Library,
	LocalConnectionOptions,
	Options,
	RemoteConnectionOptions,
} from "../_types";

const genLocalCalibreClient = async (
	options: LocalConnectionOptions,
): Promise<Library> => {
	const configResult = await commands.initClient(options.libraryPath);
	if (configResult.status === "error") {
		throw new Error(configResult.error);
	}

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
				throw new Error(results.error);
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
				throw new Error(result.error);
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
		sendToDevice: () => {
			throw new Error("Not implemented");
		},
		updateBook: async (bookId, updates) => {
			const result = await commands.clbCmdUpdateBook(bookId, updates);
			if (result.status === "error") {
				throw new Error(result.error);
			}
			return result.data;
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

const genRemoteCalibreClient = async (
	_options: RemoteConnectionOptions,
	// The interface requires this function to be async.
	// eslint-disable-next-line @typescript-eslint/require-await
): Promise<Library> => {
	// All remote clients are really Citadel clients... but for a certain kind of
	// library. In this case, Calibre.
	// `_options.url` will be the base URL once any remote method is implemented.

	// Nothing populates this yet (the whole-library fetch is gone); remote
	// cover/file lookups return undefined until a remote book fetch exists.
	const bookCache = new Map<LibraryBook["id"], LibraryBook>();

	return {
		createAuthors() {
			throw new Error("Not implemented");
		},
		queryBooks() {
			throw new Error("Not implemented");
		},
		// Remote thumbnails would come from the server; none exists yet, and an
		// empty result just means the grid keeps its fallback rendering.
		// The interface requires these functions are async.
		// eslint-disable-next-line @typescript-eslint/require-await
		ensureCoverThumbnails: async () => [],
		// eslint-disable-next-line @typescript-eslint/require-await
		listCoverThumbnails: async () => [],
		// eslint-disable-next-line @typescript-eslint/require-await
		warmCoverThumbnails: async () => [],
		getBook() {
			throw new Error("Not implemented");
		},
		listAuthors() {
			throw new Error("Not implemented");
		},
		listSeries() {
			throw new Error("Not implemented");
		},
		listTags() {
			throw new Error("Not implemented");
		},
		sendToDevice: () => {
			throw new Error("Not implemented");
		},
		updateBook: () => {
			throw new Error("Not implemented");
		},
		updateAuthor: () => {
			throw new Error("Not implemented");
		},
		deleteAuthor: () => {
			throw new Error("Not implemented");
		},
		upsertBookIdentifier: () => {
			throw new Error("Not implemented");
		},
		deleteBookIdentifier: () => {
			throw new Error("Not implemented");
		},
		// The interface requires we accept param.
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		getCoverPathForBook: (_bookId) => {
			return "";
		},
		getCoverUrlForBook(bookId) {
			const url = bookCache.get(bookId)?.cover_image?.url;
			return url;
		},
		getDefaultFilePathForBook: (bookId) => {
			const fileList = bookCache.get(bookId)?.file_list ?? [];
			const remoteFiles = fileList
				.map((file) => ("Remote" in file ? file.Remote : undefined))
				.filter((file): file is RemoteFile => file !== undefined);
			const urls = remoteFiles.map((file) => file.url);
			return urls.at(0);
		},
		checkFileImportable: () => {
			throw new Error("Not implemented");
		},
		getImportableFileMetadata: () => {
			throw new Error("Not implemented");
		},
		addImportableFileByMetadata: () => {
			throw new Error("Not implemented");
		},
		// The interface requires this function is async.
		// eslint-disable-next-line @typescript-eslint/require-await
		listValidFileTypes: async () => {
			throw new Error("Not implemented");
		},
	};
};

export const initCalibreClient = async (options: Options): Promise<Library> => {
	if (options.connectionType === "remote") {
		return genRemoteCalibreClient(options);
	}

	return genLocalCalibreClient(options);
};
