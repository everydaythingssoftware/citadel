import type { Meta, StoryObj } from "@storybook/react";
import { useArgs } from "storybook/preview-api";
import { some } from "@/lib/option";
import { SelectFirstLibrary, SwitchLibraryForm } from "./SwitchLibraryForm";

const meta: Meta<typeof SwitchLibraryForm> = {
	component: SwitchLibraryForm,
	argTypes: {},
};

export default meta;
type Story = StoryObj<typeof SwitchLibraryForm>;

export const Primary: Story = {
	args: {
		currentLibraryId: "123",
		libraries: [
			{
				id: "123",
				displayName: "My Library",
				absolutePath: "/path/to/library",
			},
		],
	},
	render: (args) => {
		return (
			<SwitchLibraryForm
				currentLibraryId={args.currentLibraryId}
				libraries={args.libraries}
				selectExistingLibrary={() => Promise.resolve()}
				selectNewLibrary={() => Promise.resolve(some("/path/to/new/library"))}
				onSubmit={(data) => {
					console.log("Updated library path", data);
					return Promise.resolve({ ok: true as const });
				}}
			/>
		);
	},
};

export const HasManyLibraries: Story = {
	args: {
		currentLibraryId: "123",
		libraries: [
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
		],
	},
	render: (args) => {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars, react-hooks/rules-of-hooks
		const [_args, updateArgs] = useArgs();
		return (
			<SwitchLibraryForm
				libraries={args.libraries}
				currentLibraryId={args.currentLibraryId}
				selectExistingLibrary={(id) => {
					updateArgs({ currentLibraryId: id });
					return Promise.resolve();
				}}
				selectNewLibrary={() => Promise.resolve(some("/path/to/new/library"))}
				onSubmit={(data) => {
					console.log("Updated library path", data);
					return Promise.resolve({ ok: true as const });
				}}
			/>
		);
	},
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
