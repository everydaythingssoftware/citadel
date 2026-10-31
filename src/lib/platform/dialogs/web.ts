import type { DialogAdapter } from "../types";

/**
 * Opens the browser's file chooser. Must run inside a user gesture. Browsers
 * fire `cancel` when the chooser closes without a choice (older ones never
 * settle, which only leaves the promise pending).
 */
const chooseFiles: DialogAdapter["chooseFiles"] = ({ extensions, multiple }) =>
	new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = multiple ?? false;
		input.accept = extensions.map((extension) => `.${extension}`).join(",");
		input.style.display = "none";
		const finish = (files: File[]) => {
			input.remove();
			resolve(files);
		};
		input.addEventListener(
			"change",
			() => finish(Array.from(input.files ?? [])),
			{
				once: true,
			},
		);
		input.addEventListener("cancel", () => finish([]), { once: true });
		document.body.append(input);
		input.click();
	});

export const createWebDialogs = (): DialogAdapter => ({
	openFile: () => Promise.resolve(null),
	openDirectory: () => Promise.resolve(null),
	chooseFiles,
});
