import type { Meta, StoryObj } from "@storybook/react";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { MenuCommandHost } from "@/components/organisms/MenuCommandHost";
import { emptySelection } from "@/lib/book-selection";
import { none, some } from "@/lib/option";
import { PlatformProvider } from "@/lib/platform/context";
import type { OperatingSystem } from "@/lib/platform/os";
import type {
	MenuAdapter,
	MenuCommand,
	PlatformAdapter,
} from "@/lib/platform/types";
import { useBookSelectionStore } from "@/stores/book-selection/store";
import { LibraryState, useLibraryStore } from "@/stores/library/store";
import { Books } from "./Books";
import {
	desktopStoryPlatform,
	fakeStoryLibrary,
	makeStoryBooks,
	storyLog,
	webStoryPlatform as webPlatform,
} from "./books-story-fixtures";

/**
 * The macOS menu bar, faked: what the window pushes is logged, and
 * `window.storyMenu("undo")` chooses an item, as clicking it in the menu
 * bar would.
 */
const fakeMenuBar: MenuAdapter = {
	onCommand: async (handler) => {
		(window as { storyMenu?: (command: MenuCommand) => void }).storyMenu =
			handler;
		return () => {};
	},
	setState: storyLog("menu bar"),
};

const desktopPlatform = (os: OperatingSystem): PlatformAdapter => ({
	...desktopStoryPlatform(os),
	menu: os === "macos" ? some(fakeMenuBar) : none(),
});

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
		const library = fakeStoryLibrary(makeStoryBooks(count, desktop), {
			readOnly,
		});
		useBookSelectionStore.setState({
			selection: emptySelection,
			detailsOpen: false,
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
						<>
							<Books />
							<MenuCommandHost />
						</>
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
