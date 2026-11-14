import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { AlertDialog } from "./AlertDialog";
import { Button } from "./Button";

const Demo = ({ destructive }: { destructive: boolean }) => {
	const [open, setOpen] = useState(true);
	return (
		<>
			<Button onClick={() => setOpen(true)}>
				{destructive ? "Delete Book…" : "Forget…"}
			</Button>
			<AlertDialog
				open={open}
				onOpenChange={setOpen}
				title={destructive ? "Delete “Middlemarch”?" : "Forget “Fiction”?"}
				description={
					destructive
						? "This book and its files will be deleted from the library. Other books are not affected. This can't be undone."
						: "Your files will not be removed."
				}
				confirmLabel={destructive ? "Delete Permanently" : "Forget"}
				destructive={destructive}
				onConfirm={() => console.log("confirmed")}
			/>
		</>
	);
};

const meta: Meta<typeof AlertDialog> = {
	component: AlertDialog,
};

export default meta;
type Story = StoryObj<typeof meta>;

/** Cancel is the default (filled, takes Return); the destructive button is red text. */
export const Destructive: Story = {
	render: () => <Demo destructive />,
};

/** The confirm button is the default and takes Return. */
export const Confirmation: Story = {
	render: () => <Demo destructive={false} />,
};
