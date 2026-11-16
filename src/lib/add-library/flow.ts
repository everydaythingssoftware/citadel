import type { LibraryFolderContents } from "@/bindings";
import type { CreateErrorCode } from "@/lib/first-run/machine";

/**
 * "Add Library…": one action for opening and creating. The user picks any
 * folder; what it holds decides the next step, and no folder is a dead end.
 */
export type AddLibraryStep =
	| { id: "idle" }
	| { id: "picking" }
	| { id: "inspecting"; folder: string }
	/** The folder is a library: added and opened without a question. */
	| { id: "adding"; folder: string }
	| {
			id: "open-inside";
			folder: string;
			libraryPath: string;
			suggestedName: string;
			bookCount: number | null;
			busy: boolean;
			error: string | null;
	  }
	| { id: "create-here"; folder: string; busy: boolean; error: string | null }
	| {
			id: "create-inside";
			folder: string;
			name: string;
			busy: boolean;
			error: string | null;
	  };

export type AddLibraryEvent =
	| { type: "START" }
	| { type: "PICKED"; path: string | null }
	| { type: "INSPECTED"; contents: LibraryFolderContents }
	| { type: "INSPECT_FAILED"; message: string }
	| { type: "BOOK_COUNT"; libraryPath: string; count: number }
	| { type: "NAME_CHANGED"; name: string }
	| { type: "CONFIRM" }
	| { type: "CREATE_INSTEAD" }
	| { type: "CHOOSE_ANOTHER" }
	| { type: "CANCEL" }
	| { type: "SUCCEEDED" }
	| { type: "FAILED"; message: string; code?: CreateErrorCode };

export type AddLibraryEffect =
	| { type: "pick" }
	| { type: "inspect"; folder: string }
	| { type: "count-books"; libraryPath: string }
	| { type: "adopt"; path: string }
	| { type: "create"; path: string }
	/** A failure with no dialog on screen to show it in. */
	| { type: "notify-failure"; title: string; message: string };

export interface AddLibraryTransition {
	step: AddLibraryStep;
	effects: AddLibraryEffect[];
}

const IDLE: AddLibraryStep = { id: "idle" };

const stay = (step: AddLibraryStep): AddLibraryTransition => ({
	step,
	effects: [],
});

/** The folder's own name, for titles like "Create a New Library Inside “Books”?" */
export const folderName = (path: string): string => {
	const trimmed = path.replace(/[\\/]+$/, "");
	const name = trimmed.split(/[\\/]/).pop();
	return name && name.length > 0 ? name : trimmed;
};

export const joinFolder = (folder: string, name: string): string => {
	const separator = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
	return `${folder.replace(/[\\/]+$/, "")}${separator}${name}`;
};

/** Why `name` can't be a new folder's name; null when it can. */
export const folderNameProblem = (name: string): string | null => {
	const trimmed = name.trim();
	if (trimmed.length === 0) return "Enter a name for the folder.";
	if (/[\\/:]/.test(trimmed)) return "Folder names can’t contain / \\ or :.";
	if (trimmed === "." || trimmed === "..") return "Choose a different name.";
	return null;
};

const stepForContents = (
	folder: string,
	contents: LibraryFolderContents,
): AddLibraryTransition => {
	switch (contents.kind) {
		case "library":
			return {
				step: { id: "adding", folder },
				effects: [{ type: "adopt", path: folder }],
			};
		case "libraryInside":
			return {
				step: {
					id: "open-inside",
					folder,
					libraryPath: contents.library_path,
					suggestedName: contents.suggested_name,
					bookCount: null,
					busy: false,
					error: null,
				},
				effects: [{ type: "count-books", libraryPath: contents.library_path }],
			};
		case "empty":
			return stay({ id: "create-here", folder, busy: false, error: null });
		case "otherFiles":
			return stay({
				id: "create-inside",
				folder,
				name: contents.suggested_name,
				busy: false,
				error: null,
			});
	}
};

const createFailureMessage = (
	step: AddLibraryStep,
	message: string,
	code: CreateErrorCode | undefined,
): string => {
	if (step.id === "create-inside" && code !== undefined) {
		if (code === "folder-not-empty" || code === "already-a-library")
			return `“${folderName(step.folder)}” already has something called “${step.name.trim()}”. Try another name.`;
	}
	return message;
};

export const transition = (
	step: AddLibraryStep,
	event: AddLibraryEvent,
): AddLibraryTransition => {
	switch (event.type) {
		case "START":
			return step.id === "idle"
				? { step: { id: "picking" }, effects: [{ type: "pick" }] }
				: stay(step);

		case "PICKED":
			if (step.id !== "picking") return stay(step);
			return event.path === null
				? stay(IDLE)
				: {
						step: { id: "inspecting", folder: event.path },
						effects: [{ type: "inspect", folder: event.path }],
					};

		case "INSPECTED":
			return step.id === "inspecting"
				? stepForContents(step.folder, event.contents)
				: stay(step);

		case "INSPECT_FAILED":
			return step.id === "inspecting"
				? {
						step: IDLE,
						effects: [
							{
								type: "notify-failure",
								title: "Couldn’t read that folder",
								message: event.message,
							},
						],
					}
				: stay(step);

		case "BOOK_COUNT":
			return step.id === "open-inside" && step.libraryPath === event.libraryPath
				? stay({ ...step, bookCount: event.count })
				: stay(step);

		case "NAME_CHANGED":
			return step.id === "create-inside" && !step.busy
				? stay({ ...step, name: event.name, error: null })
				: stay(step);

		case "CONFIRM":
			switch (step.id) {
				case "open-inside":
					if (step.busy) return stay(step);
					return {
						step: { ...step, busy: true, error: null },
						effects: [{ type: "adopt", path: step.libraryPath }],
					};
				case "create-here":
					if (step.busy) return stay(step);
					return {
						step: { ...step, busy: true, error: null },
						effects: [{ type: "create", path: step.folder }],
					};
				case "create-inside": {
					if (step.busy) return stay(step);
					const problem = folderNameProblem(step.name);
					if (problem !== null) return stay({ ...step, error: problem });
					return {
						step: { ...step, busy: true, error: null },
						effects: [
							{
								type: "create",
								path: joinFolder(step.folder, step.name.trim()),
							},
						],
					};
				}
				default:
					return stay(step);
			}

		case "CREATE_INSTEAD":
			return step.id === "open-inside" && !step.busy
				? stay({
						id: "create-inside",
						folder: step.folder,
						name: step.suggestedName,
						busy: false,
						error: null,
					})
				: stay(step);

		case "CHOOSE_ANOTHER":
			return (step.id === "create-inside" ||
				step.id === "create-here" ||
				step.id === "open-inside") &&
				!step.busy
				? { step: { id: "picking" }, effects: [{ type: "pick" }] }
				: stay(step);

		case "CANCEL":
			if (
				(step.id === "open-inside" ||
					step.id === "create-here" ||
					step.id === "create-inside") &&
				!step.busy
			)
				return stay(IDLE);
			return stay(step);

		case "SUCCEEDED":
			return step.id === "adding" ||
				((step.id === "open-inside" ||
					step.id === "create-here" ||
					step.id === "create-inside") &&
					step.busy)
				? stay(IDLE)
				: stay(step);

		case "FAILED":
			if (step.id === "adding")
				return {
					step: IDLE,
					effects: [
						{
							type: "notify-failure",
							title: "Couldn’t add that library",
							message: event.message,
						},
					],
				};
			if (
				(step.id === "open-inside" ||
					step.id === "create-here" ||
					step.id === "create-inside") &&
				step.busy
			)
				return stay({
					...step,
					busy: false,
					error: createFailureMessage(step, event.message, event.code),
				});
			return stay(step);
	}
};

export const initialAddLibraryStep: AddLibraryStep = IDLE;
