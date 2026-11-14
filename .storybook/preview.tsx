import { addons } from "storybook/preview-api";
import type { Preview } from "@storybook/react";
import React, { type PropsWithChildren, useEffect, useCallback } from "react";
import { DARK_MODE_EVENT_NAME } from "storybook-dark-mode";

import { TooltipProvider } from "../src/components/ui";
import "../src/styles.css";

const STORYBOOK_IFRAME_PADDING_OFFSET = "36px";
const FULL_HEIGHT_MINUS_SB_PADDING = `calc(100svh - ${STORYBOOK_IFRAME_PADDING_OFFSET}`;

const channel = addons.getChannel();

function ColorSchemeWrapper({ children }: PropsWithChildren<unknown>) {
	const handleColorScheme = useCallback((value: boolean) => {
		// Same attribute the app's theme manager sets (see src/lib/theme-manager.ts)
		document.documentElement.setAttribute(
			"data-theme",
			value ? "dark" : "light",
		);
	}, []);

	useEffect(() => {
		channel.on(DARK_MODE_EVENT_NAME, handleColorScheme);
		return () => channel.off(DARK_MODE_EVENT_NAME, handleColorScheme);
	}, [handleColorScheme]);

	return <>{children}</>;
}

/**
 * Same attributes main.tsx sets on <html>, switchable from the toolbar so
 * platform-adaptive components can be compared side by side.
 */
function PlatformAttributes({
	platform,
	focusRing,
	children,
}: PropsWithChildren<{ platform: string; focusRing: string }>) {
	useEffect(() => {
		const html = document.documentElement;
		html.dataset.platform = platform;
		html.dataset.runtime = "web";
		if (focusRing === "accent") html.dataset.focusRing = "accent";
		else delete html.dataset.focusRing;
	}, [platform, focusRing]);
	return <>{children}</>;
}

const preview: Preview = {
	globalTypes: {
		platform: {
			description: "data-platform on <html>",
			toolbar: {
				title: "Platform",
				icon: "browser",
				items: ["macos", "windows", "linux", "ios"],
				dynamicTitle: true,
			},
		},
		focusRing: {
			description: "data-focus-ring on <html>",
			toolbar: {
				title: "Focus ring",
				icon: "eye",
				items: ["monochrome", "accent"],
				dynamicTitle: true,
			},
		},
	},
	initialGlobals: { platform: "macos", focusRing: "monochrome" },
	parameters: {
		controls: {
			matchers: {
				color: /(background|color)$/i,
				date: /Date$/i,
			},
		},
	},
	decorators: [
		(Story, context) => (
			<PlatformAttributes
				platform={String(context.globals.platform ?? "macos")}
				focusRing={String(context.globals.focusRing ?? "monochrome")}
			>
				<Story />
			</PlatformAttributes>
		),
		(Story) => (
			<ColorSchemeWrapper>
				{/* Same provider the app mounts in App.tsx. */}
				<TooltipProvider>
					<Story />
				</TooltipProvider>
			</ColorSchemeWrapper>
		),
		(Story) => (
			<div
				style={{
					display: "grid",
					gridTemplateRows: "1fr",
					height: FULL_HEIGHT_MINUS_SB_PADDING,
					minHeight: FULL_HEIGHT_MINUS_SB_PADDING,
					padding: 16,
					overflowY: "scroll",
					background: "var(--ctd-content-bg)",
				}}
			>
				<Story />
			</div>
		),
	],
};

export default preview;
