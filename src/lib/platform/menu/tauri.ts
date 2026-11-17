import { commands, events } from "@/bindings";
import type { MenuAdapter } from "../types";

export const tauriMenu: MenuAdapter = {
	onCommand: (handler) =>
		events.menuCommandChosen.listen((event) => handler(event.payload)),
	setState: async (update) => {
		const result = await commands.clbCmdSetMenuState(update);
		if (result.status === "error") throw new Error(result.error);
	},
};
