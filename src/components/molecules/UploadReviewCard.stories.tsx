import type { Meta, StoryObj } from "@storybook/react";
import { type ComponentProps, useState } from "react";
import {
	fieldProblem,
	formForBook,
	type ReviewField,
	type ReviewForm,
	tidyField,
} from "@/lib/uploads/review";
import { UploadReviewCard } from "./UploadReviewCard";

const FORM = formForBook({
	format: "epub",
	title: "Moby-Dick",
	authorNames: ["Herman Melville"],
	identifier: "urn:isbn:9780142437247",
	publisher: "Harper & Brothers",
	language: "en",
	tags: ["Sea stories"],
	publicationDate: "1851-10-18",
	coverUrl: null,
});

const meta: Meta<typeof UploadReviewCard> = {
	component: UploadReviewCard,
	args: {
		form: FORM,
		authorSuggestions: ["Herman Melville", "Jane Austen"],
		tagSuggestions: ["Classics", "Sea stories", "Whaling", "Adventure"],
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

/** Static: prefilled from the file (language named, ISBN hyphenated). */
export const Prefilled: Story = {};

/** Static: the optional fields showing. */
export const DetailsOpen: Story = { args: { detailsOpen: true } };

/** Static: problems shown after leaving each field. */
export const WithProblems: Story = {
	args: {
		detailsOpen: true,
		form: {
			...FORM,
			title: "",
			identifier: "978-0-14-243724-8",
			publicationDate: "1851-13-40",
		},
		errors: {
			title: "A book needs a title",
			identifier: "This ISBN's check digit doesn't match",
			publicationDate: "Use a full date",
		},
	},
};

/** Static: the server couldn't add the book. */
export const AddFailed: Story = {
	args: { message: "This library can't take new books right now." },
};

const Editable = (args: ComponentProps<typeof UploadReviewCard>) => {
	const [form, setForm] = useState<ReviewForm>(args.form);
	const [touched, setTouched] = useState<ReviewField[]>([]);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const errors = Object.fromEntries(
		touched
			.map((field) => [field, fieldProblem(form, field)])
			.filter(([, problem]) => problem),
	);
	return (
		<div style={{ display: "grid", gap: 16 }}>
			<UploadReviewCard
				{...args}
				form={form}
				errors={errors}
				detailsOpen={detailsOpen}
				onToggleDetails={() => setDetailsOpen((open) => !open)}
				onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
				onLeaveField={(field) => {
					setForm((current) => ({ ...current, ...tidyField(current, field) }));
					setTouched((current) => [...new Set([...current, field])]);
				}}
			/>
			<pre style={{ fontSize: 11, color: "var(--ctd-ink-soft)", margin: 0 }}>
				{JSON.stringify(form, null, 2)}
			</pre>
		</div>
	);
};

/**
 * Interactive: errors appear only once you leave a field; an ISBN gets its
 * hyphens when you leave it; Language and Tags suggest as you type; More
 * Details unfolds and folds away.
 */
export const Editing: Story = { render: (args) => <Editable {...args} /> };
