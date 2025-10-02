import type { ImportableBookMetadata } from "@/bindings";
import { LibraryEvents } from "@/lib/contexts/library";
import { LibraryEventNames } from "@/lib/contexts/library/context";
import { EventEmitter } from "@/lib/event";
import {  } from "@tauri-apps/api";
import type { Library } from "./_types";
import * as dialog from "@tauri-apps/plugin-dialog"

export const addBookByDragDrop = async (
	library: Library,
	paths: string[],
): Promise<ImportableBookMetadata[]> => {
	const importableMetadata = [];
	for (const path of paths) {
		const importableFile = await library.checkFileImportable(path);
		if (!importableFile) {
			continue;
		}
		const metadata = await library.getImportableFileMetadata(importableFile);
		if (!metadata) {
			continue;
		}

		importableMetadata.push(metadata);
	}

	return importableMetadata;
};

export const promptToAddBook = async (
	library: Library,
): Promise<ImportableBookMetadata | undefined> => {
	const validExtensions = (await library.listValidFileTypes()).map(
		(type) => type.extension,
	);
	let filePath = await dialog.open({
		multiple: false,
		directory: false,
		filters: [
			{
				name: "Importable files",
				extensions: validExtensions,
			},
		],
	});
	if (!filePath) {
		return;
	}
	if (typeof filePath === "object") {
		filePath = filePath[0];
	}
	const importableFile = await library.checkFileImportable(filePath);
	if (!importableFile) {
		console.error(`File ${filePath} not importable`);
		return;
	}
	const metadata = await library.getImportableFileMetadata(importableFile);
	if (!metadata) {
		console.error(`Failed to get metadata for file at ${filePath}`);
		return;
	}

	return metadata;
};

export const commitAddBook = async (
	library: Library,
	metadata: ImportableBookMetadata,
	eventEmitter: EventEmitter<LibraryEvents>,
) => {
	await library.addImportableFileByMetadata(metadata);
	eventEmitter.emit(LibraryEventNames.LIBRARY_BOOK_CREATED, {
		bookname: metadata.title,
	});
};
