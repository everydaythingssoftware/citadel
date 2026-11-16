import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { usePlatform } from "@/lib/platform/context";

/**
 * Opens the Settings UI. Settings live in their own window on the desktop; the
 * Rust command owns the window options and focuses the existing window if one
 * is already open. On the web there is no second window, so we route to the
 * in-app /settings page instead.
 */
export const useOpenSettings = (): (() => void) => {
	const platform = usePlatform();
	const navigate = useNavigate();
	return useCallback(() => {
		if (platform.capabilities.supportsNativeWindows) {
			void platform.window.openSettings();
		} else {
			void navigate({ to: "/settings" });
		}
	}, [navigate, platform]);
};
