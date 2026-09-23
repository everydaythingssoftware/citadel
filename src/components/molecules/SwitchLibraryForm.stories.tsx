import type { Meta, StoryObj } from "@storybook/react";
import { some } from "@/lib/option";
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
