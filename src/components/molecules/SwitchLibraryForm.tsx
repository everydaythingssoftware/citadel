import { useState } from "react";
import { Button, FormField, TextInput } from "@/components/ui";
import { safeAsyncEventHandler } from "@/lib/async";
import type { Option } from "@/lib/option";
import styles from "./SwitchLibraryForm.module.css";

export interface SwitchLibraryForm {
	libraryPath: string;
}

/** Outcome of submitting a new library path; errors render inline. */
export type AddLibraryResult = { ok: true } | { ok: false; message: string };

export type SelectFirstLibraryProps = AddLibraryPathFormProps;

export const SelectFirstLibrary = (props: SelectFirstLibraryProps) => {
	return (
		<div className={styles.stack}>
			<p className={styles.text}>
				Choose your Calibre library folder: the one with a metadata.db file and
				a folder for each author.
			</p>
			<SwitchLibraryForm {...props} />
		</div>
	);
};

interface AddLibraryPathFormProps {
	onSubmit: (formData: SwitchLibraryForm) => Promise<AddLibraryResult>;
	selectNewLibrary: () => Promise<Option<string>>;
}

/** The add-library form: a read-only path field that opens the native
 * directory picker on pointer-down, then submits for validation. */
export const SwitchLibraryForm = ({
	onSubmit,
	selectNewLibrary: addNewLibraryByPath,
}: AddLibraryPathFormProps) => {
	const [libraryPath, setLibraryPath] = useState("");
	const [error, setError] = useState<string | undefined>(undefined);
	const choose = safeAsyncEventHandler(async () => {
		const libPathOption = await addNewLibraryByPath();
		if (!libPathOption.isSome) return;

		setLibraryPath(libPathOption.value);
		setError(undefined);
	});

	return (
		<form
			className={styles.stack}
			onSubmit={(event) => {
				event.preventDefault();
				if (libraryPath === "") {
					setError("Choose a library folder first.");
					return;
				}
				safeAsyncEventHandler(async () => {
					const result = await onSubmit({ libraryPath });
					setError(result.ok ? undefined : result.message);
				})();
			}}
		>
			<FormField label="Library folder" error={error}>
				{/* The path comes from the native directory picker, never from
				    typing, so the field is read-only and a pointer-down opens
				    the picker, as Choose… does. */}
				<div className={styles.pathRow}>
					<TextInput
						className={styles.pathInput}
						value={libraryPath}
						placeholder="No folder chosen"
						readOnly
						onPointerDown={choose}
					/>
					<Button variant="default" onClick={choose}>
						Choose…
					</Button>
				</div>
			</FormField>
			<div className={styles.actions}>
				<Button variant="primary" type="submit" disabled={!libraryPath}>
					Add Library
				</Button>
			</div>
		</form>
	);
};
