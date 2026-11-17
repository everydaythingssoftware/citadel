import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useKeymap } from "@/lib/hooks/use-keymap";
import { usePlatform } from "@/lib/platform/context";
import { overlayOpen } from "@/lib/keyboard-owner";
import type { KeyBinding } from "@/lib/keymap";

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
