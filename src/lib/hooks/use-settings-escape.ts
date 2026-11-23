import { useGoBack } from "@/lib/hooks/use-go-back";
import { useKeymap } from "@/lib/hooks/use-keymap";
import { escapeLayerOpen } from "@/lib/keyboard-owner";
import { panelTakesEscape } from "@/lib/keymap";
import { usePlatform } from "@/lib/platform/context";

/**
 * Escape closes Settings and returns to where you were: its own window
 * hides, the web page goes back. A pop-up, select list, menu or sheet open
 * inside Settings takes the press first, and so does a field with text.
 * Read in the window's capture phase, like the details panel's Escape, so
 * a tooltip that happens to be showing can't spend the press.
 */
export const useSettingsEscape = () => {
	const platform = usePlatform();
	const goBack = useGoBack();
	const ownWindow =
		platform.capabilities.supportsNativeWindows && !platform.window.isMain;
	useKeymap(
		[
			{
				chord: "escape",
				allowInEditable: true,
				when: (event) => panelTakesEscape(event.target, escapeLayerOpen()),
				onMatch: () => {
					if (!ownWindow) {
						goBack();
						return;
					}
					platform.window
						.hide()
						.catch((error: unknown) => console.error("Close Settings:", error));
				},
			},
		],
		{ capture: true },
	);
};
