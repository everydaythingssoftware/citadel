export interface paths {
    "/api/account/provider-credentials": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description The signed-in user's saved provider keys. Keys themselves are never returned. */
        get: operations["listProviderCredentials"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/account/provider-credentials/{provider}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** @description Check a provider key with the provider, then save it for the signed-in user, replacing any earlier key. */
        put: operations["saveProviderCredential"];
        post?: never;
        /** @description Forget the signed-in user's key for a provider. */
        delete: operations["deleteProviderCredential"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/authors": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listAuthors"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/authors/{author_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** @description Delete an author with no books. */
        delete: operations["deleteAuthor"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/books/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Permanently delete books and their files; this can't be undone. Nothing is deleted if any ID is unknown. Folders that could not be removed are listed, relative to the library, in folder_failures. */
        post: operations["deleteBooks"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/books/query": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Query the configured library. HTTP requires an explicit limit between 0 and 200; zero returns only the total. No arbitrary library paths are accepted. */
        post: operations["queryBooks"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/books/{book_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getBook"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/books/{book_id}/cover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getBookCover"];
        /** @description Set a book's cover from an uploaded image. The image is decoded within limits and stored re-encoded as JPEG. */
        put: operations["setBookCoverFromFile"];
        /** @description Set a book's cover from a metadata result. The server fetches the full-size image from the provider; clients never send a URL. 410 when the cover ID has expired. */
        post: operations["setBookCoverFromMetadata"];
        delete?: never;
        options?: never;
        head: operations["getBookCoverHead"];
        patch?: never;
        trace?: never;
    };
    "/api/books/{book_id}/custom-values": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getCustomValues"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/books/{book_id}/files/{format}/{filename}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["downloadBookFile"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head: operations["downloadBookFileHead"];
        patch?: never;
        trace?: never;
    };
    "/api/books/{book_id}/thumbnail": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getCoverThumbnail"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/covers/thumbnails": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Cached thumbnails only. The bounded in-memory index is rebuilt on demand after a restart. */
        get: operations["listCoverThumbnails"];
        put?: never;
        post: operations["ensureCoverThumbnails"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/custom-columns": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listCustomColumns"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/library": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getLibrary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/metadata/covers/{cover_id}/prefetch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Start fetching a chosen cover at full size so applying it is quick. */
        post: operations["prefetchMetadataCover"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/metadata/covers/{cover_id}/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description A small JPEG of a result's cover, fetched by the server from the provider. 410 when the ID has expired; search again. */
        get: operations["previewMetadataCover"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/metadata/isbn/{isbn}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Look one provider up by ISBN. No match is an empty list, not an error. */
        get: operations["lookUpMetadataByIsbn"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/metadata/providers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Metadata providers and whether the signed-in user can use each. Keyless providers are always available. */
        get: operations["listMetadataProviders"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/metadata/providers/{provider}/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Check that the server can reach a provider, with the user's own key when it needs one. */
        post: operations["testMetadataProvider"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/metadata/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Free-text search one provider. No results is an empty list, not an error. Answers are cached briefly; uncached lookups count against a per-user rate limit. */
        get: operations["searchMetadata"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/publishers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listPublishers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/series": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listSeries"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description The signed-in user, or 401 when the browser has no valid session. */
        get: operations["getSession"];
        put?: never;
        /** @description Sign in with a Citadel username and password. Sets an HttpOnly session cookie. */
        post: operations["signIn"];
        /** @description End this browser's session and clear its cookie. */
        delete: operations["signOut"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tags": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listTags"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/uploads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listUploads"];
        put?: never;
        post: operations["createUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/uploads/{upload_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getUpload"];
        put?: never;
        post?: never;
        delete: operations["cancelUpload"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/uploads/{upload_id}/commit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["commitUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/uploads/{upload_id}/content": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["sendUploadChunk"];
        trace?: never;
    };
    "/api/uploads/{upload_id}/cover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getUploadCover"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        ApplyCover: {
            /** @description A `cover_id` from a metadata result. */
            coverId: string;
        };
        /** @description One book's value for one custom column. */
        BookCustomValue: {
            /** Format: int32 */
            column_id: number;
            value: components["schemas"]["CustomValueDto"];
        };
        BookFile: {
            Local: components["schemas"]["LocalFile"];
        } | {
            Remote: components["schemas"]["RemoteFile"];
        };
        /**
         * @description A book record from a provider. Providers return these fully populated from a
         *     single search call — there is no separate resolve step, so the cover-less
         *     MARC sources' subjects/publisher/language survive into the applied record.
         */
        BookMetadata: {
            authors: string[];
            /**
             * @description Opaque ID for this result's cover, for previews and applying it.
             *     Expires an hour after the result was last returned.
             */
            cover_id: string | null;
            description: string | null;
            /**
             * @description Explicit provider genre/form terms. Subject headings are never placed
             *     here merely because they look genre-like.
             */
            genre_candidates: components["schemas"]["GenreCandidate"][];
            identifier_label: string;
            isbn: string | null;
            /** @description MARC 3-letter language code. Parsed now; applied once CDL-2 lands. */
            language_code: string | null;
            provider: components["schemas"]["MetadataProvider"];
            /**
             * @description Provider-native id: hardcover id (stringified), LCCN, DNB control
             *     number, or Open Library OLID.
             */
            provider_id: string;
            publisher: string | null;
            /** Format: int32 */
            release_year: number | null;
            /** @description Hardcover deep-link slug; `None` for other providers. */
            slug: string | null;
            /** @description Subject headings, mapped to tag suggestions on the frontend. */
            subjects: string[];
            subtitle: string | null;
            title: string;
        };
        /** @enum {string} */
        BookSortOrder: "TitleAsc" | "TitleDesc" | "AuthorAsc" | "AuthorDesc";
        /** @description The metadata the user reviewed, to add the upload to the library with. */
        CommitUpload: {
            authorNames?: string[];
            /**
             * @description Stored as the book's ISBN when it is one (`urn:isbn:` and `ISBN:`
             *     prefixes are accepted); other identifiers are ignored.
             */
            identifier?: string | null;
            language?: string | null;
            /** Format: date */
            publicationDate?: string | null;
            publisher?: string | null;
            tags?: string[];
            title: string;
        };
        CoverThumbnail: {
            book_id: string;
            /** Format: int32 */
            height: number;
            url: string;
            /** Format: int32 */
            width: number;
        };
        CreateUpload: {
            /** @description The file's name, which decides its format by extension. */
            fileName: string;
            /**
             * Format: int64
             * @description The file's total size in bytes.
             */
            size: number;
        };
        /** @description A custom column definition, as exposed to the frontend. */
        CustomColumnDef: {
            /** Format: int32 */
            column_id: number;
            /** @description Raw Calibre datatype string, e.g. `bool`, `text`, `enumeration`. */
            datatype: string;
            editable: boolean;
            /** @description Allowed values for enumeration columns. Empty for other datatypes. */
            enum_values: string[];
            is_multiple: boolean;
            /** @description Lookup name, e.g. `read` (Calibre exposes it as `#read`). */
            label: string;
            /** @description Human-readable heading, e.g. `Read`. */
            name: string;
            /** @description Whether reading and writing values of this column is supported. */
            supported: boolean;
        };
        /**
         * @description A custom-column value crossing the application boundary.
         *
         *     Mirrors `libcalibre::CustomValue`, except datetimes travel as RFC3339
         *     strings and integers as `i32` (specta cannot export `i64` without bigint
         *     support).
         */
        CustomValueDto: {
            Bool: boolean;
        } | {
            /** Format: int32 */
            Int: number;
        } | {
            /** Format: double */
            Float: number;
        } | {
            Text: string;
        } | {
            TextMultiple: string[];
        } | {
            /** @description RFC3339 datetime string, e.g. `2024-01-15T10:30:00+00:00`. */
            Datetime: string;
        } | {
            Enumeration: string;
        };
        /**
         * @description Result of deleting books. The books are gone from the library either way;
         *     `folder_failures` lists folders, relative to the library, that could not
         *     be removed, each with its error.
         */
        DeleteBooksOutcome: {
            /** Format: int32 */
            deleted: number;
            folder_failures: string[];
        };
        DeleteBooksRequest: {
            book_ids: string[];
        };
        GenreCandidate: {
            name: string;
            /**
             * @description Stable provider field identity, such as `hardcover:genre` or
             *     `marc:655`.
             */
            source: string;
            /** @description Provider vocabulary or thesaurus when one is declared. */
            vocabulary: string | null;
        };
        /** @description Book identifiers, such as ISBN, DOI, Google Books ID, etc. */
        Identifier: {
            /** Format: int32 */
            id: number;
            label: string;
            value: string;
        };
        LibraryAuthor: {
            /**
             * Format: int32
             * @description Number of books in the library linked to this author, from
             *     `Library::author_book_counts` (one GROUP BY pass over
             *     `books_authors_link`). The Authors page renders this directly
             *     instead of deriving counts from the whole book list.
             */
            book_count: number;
            id: string;
            name: string;
            sortable_name: string;
        };
        LibraryBook: {
            author_list: components["schemas"]["LibraryAuthor"][];
            cover_image: components["schemas"]["LocalOrRemoteUrl"] | null;
            description: string | null;
            file_list: components["schemas"]["BookFile"][];
            id: string;
            identifier_list: components["schemas"]["Identifier"][];
            is_read: boolean;
            /**
             * @description Canonical Calibre language codes (ISO 639-2/3, e.g. `eng`, `fra`),
             *     ordered. Empty when the book has no language metadata.
             */
            language_list: string[];
            series: string | null;
            /** Format: float */
            series_index: number | null;
            sortable_title: string | null;
            tag_list: string[];
            title: string;
            uuid: string | null;
        };
        LibraryBookPage: {
            items: components["schemas"]["LibraryBook"][];
            /**
             * Format: int32
             * @description Total number of books matching the filters, ignoring limit/offset.
             */
            total: number;
        };
        LibraryBookQuery: {
            author_id?: string | null;
            hide_read: boolean;
            /**
             * Format: int32
             * @description Page size. `None` returns all matches.
             */
            limit?: number | null;
            /** Format: int32 */
            offset: number;
            /** Format: int32 */
            publisher_id?: number | null;
            /** Format: int32 */
            series_id?: number | null;
            sort: components["schemas"]["BookSortOrder"];
            /** Format: int32 */
            tag_id?: number | null;
            /**
             * @description Substring match across title, author names, and series names.
             *     `None` or empty text matches all books.
             */
            text?: string | null;
        };
        LibraryDescriptor: {
            id: string;
            name: string;
            readOnly: boolean;
        };
        LibraryError: {
            code: components["schemas"]["LibraryErrorCode"];
            message: string;
        };
        /** @enum {string} */
        LibraryErrorCode: "invalidArgument" | "unauthorized" | "rateLimited" | "notFound" | "readOnly" | "unavailable" | "tooLarge" | "conflict" | "storageFull" | "internal";
        LibraryPublisher: {
            /** Format: int32 */
            book_count: number;
            /** Format: int32 */
            id: number;
            name: string;
        };
        LibrarySeries: {
            /** Format: int32 */
            book_count: number;
            /** Format: int32 */
            id: number;
            name: string;
        };
        LibraryTag: {
            /** Format: int32 */
            book_count: number;
            /** Format: int32 */
            id: number;
            name: string;
        };
        LocalFile: {
            /** @description The MIME type of the file. Common values are `application/pdf` and `application/epub+zip`. */
            mime_type: string;
            /** @description The absolute path to the file, including extension. */
            path: string;
        };
        /** @enum {string} */
        LocalOrRemote: "Local" | "Remote";
        LocalOrRemoteUrl: {
            kind: components["schemas"]["LocalOrRemote"];
            local_path: string | null;
            url: string;
        };
        /**
         * @description The metadata sources Citadel can look books up against. The serialized
         *     short form is the single id used across the Rust enum, the TS string union,
         *     and the frontend registry keys.
         * @enum {string}
         */
        MetadataProvider: "hardcover" | "loc" | "dnb" | "k10plus" | "openlibrary";
        MetadataProviderInfo: {
            /** @description Whether this user can look books up with the provider right now. */
            available: boolean;
            displayName: string;
            provider: components["schemas"]["MetadataProvider"];
            requiresKey: boolean;
            /** @description Why not, when it isn't. */
            unavailableReason: string | null;
        };
        ProviderCredentialInfo: {
            /** @description The provider account the key belongs to, when the provider says. */
            accountName: string | null;
            /**
             * Format: int64
             * @description When the key was saved, in Unix seconds.
             */
            createdAt: number;
            displayName: string;
            /**
             * @description The server can no longer read the key (its vault key changed); enter
             *     it again.
             */
            needsReentry: boolean;
            provider: components["schemas"]["MetadataProvider"];
            /**
             * Format: int64
             * @description When the provider last accepted the key, in Unix seconds.
             */
            verifiedAt: number | null;
        };
        ProviderStatus: {
            is_valid: boolean;
            message: string;
            provider: components["schemas"]["MetadataProvider"];
        };
        RemoteFile: {
            url: string;
        };
        SaveProviderCredential: {
            /** @description The provider API key. It is checked with the provider before saving. */
            secret: string;
        };
        SessionInfo: {
            /** @description False when the user exists but has no access to this server's library. */
            libraryAccess: boolean;
            user: components["schemas"]["SessionUser"];
        };
        SessionUser: {
            id: string;
            username: string;
        };
        SignInRequest: {
            password: string;
            username: string;
        };
        /** @description What the uploaded file says about itself, for the user to review. */
        StagedBook: {
            authorNames: string[];
            coverUrl?: string | null;
            /** @description The file's format, as its extension (`epub`, `azw3`, …). */
            format: string;
            identifier?: string | null;
            language?: string | null;
            /** Format: date */
            publicationDate?: string | null;
            publisher?: string | null;
            tags: string[];
            /** @description The file's own title, or its name when it has none. */
            title: string;
        };
        StagedUpload: {
            book?: components["schemas"]["StagedBook"] | null;
            /**
             * Format: date-time
             * @description When the server discards the upload: a fixed review deadline once the
             *     file has been read, otherwise an hour after its last chunk.
             */
            expiresAt: string;
            fileName: string;
            id: string;
            /** Format: int64 */
            receivedBytes: number;
            /** Format: int64 */
            size: number;
        };
        ThumbnailQuery: {
            book_ids: string[];
        };
        UploadList: {
            /** Format: int64 */
            chunkBytes: number;
            /** Format: int64 */
            maxFileBytes: number;
            /**
             * Format: int64
             * @description How long a finished upload waits to be added or skipped.
             */
            reviewSeconds: number;
            uploads: components["schemas"]["StagedUpload"][];
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listProviderCredentials: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderCredentialInfo"][];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    saveProviderCredential: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description A provider that needs a key */
                provider: components["schemas"]["MetadataProvider"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SaveProviderCredential"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderCredentialInfo"];
                };
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    deleteProviderCredential: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Provider ID */
                provider: components["schemas"]["MetadataProvider"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    listAuthors: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryAuthor"][];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    deleteAuthor: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Library author ID */
                author_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    deleteBooks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeleteBooksRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeleteBooksOutcome"];
                };
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    queryBooks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LibraryBookQuery"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryBookPage"];
                };
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    getBook: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Library book ID */
                book_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryBook"];
                };
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    getBookCover: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                book_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Book asset */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "image/jpeg": string;
                };
            };
            /** @description Partial book asset */
            206: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Asset not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Range not satisfiable */
            416: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Library unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    setBookCoverFromFile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Library book ID */
                book_id: string;
            };
            cookie?: never;
        };
        /** @description A JPEG, PNG or WebP image, up to `api.metadata.maxImageBytes` */
        requestBody: {
            content: {
                "image/*": number[];
            };
        };
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    setBookCoverFromMetadata: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Library book ID */
                book_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ApplyCover"];
            };
        };
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    getBookCoverHead: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                book_id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Book asset */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "image/jpeg": string;
                };
            };
            /** @description Partial book asset */
            206: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Asset not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Range not satisfiable */
            416: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Library unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getCustomValues: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                book_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BookCustomValue"][];
                };
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    downloadBookFile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                book_id: number;
                format: string;
                filename: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Book asset */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            /** @description Partial book asset */
            206: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Asset not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Range not satisfiable */
            416: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Library unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    downloadBookFileHead: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                book_id: number;
                format: string;
                filename: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Book asset */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            /** @description Partial book asset */
            206: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Asset not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Range not satisfiable */
            416: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Library unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getCoverThumbnail: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                book_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "image/jpeg": number[];
                };
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    listCoverThumbnails: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CoverThumbnail"][];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    ensureCoverThumbnails: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ThumbnailQuery"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CoverThumbnail"][];
                };
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    listCustomColumns: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CustomColumnDef"][];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    getLibrary: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryDescriptor"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    prefetchMetadataCover: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description A `cover_id` from a metadata result */
                cover_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    previewMetadataCover: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description A `cover_id` from a metadata result */
                cover_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Cover preview */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "image/jpeg": number[];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    lookUpMetadataByIsbn: {
        parameters: {
            query: {
                /** @description Provider ID, such as `openlibrary` or `loc`. */
                provider: components["schemas"]["MetadataProvider"];
            };
            header?: never;
            path: {
                /** @description ISBN-10 or ISBN-13, hyphens allowed */
                isbn: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BookMetadata"][];
                };
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    listMetadataProviders: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MetadataProviderInfo"][];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    testMetadataProvider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Provider ID */
                provider: components["schemas"]["MetadataProvider"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderStatus"];
                };
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    searchMetadata: {
        parameters: {
            query: {
                /** @description Provider ID, such as `openlibrary` or `loc`. */
                provider: components["schemas"]["MetadataProvider"];
                /** @description Title, author or keywords. */
                q: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BookMetadata"][];
                };
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    listPublishers: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryPublisher"][];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    listSeries: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibrarySeries"][];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    getSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionInfo"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    signIn: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SignInRequest"];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionInfo"];
                };
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    signOut: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    listTags: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryTag"][];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    listUploads: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UploadList"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    createUpload: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateUpload"];
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StagedUpload"];
                };
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            507: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    getUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Upload ID */
                upload_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StagedUpload"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    cancelUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Upload ID */
                upload_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Upload cancelled */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    commitUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Upload ID */
                upload_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CommitUpload"];
            };
        };
        responses: {
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryBook"];
                };
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    sendUploadChunk: {
        parameters: {
            query?: never;
            header: {
                /** @description Byte offset of this chunk; must equal receivedBytes */
                "Upload-Offset": number;
            };
            path: {
                /** @description Upload ID */
                upload_id: string;
            };
            cookie?: never;
        };
        /** @description The next bytes of the file, at most chunkBytes */
        requestBody: {
            content: {
                "application/octet-stream": number[];
            };
        };
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StagedUpload"];
                };
            };
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
    getUploadCover: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Upload ID */
                upload_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "image/jpeg": number[];
                };
            };
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LibraryError"];
                };
            };
        };
    };
}
