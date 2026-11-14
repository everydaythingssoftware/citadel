import type { Meta, StoryObj } from "@storybook/react";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AddBookProvider } from "@/components/organisms/AddBook";
import { MenuCommandHost } from "@/components/organisms/MenuCommandHost";
import type {
	LibraryBook,
	LibraryBookPage,
	LibraryBookQuery,
} from "@/bindings";
import { emptySelection } from "@/lib/book-selection";
import { useBookSelectionStore } from "@/lib/hooks/use-book-selection";
import { PlatformProvider } from "@/lib/platform/context";
import { createWebPlatform } from "@/lib/platform/create";
import type { OperatingSystem } from "@/lib/platform/os";
import type { MenuCommand, PlatformAdapter } from "@/lib/platform/types";
import { BookDeletion, type Library } from "@/lib/services/library";
import { LibraryState, useLibraryStore } from "@/stores/library/store";
import { Books } from "./Books";

const log =
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

const makeBooks = (count: number, local: boolean): LibraryBook[] =>
	Array.from({ length: count }, (_, index) => {
		const title = `${TITLES[index % TITLES.length]}${index >= TITLES.length ? ` ${Math.floor(index / TITLES.length) + 1}` : ""}`;
		const author = AUTHORS[index % AUTHORS.length] ?? "Anonymous";
		const name = encodeURIComponent(title);
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
			tag_list: [],
			description: null,
			file_list: local
				? [
						{
							Local: {
								path: `/Users/reader/Calibre Library/${author}/${title}/${title}.epub`,
								mime_type: "application/epub+zip",
							},
						},
					]
				: [
						{
							Remote: { url: `https://books.example/files/EPUB/${name}.epub` },
						},
					],
			cover_image: null,
			identifier_list: [],
			is_read: index % 5 === 3,
			series: null,
			series_index: null,
			language_list: [],
			added_at: "2026-11-10T10:00:00Z",
		};
	});

/** An in-memory library: pages, finished flags and deletes all work. */
const fakeLibrary = (books: LibraryBook[], readOnly: boolean): Library => {
	let shelf = [...books];
	const page = async (query: LibraryBookQuery): Promise<LibraryBookPage> => {
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
		return { items, total: matching.length } as LibraryBookPage;
	};
	return {
		readOnly,
		bookDeletion: readOnly ? BookDeletion.permanent : BookDeletion.trash,
		queryBooks: page,
		ensureCoverThumbnails: async () => [],
		listCoverThumbnails: async () => [],
		warmCoverThumbnails: async () => [],
		listAuthors: async () => [],
		listSeries: async () => [],
		listTags: async () => [],
		listPublishers: async () => [],
		updateBook: async (id, update) => {
			shelf = shelf.map((book) =>
				book.id === id && update.is_read !== null
					? { ...book, is_read: update.is_read }
					: book,
			);
		},
		deleteBooks: async (ids) => {
			shelf = shelf.filter((book) => !ids.includes(book.id));
			return { folder_failures: [] } as unknown as Awaited<
				ReturnType<Library["deleteBooks"]>
			>;
		},
	} as Partial<Library> as Library;
};

/**
 * The macOS menu bar, faked: what the window pushes is logged, and
 * `window.storyMenu("undo")` chooses an item, as clicking it in the menu
 * bar would.
 */
const fakeMenuBar = (web: PlatformAdapter): PlatformAdapter["menu"] => ({
	...web.menu,
	onCommand: async (handler) => {
		(window as { storyMenu?: (command: MenuCommand) => void }).storyMenu =
			handler;
		return () => {};
	},
	setState: log("menu bar"),
});

const desktopPlatform = (os: OperatingSystem): PlatformAdapter => {
	const web = createWebPlatform();
	return {
		...web,
		os,
		menu: os === "macos" ? fakeMenuBar(web) : web.menu,
		capabilities: {
			...web.capabilities,
			supportsNativeWindows: true,
			canOpenLocalPaths: true,
			canRevealInFileManager: true,
			canQuickLook: os === "macos",
			canDragFilesOut: true,
		},
		fileOpener: {
			...web.fileOpener,
			fileManagerName:
				os === "macos"
					? "Finder"
					: os === "windows"
						? "File Explorer"
						: "File Manager",
			openPath: log("open"),
			revealInFileManager: log("reveal"),
			quickLook: log("quick look"),
			defaultApp: async () => null,
		},
		window: { ...web.window, startDrag: log("start drag") },
		clipboard: { writeText: log("copy") },
	};
};

const webPlatform = (os: OperatingSystem): PlatformAdapter => {
	const web = createWebPlatform();
	return {
		...web,
		os,
		fileOpener: {
			...web.fileOpener,
			quickLook: async () => {},
			defaultApp: async () => null,
		},
	};
};

interface FrameProps {
	platform: PlatformAdapter;
	count: number;
	readOnly?: boolean;
}

const Frame = ({ platform, count, readOnly = false }: FrameProps) => {
	const [ready, setReady] = useState(false);
	useEffect(() => {
		const desktop = platform.capabilities.supportsNativeWindows;
		document.documentElement.dataset.platform = platform.os;
		document.documentElement.dataset.runtime = desktop ? "desktop" : "web";
		const library = fakeLibrary(makeBooks(count, desktop), readOnly);
		useBookSelectionStore.setState({
			selection: emptySelection,
			detailsOpen: false,
			deleteDialogOpen: false,
		});
		useLibraryStore.setState({
			library,
			libraryState: LibraryState.ready,
			libraryTotal: count,
			series: [],
			authors: [],
		});
		setReady(true);
	}, [platform, count, readOnly]);
	const router = useMemo(
		() =>
			createRouter({
				routeTree: createRootRoute({
					component: () => (
						<AddBookProvider>
							<Books />
							<MenuCommandHost />
						</AddBookProvider>
					),
				}),
				history: createMemoryHistory(),
			}),
		[],
	);
	if (!ready) return null;
	return (
		<PlatformProvider value={platform}>
			<div style={{ position: "fixed", inset: 0, display: "flex" }}>
				<div style={{ flex: 1, minWidth: 0 }}>
					<RouterProvider router={router} />
				</div>
			</div>
		</PlatformProvider>
	);
};

const meta: Meta<typeof Frame> = {
	title: "Components/Pages/Books",
	component: Frame,
	parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof Frame>;

/**
 * A click shows the book's details, ⌘-click and ⇧-click select without
 * them, a double-click opens the file, ⌘A selects all. Edit > Undo is the
 * faked menu bar (`window.storyMenu`).
 */
export const MacDesktop: Story = {
	args: { platform: desktopPlatform("macos"), count: 1204 },
};

export const WindowsDesktop: Story = {
	args: { platform: desktopPlatform("windows"), count: 240 },
};

/**
 * The same clicks; a double-click downloads the file, and right-click
 * offers Download. Read-only, so nothing here can be marked finished.
 */
export const Web: Story = {
	args: { platform: webPlatform("macos"), count: 1204, readOnly: true },
};

export const OneBook: Story = {
	args: { platform: desktopPlatform("macos"), count: 1 },
};
