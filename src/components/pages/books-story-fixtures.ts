import type { LibraryBook, LibraryBookQuery } from "@/bindings";
import { none, some } from "@/lib/option";
import { createWebPlatform } from "@/lib/platform/create";
import { fileManagerNameFor } from "@/lib/platform/file-opener/file-manager-name";
import type { OperatingSystem } from "@/lib/platform/os";
import type { PlatformAdapter } from "@/lib/platform/types";
import {
	BookDeletion,
	type Library,
	type LocalBookImports,
} from "@/lib/services/library";

export const storyLog =
	(what: string) =>
	async (...args: unknown[]) => {
		console.info(what, ...args);
	};

const TITLES = [
	"Middlemarch",
	"The Rings of Saturn",
	"Pale Fire",
	"Housekeeping",
	"The Remains of the Day",
	"Austerlitz",
	"Mrs Dalloway",
	"The Leopard",
	"Stoner",
	"Gilead",
	"A Month in the Country",
	"The Blue Flower",
	"Wide Sargasso Sea",
	"The Waves",
	"Invisible Cities",
	"Disgrace",
	"The Sea, the Sea",
	"Light Years",
	"The Hours",
	"Small Things Like These",
];
const AUTHORS = [
	"George Eliot",
	"W. G. Sebald",
	"Vladimir Nabokov",
	"Marilynne Robinson",
	"Kazuo Ishiguro",
	"Virginia Woolf",
	"Italo Calvino",
	"Penelope Fitzgerald",
];
const PALETTES = [
	["#2f4858", "#f6ae2d"],
	["#7a2e3a", "#f2d0a4"],
	["#1d3557", "#a8dadc"],
	["#386641", "#f2e8cf"],
	["#3d348b", "#f7b801"],
	["#6d597a", "#eaac8b"],
] as const;

const cover = (title: string, index: number): string => {
	const [ink, paper] = PALETTES[index % PALETTES.length] ?? PALETTES[0];
	return `data:image/svg+xml,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300" viewBox="0 0 200 300"><rect width="200" height="300" fill="${ink}"/><rect x="16" y="180" width="168" height="2" fill="${paper}"/><text x="18" y="60" font-family="Georgia" font-size="22" fill="${paper}">${title.slice(0, 14)}</text></svg>`,
	)}`;
};

const DESCRIPTION = Array.from(
	{ length: 4 },
	(_, index) =>
		`<p>Paragraph ${index + 1}. A provincial town, a marriage that fails its promise, a doctor who wants to reform medicine and a young woman who wants to do some lasting good. Eliot follows a whole community through the years before the Reform Act with a patience that makes every life in it matter.</p>`,
).join("");

/** Books with covers, local files on the desktop and server files on the web. */
export const makeStoryBooks = (count: number, local: boolean): LibraryBook[] =>
	Array.from({ length: count }, (_, index) => {
		const round = Math.floor(index / TITLES.length);
		const title = `${TITLES[index % TITLES.length]}${round > 0 ? ` ${round + 1}` : ""}`;
		const author = AUTHORS[index % AUTHORS.length] ?? "Anonymous";
		const fileBase = `/Users/reader/Calibre Library/${author}/${title} (${index})/${title} - ${author}`;
		return {
			id: `book-${String(index).padStart(4, "0")}`,
			uuid: null,
			title,
			sortable_title: title,
			author_list: [
				{
					id: `author-${index % AUTHORS.length}`,
					name: author,
					sortable_name: author,
					book_count: 1,
				},
			],
			tag_list: ["Fiction", "Classics"],
			description: DESCRIPTION,
			file_list: local
				? [
						{
							Local: {
								path: `${fileBase}.epub`,
								mime_type: "application/epub+zip",
							},
						},
						{
							Local: { path: `${fileBase}.pdf`, mime_type: "application/pdf" },
						},
					]
				: [
						{
							Remote: {
								url: `https://books.example/files/EPUB/${encodeURIComponent(title)}.epub`,
							},
						},
					],
			cover_image: {
				kind: "Remote",
				url: cover(title, index),
				local_path: null,
			},
			identifier_list: [
				{ id: 1, label: "isbn", value: "9780141439549" },
				{ id: 2, label: "openlibrary", value: "OL45804W" },
			],
			is_read: index % 5 === 3,
			series: index % 3 === 0 ? "Collected Novels" : null,
			series_index: index % 3 === 0 ? 2 : null,
			publisher: null,
			language_list: ["eng"],
			added_at: "2026-11-10T10:00:00Z",
		};
	});

/** An in-memory library: pages, search, finished flags and deletes all work. */
export const fakeStoryLibrary = (
	books: LibraryBook[],
	{ readOnly = false }: { readOnly?: boolean } = {},
): Library => {
	let shelf = [...books];
	const library: Partial<Library> = {
		readOnly,
		bookDeletion: readOnly ? BookDeletion.permanent : BookDeletion.trash,
		// Takes books, so the toolbar shows Add Book as the app does.
		uploads: {
			list: async () => ({ uploads: [] }),
		} as Partial<LocalBookImports> as LocalBookImports,
		queryBooks: async (query: LibraryBookQuery) => {
			const matching = shelf.filter(
				(book) =>
					(!query.hide_read || !book.is_read) &&
					(query.text === null ||
						book.title.toLowerCase().includes(query.text.toLowerCase())),
			);
			const offset = query.offset ?? 0;
			const items =
				query.limit === null
					? matching.slice(offset)
					: matching.slice(offset, offset + query.limit);
			await new Promise((resolve) => setTimeout(resolve, 30));
			return { items, total: matching.length };
		},
		ensureCoverThumbnails: async () => [],
		listCoverThumbnails: async () => [],
		warmCoverThumbnails: async () => [],
		listAuthors: async () => [],
		listSeries: async () => [],
		listTags: async () => [],
		listPublishers: async () => [],
		editBooks: async () => ({ undo: [] }),
		updateBook: async (id, update) => {
			shelf = shelf.map((book) =>
				book.id === id && update.is_read !== null
					? { ...book, is_read: update.is_read }
					: book,
			);
		},
		deleteBooks: async (ids) => {
			shelf = shelf.filter((book) => !ids.includes(book.id));
			return { deleted: ids.length, folder_failures: [] };
		},
	};
	return library as Library;
};

const svgIcon = (body: string) =>
	`data:image/svg+xml,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`,
	)}`;

const BOOKS_APP = {
	name: "Books",
	iconDataUrl: svgIcon(
		'<rect x="4" y="4" width="56" height="56" rx="13" fill="#f08a24"/><path d="M18 44c6-2 11-2 14 1 3-3 8-3 14-1V20c-6-2-11-2-14 1-3-3-8-3-14-1Z" fill="#fff"/>',
	),
};

/** The desktop app's platform, with file actions logged to the console. */
export const desktopStoryPlatform = (os: OperatingSystem): PlatformAdapter => {
	const web = createWebPlatform();
	return {
		...web,
		os,
		capabilities: {
			...web.capabilities,
			supportsNativeWindows: true,
			canOpenLocalPaths: true,
			canRevealInFileManager: true,
		},
		fileOpener: {
			...web.fileOpener,
			fileManagerName: fileManagerNameFor(os),
			openPath: storyLog("open"),
			revealInFileManager: storyLog("reveal"),
			quickLook: os === "macos" ? some(storyLog("quick look")) : none(),
			defaultApp: async () => (os === "macos" ? some(BOOKS_APP) : none()),
		},
		window: { ...web.window, startDrag: some(storyLog("start drag")) },
		clipboard: { writeText: storyLog("copy") },
	};
};

export const webStoryPlatform = (os: OperatingSystem): PlatformAdapter => ({
	...createWebPlatform(),
	os,
});
