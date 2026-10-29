import { createRouter, RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";
import {
	LoadingOverlay,
	Toaster,
	TooltipProvider,
	toast,
} from "@/components/ui";
import { IS_DEV } from "@/lib/env";
import { useInitializeLibraryStore } from "@/lib/hooks/use-initialize-library-store";
import { useLibrarySwitch } from "@/lib/hooks/use-library-switch";
import { useRestoredDatabaseNotice } from "@/lib/hooks/use-restored-database-notice";
import { usePlatform } from "@/lib/platform/context";
import { useApplyColorScheme } from "@/lib/theme-manager";
import { safeAsyncEventHandler } from "$lib/async";
import { BrowserLibraryGate } from "./components/organisms/BrowserLibraryGate";
import { FirstRunGate } from "./components/organisms/FirstRunFlow";
import { LibrarySwitchCurtain } from "./components/organisms/LibrarySwitchCurtain";
import { routeTree } from "./routeTree.gen";
import { useSettings } from "./stores/settings/store";

/**
 * Full-window pending fallback for routes that suspend past `defaultPendingMs`
 * (none of today's routes define a loader, but a slow future loader should
 * show a spinner rather than a frozen blank window).
 */
const RoutePending = () => (
	<div style={{ position: "relative", height: "100vh" }}>
		<LoadingOverlay visible />
	</div>
);

const router = createRouter({
	routeTree,
	// `pendingMs` = how long a match must stay pending before the pending
	// component appears. The library store is ready ~145ms after webview load,
	// so 150ms means the pending UI never flashes on the normal startup path
	// but still surfaces within a frame or two of a genuinely slow load.
	defaultPendingMs: 150,
	// `pendingMinMs` = minimum time the pending UI stays once shown
	// (anti-flash). It must be 0 here: in @tanstack/react-router 1.29.2 every
	// match renders once in "pending" status during the initial load, which
	// arms a `minPendingPromise` timer the commit then awaits — so ANY nonzero
	// value puts that many ms of dead time between data-ready and first paint
	// on every startup (the default 500 was measured to hold first grid paint
	// at ~620-690ms when data was ready at ~145ms).
	defaultPendingMinMs: 0,
	defaultPendingComponent: RoutePending,
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

export const App = () => {
	const hydrated = useSettings((state) => state.hydrated);
	const theme = useSettings((state) => state.theme);
	const platform = usePlatform();
	useApplyColorScheme(theme);
	const { stage: switchStage } = useLibrarySwitch();
	useRestoredDatabaseNotice(hydrated);

	useEffect(() => {
		if (hydrated) {
			safeAsyncEventHandler(() => platform.window.show())();
		}
	}, [hydrated, platform]);

	const droppedLibraries = useSettings((state) => state.droppedLibraries);
	useEffect(() => {
		if (droppedLibraries.length === 0) return;
		const names = droppedLibraries
			.map(({ displayName, absolutePath }) => displayName || absolutePath)
			.join(", ");
		const one = droppedLibraries.length === 1;
		toast.show({
			id: "dropped-libraries",
			title: one ? "A library is missing" : "Some libraries are missing",
			message: `Couldn’t find ${names}, so ${one ? "it’s" : "they’re"} no longer in your library list. Add ${one ? "it" : "them"} again from the new location.`,
			duration: 15000,
		});
	}, [droppedLibraries]);

	useEffect(() => {
		if (!hydrated || !platform.capabilities.supportsAutoUpdates || IS_DEV)
			return;

		const {
			autoUpdateCheckingEnabled,
			hasCompletedFirstLaunch,
			setHasCompletedFirstLaunch,
		} = useSettings.getState();

		if (!autoUpdateCheckingEnabled) return;
		if (!hasCompletedFirstLaunch) {
			safeAsyncEventHandler(async () => {
				await setHasCompletedFirstLaunch(true);
			})();
			return;
		}

		// A found update badges the sidebar gear (CDL-51).
		safeAsyncEventHandler(platform.updates.check)();
	}, [hydrated, platform]);

	if (!hydrated) {
		// No window is shown until settings are hydrated
		return null;
	}

	// FirstRunGate decides the boot path: first run (no library) and
	// broken-path (configured library fails validation) render the CDL-19
	// flow, which mounts the app beneath its card once a library is
	// committed; a healthy boot renders the app untouched. The switch
	// curtain sits outside the gate so it covers everything, including the
	// app remounting under first-run's handoff — the shell's from-ready
	// guard keeps it inert during onboarding.
	return (
		<TooltipProvider>
			<Toaster />
			{platform.capabilities.supportsNativeWindows ? (
				<FirstRunGate>
					<LibraryStoreInitializer>
						<RouterProvider router={router} />
					</LibraryStoreInitializer>
				</FirstRunGate>
			) : (
				<BrowserLibraryGate>
					<RouterProvider router={router} />
				</BrowserLibraryGate>
			)}
			<LibrarySwitchCurtain stage={switchStage} />
		</TooltipProvider>
	);
};

/**
 * Initializes the library store based on the active library path
 */
const LibraryStoreInitializer = ({
	children,
}: {
	children: React.ReactNode;
}) => {
	useInitializeLibraryStore();
	return <>{children}</>;
};
