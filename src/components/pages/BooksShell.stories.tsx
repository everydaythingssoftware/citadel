import type { Meta, StoryObj } from "@storybook/react";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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
import type { PlatformAdapter } from "@/lib/platform/types";
import { BookDeletion, type Library } from "@/lib/services/library";
import { Route as RootRoute } from "@/routes/__root";
import { LibraryState, useLibraryStore } from "@/stores/library/store";
import { useSettings } from "@/stores/settings/store";
import { Books } from "./Books";

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
];

const DESCRIPTION = Array.from(
	{ length: 4 },
	(_, index) =>
		`<p>Paragraph ${index + 1}. A provincial town, a marriage that fails its promise, a doctor who wants to reform medicine and a young woman who wants to do some lasting good. Eliot follows a whole community through the years before the Reform Act with a patience that makes every life in it matter.</p>`,
).join("");

const makeBooks = (count: number, local: boolean): LibraryBook[] =>
	Array.from({ length: count }, (_, index) => {
		const title = TITLES[index % TITLES.length] ?? "Untitled";
		const fileBase = `/Users/reader/Calibre Library/George Eliot/${title} (${index})/${title} - George Eliot`;
		return {
			id: `book-${String(index).padStart(4, "0")}`,
			uuid: null,
			title,
			sortable_title: title,
			author_list: [
				{
					id: "author-0",
					name: "George Eliot",
					sortable_name: "Eliot, George",
					book_count: 1,
				},
			],
			tag_list: ["Fiction", "Victorian", "Classics"],
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
			series: index % 3 === 0 ? "Eliot Novels" : null,
			series_index: index % 3 === 0 ? 2 : null,
			language_list: ["eng"],
			added_at: "2026-11-10T10:00:00Z",
		};
	});

const fakeLibrary = (books: LibraryBook[]): Library =>
	({
		readOnly: false,
		bookDeletion: BookDeletion.trash,
		queryBooks: async (query: LibraryBookQuery): Promise<LibraryBookPage> => {
			const offset = query.offset ?? 0;
			const items =
				query.limit === null
					? books.slice(offset)
					: books.slice(offset, offset + query.limit);
			return { items, total: books.length } as LibraryBookPage;
		},
		ensureCoverThumbnails: async () => [],
		listCoverThumbnails: async () => [],
		warmCoverThumbnails: async () => [],
		listAuthors: async () => [],
		listSeries: async () => [],
		listTags: async () => [],
		listPublishers: async () => [],
	}) as Partial<Library> as Library;

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

const desktopPlatform = (os: OperatingSystem): PlatformAdapter => {
	const web = createWebPlatform();
	const noop = async () => {};
	return {
		...web,
		os,
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
			fileManagerName: os === "macos" ? "Finder" : "File Explorer",
			openPath: noop,
			revealInFileManager: noop,
			quickLook: noop,
			defaultApp: async () => (os === "macos" ? BOOKS_APP : null),
		},
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
	/** Opens the details drawer on this book once the grid is up. */
	detailsIndex?: number;
	/** Pretends another app is in front (desktop only). */
	inactive?: boolean;
}

/** The Books page inside the real window shell: toolbar, sidebar, status bar. */
const Frame = ({ platform, detailsIndex, inactive = false }: FrameProps) => {
	const [ready, setReady] = useState(false);
	useEffect(() => {
		const desktop = platform.capabilities.supportsNativeWindows;
		// After the preview's own decorator has set its toolbar's platform.
		const attributes = setTimeout(() => {
			const html = document.documentElement;
			html.dataset.platform = platform.os;
			html.dataset.runtime = desktop ? "desktop" : "web";
			if (inactive) html.dataset.windowInactive = "";
			else delete html.dataset.windowInactive;
		});
		const books = makeBooks(60, desktop);
		useSettings.setState({
			libraryPaths: [
				{
					id: "lib-1",
					displayName: "Calibre Library",
					absolutePath: "/Users/reader/Calibre Library",
				},
			],
			activeLibraryId: "lib-1",
		});
		useLibraryStore.setState({
			library: fakeLibrary(books),
			libraryState: LibraryState.ready,
			libraryTotal: books.length,
			series: [],
			authors: [],
			tags: [],
		});
		const detailsBook =
			detailsIndex !== undefined ? (books[detailsIndex] ?? null) : null;
		useBookSelectionStore.setState({
			selection: emptySelection,
			detailsBook,
			detailsOpen: false,
			deleteDialogOpen: false,
		});
		setReady(true);
		const timer =
			detailsBook === null
				? undefined
				: setTimeout(
						() => useBookSelectionStore.setState({ detailsOpen: true }),
						400,
					);
		return () => {
			clearTimeout(attributes);
			clearTimeout(timer);
		};
	}, [platform, detailsIndex, inactive]);
	const router = useMemo(() => {
		const root = createRootRoute({ component: RootRoute.options.component });
		const index = createRoute({
			getParentRoute: () => root,
			path: "/",
			component: () => <Books />,
		});
		return createRouter({
			routeTree: root.addChildren([index]),
			history: createMemoryHistory(),
		});
	}, []);
	if (!ready) return null;
	return (
		<PlatformProvider value={platform}>
			<div style={{ position: "fixed", inset: 0 }}>
				<RouterProvider router={router} />
			</div>
		</PlatformProvider>
	);
};

const meta: Meta<typeof Frame> = {
	title: "Components/Pages/Books in the Shell",
	component: Frame,
	parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof Frame>;

export const MacDesktop: Story = {
	args: { platform: desktopPlatform("macos") },
};

/** The details drawer as a layer of the content panel. */
export const MacDetails: Story = {
	args: { platform: desktopPlatform("macos"), detailsIndex: 0 },
};

export const MacDetailsInactive: Story = {
	args: { ...MacDetails.args, inactive: true },
};

export const WindowsDetails: Story = {
	args: { platform: desktopPlatform("windows"), detailsIndex: 3 },
};

export const WebDetails: Story = {
	args: { platform: webPlatform("macos"), detailsIndex: 1 },
};

export const PhoneDetails: Story = {
	args: { platform: webPlatform("ios"), detailsIndex: 1 },
	globals: { viewport: { value: "mobile1" } },
};
