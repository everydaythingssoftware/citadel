import type { Meta, StoryObj } from "@storybook/react";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { emptySelection } from "@/lib/book-selection";
import { PlatformProvider } from "@/lib/platform/context";
import type { PlatformAdapter } from "@/lib/platform/types";
import { Route as RootRoute } from "@/routes/__root";
import { useBookSelectionStore } from "@/stores/book-selection/store";
import { LibraryState, useLibraryStore } from "@/stores/library/store";
import { useSettings } from "@/stores/settings/store";
import { Books } from "./Books";
import {
	desktopStoryPlatform as desktopPlatform,
	fakeStoryLibrary,
	makeStoryBooks,
	webStoryPlatform as webPlatform,
} from "./books-story-fixtures";

interface FrameProps {
	platform: PlatformAdapter;
	/** Opens the details drawer on this book once the grid is up. */
	detailsIndex?: number;
	/** Pretends another app is in front (desktop only). */
	inactive?: boolean;
	/** How many books the library holds. */
	bookCount?: number;
}

/** The Books page inside the real window shell: toolbar, sidebar, status bar. */
const Frame = ({
	platform,
	detailsIndex,
	inactive = false,
	bookCount = 60,
}: FrameProps) => {
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
		const books = makeStoryBooks(bookCount, desktop);
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
			library: fakeStoryLibrary(books),
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
	}, [platform, detailsIndex, inactive, bookCount]);
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

/** Enough rows to scroll deep, as a column change keeps the top row's books in view. */
export const MacLargeLibrary: Story = {
	args: { platform: desktopPlatform("macos"), bookCount: 1200 },
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

export const WebDesktop: Story = {
	args: { platform: webPlatform("macos") },
};

export const WebDetails: Story = {
	args: { platform: webPlatform("macos"), detailsIndex: 1 },
};

export const PhoneDetails: Story = {
	args: { platform: webPlatform("ios"), detailsIndex: 1 },
	globals: { viewport: { value: "mobile1" } },
};
