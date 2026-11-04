import type {
	DetectedLibrary,
	LegacyLibraryImport,
	LibraryEntry,
	LibraryStats,
	SyncStatus,
} from "@/bindings";
import type { components } from "@/lib/api/schema.generated";
import type { Library, Options } from "../library";

/** The library a server serves, as its administrator sees it. */
export type ServedLibrary = components["schemas"]["ServedLibraryInfo"];
export type LibrarySetup = components["schemas"]["LibrarySetup"];
export type PathInspection = components["schemas"]["Inspection"];
/** Libraries in the folders mounted for them, and empty mounts to start one in. */
export type FoundLibraries = components["schemas"]["FoundLibraries"];
export type InspectionStatus = components["schemas"]["InspectionStatus"];
export type InspectedLibrary = components["schemas"]["InspectedLibrary"];
export type DirectoryListing = components["schemas"]["DirectoryListing"];
export type DirectoryEntry = components["schemas"]["DirectoryEntry"];
export type ChooseLibrary = components["schemas"]["ChooseLibrary"];
export type SchemaUpgrade = components["schemas"]["SchemaUpgradeInfo"];

/**
 * Choosing the library a server serves (ADR 0012). Administrators only; the
 * desktop, which picks folders natively, has none of this.
 */
export interface LibrarySetupOperations {
	/** The served library, if one was chosen, and where the folder browser starts. */
	status(): Promise<LibrarySetup>;
	/** What is at an absolute server path, without changing anything. */
	inspect(path: string): Promise<PathInspection>;
	/** A server folder's subfolders; the browse root when `path` is omitted. */
	listDirectory(path?: string): Promise<DirectoryListing>;
	/** Create a library at a path or adopt the one there, and start serving it. */
	choose(request: ChooseLibrary): Promise<ServedLibrary>;
	/** Try the registered folder again after it was unreachable. */
	reopen(): Promise<ServedLibrary>;
	/** Bring the served library to Calibre's current database format. */
	upgrade(): Promise<SchemaUpgrade>;
}

export interface LibraryCatalog {
	open(options: Options): Promise<Library>;
	create(path: string): Promise<void>;
	isValid(path: string): Promise<boolean>;
	detect(): Promise<DetectedLibrary | null>;
	defaultNewPath(): Promise<string>;
	stats(path: string): Promise<LibraryStats>;
	syncStatus(path: string): Promise<SyncStatus>;
	/** Registered libraries, keyed by Calibre library UUID (ADR 0009). */
	list(): Promise<LibraryEntry[]>;
	/** Adds the library at `path`, or returns its existing entry. */
	register(path: string): Promise<LibraryEntry>;
	rename(id: string, displayName: string): Promise<LibraryEntry>;
	/** Moves a pre-registry settings.json library list into the registry. */
	importLegacy(entries: LibraryEntry[]): Promise<LegacyLibraryImport>;
	/** Called with the full list whenever any window changes it. */
	onChange(listener: (libraries: LibraryEntry[]) => void): Promise<() => void>;
	/** Server-side setup; every call fails on the desktop. */
	setup: LibrarySetupOperations;
}
