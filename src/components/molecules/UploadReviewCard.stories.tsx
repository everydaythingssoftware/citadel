import type { Meta, StoryObj } from "@storybook/react";
import { type ComponentProps, useState } from "react";
import type { QueueItem } from "@/lib/uploads/queue";
import { formForBook, type ReviewForm } from "@/lib/uploads/review";
import { sampleQueue } from "@/lib/uploads/story-fixtures";
import { UploadReviewCard } from "./UploadReviewCard";

const [moby] = sampleQueue();
const item = moby as QueueItem;

const meta: Meta<typeof UploadReviewCard> = {
	component: UploadReviewCard,
	args: {
		item,
		form: formForBook(item.book),
		authorSuggestions: ["Herman Melville", "Jane Austen"],
	},
	decorators: [
		(Story) => (
			<div
				style={{
					maxWidth: 480,
					padding: 20,
					background: "var(--ctd-surface)",
					borderRadius: 10,
				}}
			>
				<Story />
			</div>
		),
	],
};

export default meta;
type Story = StoryObj<typeof UploadReviewCard>;

/** Static: prefilled from the file, with a generated cover since it had none. */
export const Prefilled: Story = {};

/** Static: a book that couldn't be added, with the reason. */
export const AddFailed: Story = {
	args: {
		item: { ...item, message: "This library can't take new books right now." },
	},
};

/** Static: a missing title blocks adding. */
export const NoTitle: Story = {
	args: { form: { ...formForBook(item.book), title: "" } },
};

const Editable = (args: ComponentProps<typeof UploadReviewCard>) => {
	const [form, setForm] = useState<ReviewForm>(args.form);
	return (
		<div style={{ display: "grid", gap: 16 }}>
			<UploadReviewCard
				{...args}
				form={form}
				onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
			/>
			<pre style={{ fontSize: 11, color: "var(--ctd-ink-soft)", margin: 0 }}>
				{JSON.stringify(form, null, 2)}
			</pre>
		</div>
	);
};

/** Interactive: edit any field, including the collapsed details. */
export const Editing: Story = { render: (args) => <Editable {...args} /> };
