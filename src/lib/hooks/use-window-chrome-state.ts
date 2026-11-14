import { useEffect } from "react";
import { usePlatform } from "@/lib/platform/context";

const setFlag = (name: "windowInactive" | "fullscreen", on: boolean) => {
	if (on) document.documentElement.dataset[name] = "";
	else delete document.documentElement.dataset[name];
};

const listen = (
	subscribe: Promise<() => void>,
	label: string,
): (() => void) => {
	let stop: (() => void) | undefined;
	let cancelled = false;
	subscribe
		.then((unlisten) => {
			if (cancelled) unlisten();
			else stop = unlisten;
		})
		.catch((error: unknown) => console.error(`${label}:`, error));
	return () => {
		cancelled = true;
		stop?.();
	};
};

/**
 * Mirrors the window's state onto <html> for CSS: `data-window-inactive`
 * while another window is in front (chrome goes grey, glass goes flat), and
 * `data-fullscreen` in full screen (no traffic-light inset).
 */
export const useWindowChromeState = (): void => {
	const platform = usePlatform();

	useEffect(() => {
		const stopActive = listen(
			platform.window.onActiveChange((active) =>
				setFlag("windowInactive", !active),
			),
			"Window focus",
		);
		const stopFullscreen = listen(
			platform.window.onFullscreenChange((fullscreen) =>
				setFlag("fullscreen", fullscreen),
			),
			"Full screen",
		);
		return () => {
			stopActive();
			stopFullscreen();
			setFlag("windowInactive", false);
			setFlag("fullscreen", false);
		};
	}, [platform]);
};
