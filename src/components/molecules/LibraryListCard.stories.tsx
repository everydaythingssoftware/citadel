import type { Meta, StoryObj } from "@storybook/react";
import type { LibraryStatsState } from "@/lib/hooks/use-library-stats";
import { PlatformProvider } from "@/lib/platform/context";
import type { LibraryPath } from "@/lib/platform/settings/types";
import type { PlatformAdapter } from "@/lib/platform/types";
import { LibraryListCard } from "./LibraryListCard";

const MOCK_PLATFORM: PlatformAdapter = {
	capabilities: {
		canPickLocalFiles: true,
		canRevealInFileManager: true,
		canCopyToClipboard: true,
		canOpenLocalPaths: true,
		supportsAutoUpdates: true,
	},
	dialogs: {
		openFile: async () => null,
		openDirectory: async () => null,
	},
	clipboard: { writeText: async () => {} },
	fileOpener: {
		openPath: async () => {},
		revealInFileManager: async () => {},
	},
	window: { showMainWindow: async () => {} },
	settings: {
		initialize: async () => {
			throw new Error("Settings are not available in stories");
		},
		set: async () => {},
		get: async () => {
			throw new Error("Settings are not available in stories");
		},
	},
};

const FICTION: LibraryPath = {
	id: "lib-fiction",
	displayName: "Fiction",
	absolutePath: "/Users/phil/Calibre Libraries/Fiction",
};
const NON_FICTION: LibraryPath = {
	id: "lib-nonfiction",
	displayName: "Non-fiction",
	absolutePath: "/Users/phil/Calibre Libraries/Non-fiction",
};
const HISTORY: LibraryPath = {
	id: "lib-history",
	displayName: "History",
	absolutePath: "/Users/phil/Calibre Libraries/History",
};
const COOKING: LibraryPath = {
	id: "lib-cooking",
	displayName: "Cooking",
	absolutePath: "/Users/phil/Calibre Libraries/Cooking",
};
const LONG_NAME: LibraryPath = {
	id: "lib-long",
	displayName:
		"Everything I Read On Nineteenth-Century Maritime Adventure Novels (Annotated)",
	absolutePath: "/Users/phil/Calibre Libraries/Maritime Adventure",
};

const loadedStats = (
	bookCount: number,
	authorCount: number,
): LibraryStatsState => ({
	status: "loaded",
	stats: { book_count: bookCount, author_count: authorCount },
});

const statsByPath = (
	entries: [LibraryPath, LibraryStatsState][],
): ReadonlyMap<string, LibraryStatsState> =>
	new Map(entries.map(([library, stats]) => [library.absolutePath, stats]));

const render = (props: {
	currentLibraryId: string;
	libraries: LibraryPath[];
	stats: ReadonlyMap<string, LibraryStatsState>;
}) => (
	<PlatformProvider value={MOCK_PLATFORM}>
		<LibraryListCard
			currentLibraryId={props.currentLibraryId}
			libraries={props.libraries}
			statsByPath={props.stats}
			onSwitchLibrary={(id) => {
				console.log("Switch to library", id);
				return Promise.resolve();
			}}
		/>
	</PlatformProvider>
);

const meta: Meta<typeof LibraryListCard> = {
	component: LibraryListCard,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleLibrary: Story = {
	render: () =>
		render({
			currentLibraryId: FICTION.id,
			libraries: [FICTION],
			stats: statsByPath([[FICTION, loadedStats(1, 1)]]),
		}),
};

export const ManyLibraries: Story = {
	render: () =>
		render({
			currentLibraryId: FICTION.id,
			libraries: [FICTION, NON_FICTION, HISTORY, COOKING],
			stats: statsByPath([
				[FICTION, loadedStats(312, 87)],
				[NON_FICTION, loadedStats(1401, 402)],
				[HISTORY, loadedStats(64, 33)],
				[COOKING, loadedStats(28, 12)],
			]),
		}),
};

export const VeryLongName: Story = {
	render: () =>
		render({
			currentLibraryId: FICTION.id,
			libraries: [LONG_NAME, FICTION],
			stats: statsByPath([
				[LONG_NAME, loadedStats(89, 21)],
				[FICTION, loadedStats(312, 87)],
			]),
		}),
};

export const StatsLoading: Story = {
	render: () =>
		render({
			currentLibraryId: FICTION.id,
			libraries: [FICTION, NON_FICTION],
			stats: statsByPath([
				[FICTION, { status: "loading" }],
				[NON_FICTION, { status: "loading" }],
			]),
		}),
};

export const StatsError: Story = {
	render: () =>
		render({
			currentLibraryId: FICTION.id,
			libraries: [FICTION, NON_FICTION],
			stats: statsByPath([
				[FICTION, { status: "error" }],
				[NON_FICTION, { status: "error" }],
			]),
		}),
};

export const ActiveRowCheckmark: Story = {
	render: () =>
		render({
			currentLibraryId: HISTORY.id,
			libraries: [FICTION, HISTORY, COOKING],
			stats: statsByPath([
				[FICTION, loadedStats(312, 87)],
				[HISTORY, loadedStats(64, 33)],
				[COOKING, loadedStats(28, 12)],
			]),
		}),
};
