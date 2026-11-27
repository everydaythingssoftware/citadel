/**
 * An edit of several books applied, and then a library switch started. The
 * books changed, so the caller must not show a failure. The edit has no undo
 * entry, because the undo history belongs to the library that was open.
 */
export class LibrarySwitchedAfterEditError extends Error {
	constructor() {
		super("The edit applied, and then the library changed.");
		this.name = "LibrarySwitchedAfterEditError";
	}
}
