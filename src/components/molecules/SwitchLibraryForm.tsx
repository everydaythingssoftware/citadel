import { useState } from "react";
import { F7Pencil } from "@/components/icons/F7Pencil";
import {
	Button,
	FormField,
	IconButton,
	TextInput,
	Tooltip,
} from "@/components/ui";
import { safeAsyncEventHandler } from "@/lib/async";
import type { Option } from "@/lib/option";
import { renameLibrary } from "@/stores/settings/actions";
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
							<LibraryRenameRow
								key={library.id}
								library={library}
								isCurrent={library.id === currentLibraryId}
								onSelect={selectExistingLibrary}
							/>
						))}
					</div>
				</>
			)}
			<AddNewLibraryPathForm {...props} />
		</div>
	);
};

interface LibraryRenameRowProps {
	library: {
		id: string;
		displayName: string;
		absolutePath: string;
	};
	isCurrent: boolean;
	onSelect: (id: string) => Promise<void>;
}

/** Switch row with Finder-style inline rename: the pencil (or a double-click
 * on the name) swaps in an input; Enter and blur commit, Escape cancels. */
const LibraryRenameRow = ({
	library,
	isCurrent,
	onSelect,
}: LibraryRenameRowProps) => {
	const [isRenaming, setIsRenaming] = useState(false);
	const [draftName, setDraftName] = useState(library.displayName);
	const [renameError, setRenameError] = useState<string | null>(null);

	const commitRename = async () => {
		try {
			await renameLibrary(library.id, draftName);
			setIsRenaming(false);
		} catch (e) {
			setRenameError(e instanceof Error ? e.message : String(e));
		}
	};

	const startRenaming = () => {
		setDraftName(library.displayName);
		setRenameError(null);
		setIsRenaming(true);
	};

	if (isRenaming) {
		return (
			<TextInput
				value={draftName}
				error={renameError}
				aria-label={`Library name for ${library.displayName}`}
				autoFocus
				className={styles.renameInput}
				onChange={(event) => {
					setDraftName(event.currentTarget.value);
					setRenameError(null);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						void commitRename();
					} else if (event.key === "Escape") {
						setIsRenaming(false);
					}
				}}
				onBlur={() => void commitRename()}
			/>
		);
	}

	return (
		<div className={styles.libraryRow}>
			<Button
				variant="default"
				disabled={isCurrent}
				className={styles.libraryNameButton}
				onClick={safeAsyncEventHandler(async () => {
					if (isCurrent) return;
					await onSelect(library.id);
				})}
				onDoubleClick={startRenaming}
			>
				{library.displayName}
			</Button>
			<Tooltip label="Edit library name">
				<IconButton
					aria-label={`Edit library name for ${library.displayName}`}
					className={styles.libraryRenameButton}
					onClick={startRenaming}
				>
					<F7Pencil width={14} height={14} />
				</IconButton>
			</Tooltip>
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
