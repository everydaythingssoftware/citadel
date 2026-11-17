import { shortcutEnvironment, windowShortcuts } from "@/lib/app-shortcuts";
import { useKeymap } from "@/lib/hooks/use-keymap";
import { usePlatform } from "@/lib/platform/context";

export const useWindowShortcuts = () => {
	const platform = usePlatform();
	useKeymap(
		windowShortcuts(shortcutEnvironment(platform), platform.window.isMain).map(
			({ command, chord }) => ({
				chord,
				allowInEditable: true,
				onMatch: () => {
					const action =
						command === "close-settings"
							? platform.window.hide
							: platform.window.toggleFullscreen.value;
					void action?.().catch((error: unknown) =>
						console.error("Window shortcut:", error),
					);
				},
			}),
		),
	);
};
