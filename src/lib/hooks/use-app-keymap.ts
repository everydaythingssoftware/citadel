import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useKeymap } from "@/lib/hooks/use-keymap";
import { usePlatform } from "@/lib/platform/context";
import type { KeyBinding } from "@/lib/keymap";

// Radix keeps overlay content mounted only while open, so any open dialog
// (Drawer, Sheet, AlertDialog) in the DOM should own the keyboard.
const overlayOpen = () =>
	document.querySelector(
		'[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
	) !== null;

export const useAppKeymap = () => {
	const navigate = useNavigate();
	const platform = usePlatform();
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});

	const bindings: KeyBinding[] = [];

	// The desktop settings window loads /settings in its own webview on this
	// same route tree. App-wide chords live in use-menu-commands.
	const inSettingsWindow =
		platform.capabilities.supportsNativeWindows &&
		pathname.startsWith("/settings");
	if (!inSettingsWindow && pathname.startsWith("/books/")) {
		bindings.push({
			chord: "escape",
			when: () => !overlayOpen(),
			onMatch: () => void navigate({ to: "/" }),
		});
	}

	useKeymap(bindings);
};
