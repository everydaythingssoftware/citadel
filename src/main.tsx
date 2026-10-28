import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { DatabaseRecoveryScreen } from "./components/organisms/DatabaseRecovery";
import "./styles.css";
import { PlatformProvider } from "@/lib/platform/context";
import { createPlatform } from "@/lib/platform/create";
import { useSettings } from "@/stores/settings/store";

const platform = createPlatform();

// The macOS window paints an NSVisualEffectView behind a transparent webview;
// only there may the page background go transparent (elsewhere it would show
// through to nothing).
if (
	platform.capabilities.supportsNativeWindows &&
	navigator.userAgent.includes("Mac")
) {
	document.documentElement.dataset.vibrancy = "true";
}

// biome-ignore lint/style/noNonNullAssertion: If this fails, we'll notice.
const root = ReactDOM.createRoot(document.getElementById("root")!);

const renderApp = () => {
	void useSettings.getState().init(platform.settings);
	root.render(
		<React.StrictMode>
			<PlatformProvider value={platform}>
				<Suspense>
					<App />
				</Suspense>
			</PlatformProvider>
		</React.StrictMode>,
	);
};

// A citadel.db the desktop couldn't open replaces the whole app: settings
// load the library list from it, so nothing else can start (ADR 0009).
void platform.recovery
	.problem()
	.catch(() => null)
	.then((problem) => {
		if (!problem) return renderApp();
		root.render(
			<React.StrictMode>
				<PlatformProvider value={platform}>
					<DatabaseRecoveryScreen problem={problem} />
				</PlatformProvider>
			</React.StrictMode>,
		);
	});
