import * as RadixAlertDialog from "@radix-ui/react-alert-dialog";
import type { FormEvent } from "react";
import { F7BookFill } from "@/components/icons/F7BookFill";
import { Button, TextInput } from "@/components/ui";
import {
	type AddLibraryEvent,
	type AddLibraryStep,
	folderName,
	joinFolder,
} from "@/lib/add-library/flow";
import { abbreviateHomePath, useHomeDir } from "@/lib/hooks/use-home-dir";
import styles from "./AddLibraryDialog.module.css";

interface AddLibraryDialogProps {
	step: AddLibraryStep;
	send: (event: AddLibraryEvent) => void;
}

type DialogStep = Extract<
	AddLibraryStep,
	{ id: "open-inside" | "create-here" | "create-inside" }
>;

const isDialogStep = (step: AddLibraryStep): step is DialogStep =>
	step.id === "open-inside" ||
	step.id === "create-here" ||
	step.id === "create-inside";

const plural = (count: number, word: string) =>
	`${count.toLocaleString()} ${count === 1 ? word : `${word}s`}`;

const NewFolderIcon = () => (
	<svg
		className={styles.icon}
		viewBox="0 0 24 24"
		aria-hidden="true"
		data-tone="folder"
	>
		<path d="M2.5 6.5a2 2 0 0 1 2-2h4.2l2 2h8.8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-11Z" />
		<path
			className={styles.iconMark}
			d="M12 10v6M9 13h6"
			fill="none"
			strokeWidth="1.8"
			strokeLinecap="round"
		/>
	</svg>
);

/**
 * The questions "Add Library…" asks once it has looked inside the picked
 * folder: open the library found one level down, create one in an empty
 * folder, or create one in its own folder beside other files.
 */
export const AddLibraryDialog = ({ step, send }: AddLibraryDialogProps) => {
	const home = useHomeDir();
	const open = isDialogStep(step);

	return (
		<RadixAlertDialog.Root
			open={open}
			onOpenChange={(next) => {
				if (!next) send({ type: "CANCEL" });
			}}
		>
			<RadixAlertDialog.Portal>
				<RadixAlertDialog.Overlay className={styles.overlay} />
				<RadixAlertDialog.Content
					className={styles.content}
					onEscapeKeyDown={(event) => {
						if (open && step.busy) event.preventDefault();
					}}
				>
					{open && (
						<DialogBody
							step={step}
							send={send}
							abbreviate={(path) => abbreviateHomePath(path, home)}
						/>
					)}
				</RadixAlertDialog.Content>
			</RadixAlertDialog.Portal>
		</RadixAlertDialog.Root>
	);
};

interface DialogBodyProps {
	step: DialogStep;
	send: (event: AddLibraryEvent) => void;
	abbreviate: (path: string) => string;
}

const DialogBody = ({ step, send, abbreviate }: DialogBodyProps) => {
	const submit = (event: FormEvent) => {
		event.preventDefault();
		send({ type: "CONFIRM" });
	};

	const nameIsField = step.id === "create-inside";
	const footerError = nameIsField ? null : step.error;

	return (
		<form className={styles.form} onSubmit={submit}>
			{step.id === "open-inside" ? (
				<F7BookFill className={styles.icon} aria-hidden="true" />
			) : (
				<NewFolderIcon />
			)}
			<RadixAlertDialog.Title className={styles.title}>
				{step.id === "open-inside"
					? `Open “${folderName(step.libraryPath)}”?`
					: step.id === "create-here"
						? "Create a new library?"
						: `Create a new library inside “${folderName(step.folder)}”?`}
			</RadixAlertDialog.Title>
			{step.id === "open-inside" && step.bookCount !== null && (
				<RadixAlertDialog.Description className={styles.description}>
					Your library has {plural(step.bookCount, "book")}.
				</RadixAlertDialog.Description>
			)}
			{step.id === "create-inside" && (
				<RadixAlertDialog.Description className={styles.description}>
					Your other files won’t be touched.
				</RadixAlertDialog.Description>
			)}
			{step.id === "create-inside" && (
				<div className={styles.nameField}>
					<TextInput
						label="Folder name"
						value={step.name}
						error={step.error}
						disabled={step.busy}
						autoFocus
						spellCheck={false}
						className={styles.nameInput}
						onFocus={(event) => event.currentTarget.select()}
						onChange={(event) =>
							send({ type: "NAME_CHANGED", name: event.currentTarget.value })
						}
					/>
				</div>
			)}
			<span className={styles.path}>
				{abbreviate(
					step.id === "open-inside"
						? step.libraryPath
						: step.id === "create-here"
							? step.folder
							: joinFolder(step.folder, step.name.trim()),
				)}
			</span>
			{footerError && (
				<p className={styles.error} role="alert">
					{footerError}
				</p>
			)}
			<div className={styles.buttons}>
				<RadixAlertDialog.Cancel asChild>
					<Button fullWidth disabled={step.busy}>
						Cancel
					</Button>
				</RadixAlertDialog.Cancel>
				<Button
					type="submit"
					variant="primary"
					fullWidth
					disabled={step.busy}
					autoFocus={!nameIsField}
				>
					{step.id === "open-inside"
						? step.busy
							? "Opening…"
							: "Open Library"
						: step.busy
							? "Creating…"
							: "Create Library"}
				</Button>
			</div>
			{step.id !== "create-here" && (
				<Button
					variant="subtle"
					fullWidth
					disabled={step.busy}
					className={styles.alternative}
					onClick={() =>
						send({
							type:
								step.id === "open-inside" ? "CREATE_INSTEAD" : "CHOOSE_ANOTHER",
						})
					}
				>
					{step.id === "open-inside"
						? "Create a library…"
						: "Choose another folder…"}
				</Button>
			)}
		</form>
	);
};
