import type { Meta, StoryObj } from "@storybook/react";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { type CSSProperties, createContext, useContext, useMemo } from "react";
import { ContextMenu, type ContextMenuState } from "@/components/ui";
import { createWebPlatform } from "@/lib/platform/create";
import { PlatformProvider } from "@/lib/platform/context";
import type { SmartShelf } from "@/lib/platform/settings/types";
import { updateNoticeTitle } from "@/lib/updates/update-notice";
import {
	type SidebarShelf,
	SidebarView,
	type SidebarViewProps,
} from "./Sidebar";
import styles from "./Sidebar.module.css";

const shelf = (id: string, name: string): SmartShelf => ({
	id,
	name,
	filter: { query: "", sortOrder: "authorAz", hideRead: true },
});

const SHELVES: SidebarShelf[] = [
	{ shelf: shelf("unread", "Unread"), active: false },
	{ shelf: shelf("reading", "Reading Now"), active: true },
	{
		shelf: shelf("long", "Science Fiction Written Before the Moon Landing"),
		active: false,
	},
];

const noop = () => {};

const BASE: SidebarViewProps = {
	libraryHeader: <h2 className={styles.sectionLabel}>Library</h2>,
	currentPathname: "/authors",
	isAllBooksActive: false,
	onAllBooks: noop,
	shelves: [],
	onOpenShelf: noop,
	shelfMenu: () => ({}),
	shelfActions: {
		rename: null,
		startRename: noop,
		editRename: noop,
		commitRename: async () => {},
		cancelRename: noop,
	},
	updateNotice: null,
	updateMenu: {},
	showSettingsButton: false,
	settingsShowing: false,
	onOpenSettings: noop,
	session: null,
};

interface FrameProps extends SidebarViewProps {
	width: number;
	/** A right-click menu shown open over the sidebar. */
	menu?: ContextMenuState;
}

const FrameArgs = createContext<FrameProps | null>(null);

/**
 * The window around the sidebar: toolbar strip, the sidebar on the window
 * material, and the content panel with its hairlines and corner.
 */
const Window = () => {
	const args = useContext(FrameArgs);
	if (!args) return null;
	const { width, menu, ...props } = args;
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				height: 520,
				width: width + 360,
				background: "var(--ctd-shell-gradient)",
				border: "1px solid var(--ctd-border)",
				borderRadius: 10,
				overflow: "hidden",
			}}
		>
			<div style={{ height: 46, flexShrink: 0 }} />
			<div style={{ display: "flex", flex: 1, minHeight: 0 }}>
				<div style={{ width, flexShrink: 0, background: "var(--ctd-nav-bg)" }}>
					<SidebarView {...props} />
					{menu && <ContextMenu menu={menu} onClose={noop} />}
				</div>
				<div
					style={
						{
							flex: 1,
							background: "var(--ctd-content-bg)",
							borderTop: "1px solid var(--ctd-border)",
							borderLeft: "1px solid var(--ctd-border)",
							borderTopLeftRadius: "var(--ctd-radius-panel)",
						} as CSSProperties
					}
				/>
			</div>
		</div>
	);
};

const Frame = (args: FrameProps) => {
	const platform = useMemo(createWebPlatform, []);
	const router = useMemo(
		() =>
			createRouter({
				routeTree: createRootRoute({ component: Window }),
				history: createMemoryHistory(),
			}),
		[],
	);
	return (
		<PlatformProvider value={platform}>
			<FrameArgs.Provider value={args}>
				<RouterProvider router={router} />
			</FrameArgs.Provider>
		</PlatformProvider>
	);
};

const meta = {
	title: "Components/Organisms/Sidebar",
	component: Frame,
	parameters: { layout: "centered" },
	args: { ...BASE, width: 220 },
} satisfies Meta<typeof Frame>;

export default meta;
type Story = StoryObj<typeof meta>;

/** macOS desktop: no gear (Settings is ⌘, and the app menu). */
export const Default: Story = {};

export const WithShelves: Story = {
	args: { shelves: SHELVES, currentPathname: "/" },
};

/** An update has downloaded: the footer row where the gear was. */
export const WithUpdate: Story = {
	args: {
		shelves: SHELVES,
		currentPathname: "/",
		updateNotice: {
			version: "1.4.0",
			title: updateNoticeTitle("1.4.0"),
			restart: noop,
			hide: noop,
		},
	},
};

/** Windows and Linux desktop keep the gear, under the update row. */
export const WithUpdateAndGear: Story = {
	args: {
		...WithUpdate.args,
		showSettingsButton: true,
	},
};

/** The browser: a labelled Sign Out, and the gear. */
export const Web: Story = {
	args: {
		shelves: SHELVES.slice(0, 2),
		currentPathname: "/",
		isAllBooksActive: true,
		showSettingsButton: true,
		session: {
			username: "reader",
			administrator: false,
			signOut: async () => {},
		},
	},
};

export const Renaming: Story = {
	args: {
		shelves: SHELVES,
		currentPathname: "/",
		shelfActions: {
			...BASE.shelfActions,
			rename: { shelfId: "unread", draft: "Unread", error: null },
		},
	},
};

export const Narrow: Story = {
	args: { ...WithUpdate.args, width: 180 },
};

export const Wide: Story = {
	args: { ...WithShelves.args, width: 320 },
};

/** Right-click on a shelf: Rename and Delete… replace the hover icons. */
export const ShelfMenu: Story = {
	args: {
		...WithShelves.args,
		menu: {
			x: 250,
			y: 340,
			label: "Shelf Reading Now",
			items: [
				{ id: "rename", label: "Rename", onSelect: noop },
				{ type: "separator", id: "rename-separator" },
				{ id: "delete", label: "Delete…", destructive: true, onSelect: noop },
			],
		},
	},
};

/** Right-click on the update row. */
export const UpdateMenu: Story = {
	args: {
		...WithUpdate.args,
		menu: {
			x: 240,
			y: 515,
			label: "Update actions",
			items: [{ id: "hide", label: "Hide Until Next Update", onSelect: noop }],
		},
	},
};
