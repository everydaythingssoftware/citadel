import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Button } from "./Button";
import { Sheet } from "./Sheet";
import { TextInput } from "./TextInput";

const Demo = () => {
	const [open, setOpen] = useState(true);
	const [name, setName] = useState("Unread Fiction");
	return (
		<>
			<Button onClick={() => setOpen(true)}>Save as Shelf…</Button>
			<Sheet
				open={open}
				onOpenChange={setOpen}
				title="Save as Shelf"
				width={420}
			>
				<form
					style={{ display: "flex", flexDirection: "column", gap: 16 }}
					onSubmit={(event) => {
						event.preventDefault();
						setOpen(false);
					}}
				>
					<TextInput
						label="Name"
						value={name}
						onChange={(event) => setName(event.currentTarget.value)}
					/>
					<div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
						<Button onClick={() => setOpen(false)}>Cancel</Button>
						<Button type="submit" variant="primary">
							Save Shelf
						</Button>
					</div>
				</form>
			</Sheet>
		</>
	);
};

const meta: Meta<typeof Sheet> = {
	component: Sheet,
};

export default meta;
type Story = StoryObj<typeof meta>;

/** A click outside does nothing; Escape and Cancel close it. */
export const Open: Story = {
	render: () => <Demo />,
};
