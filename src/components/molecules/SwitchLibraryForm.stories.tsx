import type { Meta, StoryObj } from "@storybook/react";
import { some } from "@/lib/option";
import { CurrentLibraryCard } from "./CurrentLibraryCard";
import { LibraryListCard } from "./LibraryListCard";
import { SelectFirstLibrary, SwitchLibraryForm } from "./SwitchLibraryForm";

const meta: Meta<typeof SwitchLibraryForm> = {
	component: SwitchLibraryForm,
	argTypes: {},
};

export default meta;
type Story = StoryObj<typeof SwitchLibraryForm>;

export const AddLibraryForm: Story = {
	render: () => (
		<SwitchLibraryForm
			selectNewLibrary={() => Promise.resolve(some("/path/to/new/library"))}
			onSubmit={(data) => {
				console.log("Updated library path", data);
				return Promise.resolve({ ok: true as const });
			}}
		/>
	),
};

export const FirstLibrary: Story = {
	render: () => (
		<SelectFirstLibrary
			selectNewLibrary={() => Promise.resolve(some("/path/to/new/library"))}
			onSubmit={(data) => {
				console.log("Updated library path", data);
				return Promise.resolve({ ok: true as const });
			}}
		/>
	),
};

type LibraryListStory = StoryObj<typeof LibraryListCard>;

export const LibraryListSingle: LibraryListStory = {
	render: () => (
		<LibraryListCard
			currentLibraryId="123"
			libraries={[
				{
					id: "123",
					displayName: "My Library",
					absolutePath: "/path/to/library",
				},
			]}
			onSwitchLibrary={() => Promise.resolve()}
		/>
	),
};

export const LibraryListMany: LibraryListStory = {
	render: () => (
		<LibraryListCard
			currentLibraryId="123"
			libraries={[
				{
					id: "123",
					displayName: "My Library",
					absolutePath: "/path/to/library",
				},
				{
					id: "456",
					displayName: "Another Library",
					absolutePath: "/path/to/another/library",
				},
				{
					id: "789",
					displayName: "Archive",
					absolutePath: "/path/to/archive",
				},
			]}
			onSwitchLibrary={(id) => {
				console.log("Switch to library", id);
				return Promise.resolve();
			}}
		/>
	),
};

type CurrentLibraryStory = StoryObj<typeof CurrentLibraryCard>;

export const CurrentLibrary: CurrentLibraryStory = {
	render: () => (
		<CurrentLibraryCard
			library={{
				id: "123",
				displayName: "My Library",
				absolutePath: "/path/to/library",
			}}
			onRevealInFileManager={() => {}}
		/>
	),
};

export const CurrentLibraryNoReveal: CurrentLibraryStory = {
	render: () => (
		<CurrentLibraryCard
			library={{
				id: "123",
				displayName: "My Library",
				absolutePath: "/path/to/library",
			}}
			onRevealInFileManager={null}
		/>
	),
};
