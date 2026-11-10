import { commands, events } from "@/bindings";
import { createTauriLibrary } from "../library/tauri";
import type { LibraryCatalog } from "./types";

const unwrap = <T>(
	result: { status: "ok"; data: T } | { status: "error"; error: string },
): T => {
	if (result.status === "error") throw new Error(result.error);
	return result.data;
};

const desktopHasNoServerSetup = async (): Promise<never> => {
	throw new Error("Server library setup is unavailable on the desktop");
};

export const tauriLibraryCatalog: LibraryCatalog = {
	open: async (options) => {
		if (options.libraryType !== "calibre")
			throw new Error(`Unknown library type: ${options.libraryType}`);
		if (options.connectionType !== "local")
			throw new Error("Remote library connections are not available yet");
		unwrap(await commands.initClient(options.libraryPath));
		return createTauriLibrary();
	},
	create: async (path) => {
		unwrap(await commands.clbCmdCreateLibrary(path));
	},
	isValid: (path) => commands.clbQueryIsPathValidLibrary(path),
	detect: () => commands.clbQueryDetectCalibreLibrary(),
	defaultNewPath: async () =>
		unwrap(await commands.clbQueryDefaultNewLibraryPath()),
	inspectFolder: async (path) =>
		unwrap(await commands.clbQueryInspectLibraryFolder(path)),
	stats: async (path) => unwrap(await commands.clbQueryLibraryStats(path)),
	syncStatus: (path) => commands.clbQueryPathSyncStatus(path),
	list: async () => unwrap(await commands.clbQueryLibraries()),
	register: async (path) => unwrap(await commands.clbCmdRegisterLibrary(path)),
	rename: async (id, displayName) =>
		unwrap(await commands.clbCmdRenameLibrary(id, displayName)),
	remove: async (id) => {
		unwrap(await commands.clbCmdRemoveLibrary(id));
	},
	restore: async (id) => unwrap(await commands.clbCmdRestoreLibrary(id)),
	importLegacy: async (entries) =>
		unwrap(await commands.clbCmdImportLegacyLibraries(entries)),
	onChange: (listener) =>
		events.librariesChanged.listen((event) => listener(event.payload)),
	setup: {
		status: desktopHasNoServerSetup,
		inspect: desktopHasNoServerSetup,
		listDirectory: desktopHasNoServerSetup,
		choose: desktopHasNoServerSetup,
		reopen: desktopHasNoServerSetup,
		upgrade: desktopHasNoServerSetup,
	},
};
