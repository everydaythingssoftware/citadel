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

export type SelectFirstLibraryProps = AddNewLibraryPathFomProps;

export const SelectFirstLibrary = (props: SelectFirstLibraryProps) => {
	return (
		<div className={styles.stack}>
			<p className={styles.text}>
				Select the folder where your Calibre library is. This is a folder that
				contains a metadata.db file as well as folders for each author in your
				library.
			</p>
			<AddNewLibraryPathForm {...props} />
		</div>
	);
};

export interface SwitchLibraryFormProps extends AddNewLibraryPathFomProps {
	currentLibraryId: string;
	libraries: {
		id: string;
		displayName: string;
		absolutePath: string;
	}[];
	selectExistingLibrary: (id: string) => Promise<void>;
}

export const SwitchLibraryForm = ({
	currentLibraryId,
	libraries,
	selectExistingLibrary,
	...props
}: SwitchLibraryFormProps) => {
	const currentLibraryPath = libraries.find(
		(library) => library.id === currentLibraryId,
	)?.absolutePath;

	return (
		<div className={styles.stack}>
			<div className={styles.currentLibrary}>
				<p className={styles.text}>Current library:</p>
				<code className={styles.code}>{currentLibraryPath}</code>
			</div>
			{libraries.length > 1 && (
				<>
					<h3 className={styles.heading}>
						Select an existing library to switch to
					</h3>
					<div className={styles.libraryGrid}>
						{libraries.map((library) => (
							<Button
								key={library.id}
								variant="default"
								disabled={library.id === currentLibraryId}
								onClick={safeAsyncEventHandler(async () => {
									if (library.id === currentLibraryId) return;
									await selectExistingLibrary(library.id);
								})}
							>
								{library.displayName}
							</Button>
						))}
					</div>
				</>
			)}
			<AddNewLibraryPathForm {...props} />
		</div>
	);
};

interface AddNewLibraryPathFomProps {
	onSubmit: (formData: SwitchLibraryForm) => Promise<AddLibraryResult>;
	selectNewLibrary: () => Promise<Option<string>>;
}

const AddNewLibraryPathForm = ({
	onSubmit,
	selectNewLibrary: addNewLibraryByPath,
}: AddNewLibraryPathFomProps) => {
	const [libraryPath, setLibraryPath] = useState("");
	const [error, setError] = useState<string | undefined>(undefined);

	return (
		<form
			className={styles.stack}
			onSubmit={(event) => {
				event.preventDefault();
				if (libraryPath === "") {
					setError("Library path is required");
					return;
				}
				safeAsyncEventHandler(async () => {
					const result = await onSubmit({ libraryPath });
					setError(result.ok ? undefined : result.message);
				})();
			}}
		>
			<FormField
				label="Library path"
				description="This folder contains your metadata.db"
				error={error}
			>
				{/* The path comes from the native directory picker, never from
				    typing, so the field is read-only and a pointer-down opens
				    the picker (same interaction as before). */}
				<TextInput
					value={libraryPath}
					readOnly
					onPointerDown={safeAsyncEventHandler(async () => {
						const libPathOption = await addNewLibraryByPath();
						if (!libPathOption.isSome) return;

						setLibraryPath(libPathOption.value);
						setError(undefined);
					})}
				/>
			</FormField>
			<Button variant="primary" fullWidth type="submit" disabled={!libraryPath}>
				Add library
			</Button>
		</form>
	);
};
