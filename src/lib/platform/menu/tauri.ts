import { listen } from "@tauri-apps/api/event";
import { commands, events } from "@/bindings";
import type { MenuAdapter } from "../types";

export const onAddBook = (handler: () => void): Promise<() => void> =>
	listen("menu://add-book", handler);

export const tauriMenu: MenuAdapter = {
	onAddBook,
	onCommand: (handler) =>
		events.menuCommandChosen.listen((event) => handler(event.payload)),
	setState: async (state) => {
		const result = await commands.clbCmdSetMenuState(state);
		if (result.status === "error") throw new Error(result.error);
	},
};
