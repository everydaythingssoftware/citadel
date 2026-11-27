import type { RefObject } from "react";
import { useRef } from "react";
import {
	Button,
	FormField,
	IconButton,
	Sheet,
	TagsInput,
	TextInput,
	Tooltip,
} from "@/components/ui";
import type { NameFieldView } from "@/lib/edit-books";
import { useEditBooksSheet } from "@/lib/hooks/use-edit-books-sheet";
import styles from "./EditBooksSheet.module.css";

/** The props of the sheet that edits several books. */
export interface EditBooksSheetProps {
	/** The element that gets the focus when the sheet closes. */
	returnFocusRef: RefObject<HTMLElement | null>;
}

interface NameFieldRowProps {
	label: string;
	field: NameFieldView;
	inputRef: RefObject<HTMLInputElement | null>;
}

/** A text field, with a clear button at its right. */
const NameFieldRow = ({ label, field, inputRef }: NameFieldRowProps) => (
	<div className={styles.nameRow}>
		<FormField label={label} className={styles.nameField}>
			<TextInput
				ref={inputRef}
				value={field.text}
				placeholder={field.placeholder}
				onChange={(event) => field.onType(event.currentTarget.value)}
			/>
		</FormField>
		<div className={styles.clearSlot}>
			{field.showsClear && (
				<Tooltip label={field.clearLabel}>
					<IconButton
						type="button"
						aria-label={field.clearLabel}
						className={styles.clearButton}
						onClick={() => {
							field.onClear();
							// The button disappears after the click, thus the code moves the
							// focus to the text field.
							inputRef.current?.focus();
						}}
					>
						×
					</IconButton>
				</Tooltip>
			)}
		</div>
	</div>
);

/**
 * The sheet that edits the series, the tags, the languages and the publisher
 * of the selected books. It renders the state of `useEditBooksSheet`.
 */
export const EditBooksSheet = ({ returnFocusRef }: EditBooksSheetProps) => {
	const sheet = useEditBooksSheet();
	const seriesRef = useRef<HTMLInputElement>(null);
	const publisherRef = useRef<HTMLInputElement>(null);
	return (
		<Sheet
			open={sheet.open}
			onOpenChange={(open) => {
				if (!open) sheet.cancel();
			}}
			title={sheet.title}
			width={440}
			dismissible={!sheet.saving}
			onOpenAutoFocus={(event) => {
				event.preventDefault();
				seriesRef.current?.focus();
			}}
			onCloseAutoFocus={(event) => {
				event.preventDefault();
				returnFocusRef.current?.focus();
			}}
		>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					sheet.save();
				}}
			>
				<div className={styles.sheetFields}>
					<NameFieldRow
						label="Series"
						field={sheet.series}
						inputRef={seriesRef}
					/>
					<div className={styles.tagsField}>
						<FormField label="Tags">
							<TagsInput {...sheet.tags} />
						</FormField>
						{sheet.tagsLoadFailed && (
							<p data-selectable className={styles.tagsNote}>
								Couldn't load the library's tags.
							</p>
						)}
					</div>
					<FormField label="Languages">
						<TagsInput {...sheet.languages} />
					</FormField>
					<NameFieldRow
						label="Publisher"
						field={sheet.publisher}
						inputRef={publisherRef}
					/>
				</div>
				{sheet.failure !== null && (
					<p role="alert" data-selectable className={styles.sheetFailure}>
						{sheet.failure}
					</p>
				)}
				<div className={styles.sheetFooter}>
					<Button disabled={sheet.saving} onClick={sheet.cancel}>
						Cancel
					</Button>
					<Button type="submit" variant="primary" disabled={sheet.saving}>
						{sheet.saving ? "Saving…" : "Save"}
					</Button>
				</div>
			</form>
		</Sheet>
	);
};
