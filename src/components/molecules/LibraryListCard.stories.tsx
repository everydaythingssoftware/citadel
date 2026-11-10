import type { Meta, StoryObj } from "@storybook/react";
import type { LibraryStatsState } from "@/lib/hooks/use-library-stats";
import type { PendingRemoval } from "@/lib/library-list/pending-removals";
import { PlatformProvider } from "@/lib/platform/context";
import { createWebPlatform } from "@/lib/platform/create";
import type { LibraryPath } from "@/lib/platform/settings/types";
import type { PlatformAdapter } from "@/lib/platform/types";
import { LibraryListCard } from "./LibraryListCard";

const MOCK_PLATFORM: PlatformAdapter = {
	...createWebPlatform(),
	capabilities: {
		...createWebPlatform().capabilities,
		canPickLocalFiles: true,
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
	pendingRemovals?: PendingRemoval[];
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
			onRemoveLibrary={(library) => console.log("Remove", library.id)}
			pendingRemovals={props.pendingRemovals}
			onUndoRemove={(id) => console.log("Undo removing", id)}
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

const removed = (
	library: LibraryPath,
	before: LibraryPath[],
	error: string | null = null,
): PendingRemoval => ({
	library,
	before: before.map(({ id }) => id),
	wasActive: false,
	phase: "placeholder",
	error,
});

/** Two libraries just removed, each showing Undo in its old place. */
export const JustRemoved: Story = {
	render: () =>
		render({
			currentLibraryId: HISTORY.id,
			libraries: [NON_FICTION, HISTORY],
			stats: statsByPath([
				[NON_FICTION, loadedStats(140, 61)],
				[HISTORY, loadedStats(64, 33)],
			]),
			pendingRemovals: [
				removed(FICTION, [FICTION, NON_FICTION, HISTORY, COOKING]),
				removed(COOKING, [FICTION, NON_FICTION, HISTORY, COOKING]),
			],
		}),
};

export const UndoFailed: Story = {
	render: () =>
		render({
			currentLibraryId: HISTORY.id,
			libraries: [HISTORY],
			stats: statsByPath([[HISTORY, loadedStats(64, 33)]]),
			pendingRemovals: [
				removed(
					FICTION,
					[FICTION, HISTORY],
					"This library can no longer be restored.",
				),
			],
		}),
};
