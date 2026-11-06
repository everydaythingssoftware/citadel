import type { ClipboardAdapter } from "../types";

/**
 * Browsers only offer `navigator.clipboard` on https and localhost; a home
 * server reached over plain http (http://nas.local:8081) falls back to a
 * selected, off-screen textarea and the copy command.
 */
const copyBySelection = (text: string) => {
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.style.position = "fixed";
	area.style.top = "-1000px";
	area.style.opacity = "0";
	document.body.append(area);
	area.select();
	try {
		if (!document.execCommand("copy"))
			throw new Error("The browser refused to copy");
	} finally {
		area.remove();
	}
};

export const createWebClipboard = (): ClipboardAdapter => ({
	writeText: async (text) => {
		if (window.isSecureContext && navigator.clipboard) {
			await navigator.clipboard.writeText(text);
			return;
		}
		copyBySelection(text);
	},
});
