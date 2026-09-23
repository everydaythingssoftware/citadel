import type { Meta, StoryObj } from "@storybook/react";
import type { LibraryStatsState } from "@/lib/hooks/use-library-stats";
import type { LibraryPath } from "@/lib/platform/settings/types";
import { CurrentLibraryCard } from "./CurrentLibraryCard";

const FICTION: LibraryPath = {
	id: "lib-fiction",
	displayName: "Fiction",
	absolutePath: "/Users/phil/Calibre Libraries/Fiction",
};

const LOADED: LibraryStatsState = {
	status: "loaded",
	stats: { book_count: 312, author_count: 87 },
};

const meta: Meta<typeof CurrentLibraryCard> = {
	component: CurrentLibraryCard,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const WithCounts: Story = {
	render: () => (
		<CurrentLibraryCard
			library={FICTION}
			statsOverride={LOADED}
			onRevealInFileManager={() =>
				console.log("Reveal in Finder", FICTION.absolutePath)
			}
		/>
	),
};

export const StatsError: Story = {
	render: () => (
		<CurrentLibraryCard
			library={FICTION}
			statsOverride={{ status: "error" }}
			onRevealInFileManager={() =>
				console.log("Reveal in Finder", FICTION.absolutePath)
			}
		/>
	),
};

export const NoRevealCapability: Story = {
	render: () => (
		<CurrentLibraryCard
			library={FICTION}
			statsOverride={LOADED}
			onRevealInFileManager={null}
		/>
	),
};
