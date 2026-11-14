import type { Meta, StoryObj } from "@storybook/react";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { LibraryBook } from "@/bindings";
import booksStyles from "@/components/pages/Books.module.css";
import { fileTypeKey } from "@/lib/book-file-actions";
import type { OperatingSystem } from "@/lib/platform/os";
import { createWebPlatform } from "@/lib/platform/create";
import { PlatformProvider } from "@/lib/platform/context";
import type { PlatformAdapter } from "@/lib/platform/types";
import type { Library } from "@/lib/services/library";
import { useLibraryStore } from "@/stores/library/store";
import { BookDetailsDrawer } from "./BookDrawer";

const svgIcon = (body: string) =>
	`data:image/svg+xml,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`,
	)}`;

/** Stand-ins for the icons the Mac would hand over for Kindle and Preview. */
const APP_ICONS: Record<string, { name: string; iconDataUrl: string }> = {
	epub: {
		name: "Kindle",
		iconDataUrl: svgIcon(
			'<rect x="4" y="4" width="56" height="56" rx="13" fill="#1d2b3a"/><path d="M18 44c6-2 11-2 14 1 3-3 8-3 14-1V20c-6-2-11-2-14 1-3-3-8-3-14-1Z" fill="#f4c35a"/><path d="M32 21v24" stroke="#1d2b3a" stroke-width="2"/>',
		),
	},
	pdf: {
		name: "Preview",
		iconDataUrl: svgIcon(
			'<rect x="4" y="4" width="56" height="56" rx="13" fill="#5b8def"/><rect x="18" y="14" width="28" height="36" rx="3" fill="#fff"/><path d="M23 23h18M23 30h18M23 37h11" stroke="#5b8def" stroke-width="2.5" stroke-linecap="round"/>',
		),
	},
};

const log =
	(what: string) =>
	async (...args: unknown[]) => {
		console.info(what, ...args);
	};

const desktopPlatform = (os: OperatingSystem): PlatformAdapter => {
	const web = createWebPlatform();
	return {
		...web,
		os,
		capabilities: {
			...web.capabilities,
			canOpenLocalPaths: true,
			canRevealInFileManager: true,
			canQuickLook: os === "macos",
		},
		fileOpener: {
			fileManagerName:
				os === "macos"
					? "Finder"
					: os === "windows"
						? "File Explorer"
						: "File Manager",
			openPath: log("open"),
			revealInFileManager: log("reveal"),
			quickLook: log("quick look"),
			defaultApp: async (path) =>
				os === "macos" ? (APP_ICONS[fileTypeKey(path)] ?? null) : null,
		},
	};
};

const webPlatform = (os: OperatingSystem): PlatformAdapter => ({
	...createWebPlatform(),
	os,
});

const LOCAL_DIR =
	"/Users/reader/Calibre Library/Kathryn Siveyer/The Child & Tchaikovsky (412)";
const SERVER = "https://books.example/api/books/412/files";
const BASE_NAME =
	"The Child & Tchaikovsky_ A Memoir of Practice and Patience - Kathryn Siveyer";

const book = (files: LibraryBook["file_list"]): LibraryBook => ({
	id: "0000004JFGPMWM6WMEEFXRKXK8",
	uuid: "01901f97-c2c5-7ce8-9546-36455c321691",
	title: "The Child & Tchaikovsky",
	sortable_title: "Child & Tchaikovsky, The",
	author_list: [
		{
			id: "0000004JFG0DKZV4DGR66BKW9D",
			name: "Kathryn Siveyer",
			sortable_name: "Siveyer, Kathryn",
			book_count: 1,
		},
	],
	tag_list: ["Music", "Memoir"],
	description:
		"<p>A memoir of a childhood spent at the piano, and of the composer who kept a lonely girl company through it. Siveyer writes about practice and patience, about the way a piece of music can hold a whole year of a life, and about what it means to love something that never loves you back.</p><p>Second paragraph, so the description clamps.</p>",
	file_list: files,
	cover_image: null,
	is_read: false,
	series: "Music Lives",
	series_index: 2,
	language_list: ["eng"],
	added_at: "2026-11-10T10:00:00Z",
	identifier_list: [
		{ id: 1, label: "isbn", value: "9780316769488" },
		{ id: 2, label: "hardcover", value: "428115" },
		{ id: 3, label: "openlibrary", value: "OL45804W" },
	],
});

const LOCAL_BOOK = book([
	{
		Local: {
			path: `${LOCAL_DIR}/${BASE_NAME}.epub`,
			mime_type: "application/epub+zip",
		},
	},
	{
		Local: {
			path: `${LOCAL_DIR}/${BASE_NAME}.pdf`,
			mime_type: "application/pdf",
		},
	},
	{ Local: { path: `${LOCAL_DIR}/${BASE_NAME}.azw3`, mime_type: "AZW3" } },
]);

const REMOTE_BOOK = book([
	{ Remote: { url: `${SERVER}/EPUB/${encodeURIComponent(BASE_NAME)}.epub` } },
	{ Remote: { url: `${SERVER}/PDF/${encodeURIComponent(BASE_NAME)}.pdf` } },
]);

const SIZES: Record<string, number> = { epub: 2_140_000, pdf: 8_400_000 };

type FakeServer = "stalls" | "delivers" | "fails";

/** Answers the books.example URLs: HEAD with a size, GET per `behaviour`. */
const fakeFetch =
	(behaviour: FakeServer, real: typeof fetch): typeof fetch =>
	async (input, init) => {
		const url = typeof input === "string" ? input : input.toString();
		if (!url.startsWith("https://books.example/")) return real(input, init);
		const size = SIZES[fileTypeKey(new URL(url).pathname)] ?? 1_000_000;
		const headers = { "Content-Length": String(size) };
		if (init?.method === "HEAD") return new Response(null, { headers });
		if (behaviour === "fails") return new Response("", { status: 500 });
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				if (behaviour === "delivers") {
					controller.enqueue(new Uint8Array(size));
					controller.close();
					return;
				}
				controller.enqueue(new Uint8Array(Math.round(size * 0.4)));
				init?.signal?.addEventListener("abort", () =>
					controller.error(new DOMException("Aborted", "AbortError")),
				);
			},
		});
		return new Response(body, { headers });
	};

interface FrameProps {
	platform: PlatformAdapter;
	bookValue: LibraryBook;
	server?: FakeServer;
	/** Clicks the first file's download once the drawer is up. */
	startDownload?: boolean;
}

/** The drawer over a stand-in for the Books page, status bar included. */
const Frame = ({ platform, bookValue, server, startDownload }: FrameProps) => {
	const [ready, setReady] = useState(server === undefined);
	useEffect(() => {
		document.documentElement.dataset.platform = platform.os;
		useLibraryStore.setState({
			library: { readOnly: false } as Library,
			tags: [],
			series: [],
		});
		if (server === undefined) return;
		const real = window.fetch;
		window.fetch = fakeFetch(server, real.bind(window));
		setReady(true);
		return () => {
			window.fetch = real;
		};
	}, [platform, server]);
	useEffect(() => {
		if (!ready || !startDownload) return;
		const timer = setTimeout(() => {
			document
				.querySelector<HTMLElement>('[aria-label^="Download EPUB"]')
				?.click();
		}, 300);
		return () => clearTimeout(timer);
	}, [ready, startDownload]);
	const router = useMemo(
		() =>
			createRouter({
				routeTree: createRootRoute({
					component: () => (
						<Page>
							<BookDetailsDrawer
								book={bookValue}
								open
								onClose={() => {}}
								returnFocusRef={{ current: null }}
								className={booksStyles.drawer}
							/>
						</Page>
					),
				}),
				history: createMemoryHistory(),
			}),
		[bookValue],
	);
	if (!ready) return null;
	return (
		<PlatformProvider value={platform}>
			<RouterProvider router={router} />
		</PlatformProvider>
	);
};

const Page = ({ children }: { children: ReactNode }) => (
	<div
		className={booksStyles.page}
		style={{ position: "fixed", inset: 0, background: "var(--ctd-content-bg)" }}
	>
		<div style={{ flex: 1 }} />
		<div className={booksStyles.footer}>
			<span className={booksStyles.footerText}>1,204 books</span>
		</div>
		{children}
	</div>
);

const meta: Meta<typeof Frame> = {
	title: "Components/Organisms/BookDrawer",
	component: Frame,
	parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof Frame>;

/** Kindle for EPUB, Preview for PDF, nothing for AZW3 (a generic Open). */
export const MacDesktop: Story = {
	args: { platform: desktopPlatform("macos"), bookValue: LOCAL_BOOK },
};

export const WindowsDesktop: Story = {
	args: { platform: desktopPlatform("windows"), bookValue: LOCAL_BOOK },
};

export const LinuxDesktop: Story = {
	args: { platform: desktopPlatform("linux"), bookValue: LOCAL_BOOK },
};

/** A browser on a desktop-sized screen: download only. */
export const Web: Story = {
	args: {
		platform: webPlatform("macos"),
		bookValue: REMOTE_BOOK,
		server: "stalls",
	},
};

export const WebDownloading: Story = {
	args: { ...Web.args, server: "stalls", startDownload: true },
};

export const WebDownloaded: Story = {
	args: { ...Web.args, server: "delivers", startDownload: true },
};

export const WebFailed: Story = {
	args: { ...Web.args, server: "fails", startDownload: true },
};

/** Phones: the row is the button; view these at phone width. */
export const Mobile: Story = {
	args: { ...Web.args, platform: webPlatform("ios") },
	globals: { viewport: { value: "mobile1" } },
};

export const MobileDownloading: Story = {
	args: { ...Mobile.args, startDownload: true },
	globals: Mobile.globals,
};
