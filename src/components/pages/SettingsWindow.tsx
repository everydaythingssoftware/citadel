import { usePlatform } from "@/lib/platform/context";
import { useEffect } from "react";
import { SettingsPanes } from "@/components/organisms/SettingsPanes";
import classes from "@/components/pages/SettingsWindow.module.css";
import { useNativeThemeSync } from "@/lib/hooks/use-native-theme-sync";
import {
	useApplyColorScheme,
	useResolvedColorScheme,
} from "@/lib/theme-manager";
import { useSettings } from "@/stores/settings/store";

/**
 * Resolves the current value of a --ctd-* color token to RGB by painting it
 * on a 1x1 canvas (computed styles may serialize as oklch(), which the
 * window API does not accept).
 */
const resolveTokenColor = (token: string): [number, number, number] | null => {
	const probe = document.createElement("div");
	probe.style.backgroundColor = `var(${token})`;
	document.body.appendChild(probe);
	const resolved = getComputedStyle(probe).backgroundColor;
	probe.remove();
	const canvas = document.createElement("canvas");
	canvas.width = 1;
	canvas.height = 1;
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	ctx.fillStyle = resolved;
	ctx.fillRect(0, 0, 1, 1);
	const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
	if (r === undefined || g === undefined || b === undefined) return null;
	return [r, g, b];
};

/**
 * Full-window settings, opened as its own webview window (label `settings`)
 * by the macOS menu bar or the sidebar gear. The web app shows SettingsPage
 * instead (see routes/settings.tsx).
 */
export const SettingsWindow = () => {
	const platform = usePlatform();
	const theme = useSettings((state) => state.theme);
	useNativeThemeSync();

	// Keep the document color scheme in sync with the persisted theme; this
	// window hydrates its own settings store (see src/main.tsx).
	useApplyColorScheme(theme);

	// macOS tints this window's real title bar from the window background
	// color, which menu.rs sets once at creation. Without this it stays the
	// creation-time color forever, e.g. a white bar on a dark window.
	const scheme = useResolvedColorScheme(theme);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scheme is a re-run trigger; the value is read from the DOM after the attribute effect above applies.
	useEffect(() => {
		if (!platform.capabilities.supportsNativeWindows) return;
		const rgb = resolveTokenColor("--ctd-bg");
		if (!rgb) return;
		void platform.window.setBackgroundColor([...rgb, 255]);
	}, [scheme, platform]);

	// The window is created hidden (menu.rs); the main window's reveal path
	// (window.show after library init) never runs on this route, so this
	// window must show itself. Two rAF ticks push the reveal past the first
	// real paint so no white or unstyled frame is ever visible.
	useEffect(() => {
		if (!platform.capabilities.supportsNativeWindows) return;
		let cancelled = false;
		const outer = requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (cancelled) return;
				void platform.window.show();
			});
		});
		return () => {
			cancelled = true;
			cancelAnimationFrame(outer);
		};
	}, [platform]);

	// Hide on close instead of destroying the webview, so reopening from the
	// menu is instant (menu.rs shows + focuses the existing window).
	useEffect(() => {
		if (!platform.capabilities.supportsNativeWindows) return;
		const unlisten = platform.window.hideOnClose();
		return () => {
			void unlisten.then((fn) => fn());
		};
	}, [platform]);

	return (
		<div className={classes.window}>
			<SettingsPanes />
		</div>
	);
};
