import { commands } from "@/bindings";
import { open } from "@tauri-apps/plugin-dialog";

export async function pickLibrary() {
	const selected = await open({
		multiple: false,
		directory: true,
		recursive: true,
		title: "Select Calibre Library Folder",
	});

	if (typeof selected === "string") {
		return selected;
	}

	return undefined;
}

export async function createLibrary(libraryRoot: string) {
	const create = await commands.clbCmdCreateLibrary(libraryRoot);
	if (create.status === "error") {
		console.error("Failed to create library", create.error);
		return;
	}
}
