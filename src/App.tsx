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
import { usePlatform } from "@/lib/platform/context";
import { checkForUpdates } from "@/lib/services/app-updates";
import { useApplyColorScheme } from "@/lib/theme-manager";
import { safeAsyncEventHandler } from "$lib/async";
import { FirstRunGate } from "./components/organisms/FirstRunFlow";
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

	useEffect(() => {
		if (hydrated) {
			safeAsyncEventHandler(() => platform.window.showMainWindow())();
		}
	}, [hydrated, platform]);

	useEffect(() => {
		if (!hydrated || !platform.capabilities.supportsAutoUpdates || IS_DEV)
			return;

		const {
			autoUpdateCheckingEnabled,
			hasCompletedFirstLaunch,
			setHasCompletedFirstLaunch,
			lastNotifiedUpdateVersion,
			setLastNotifiedUpdateVersion,
		} = useSettings.getState();

		if (!autoUpdateCheckingEnabled) return;
		if (!hasCompletedFirstLaunch) {
			safeAsyncEventHandler(async () => {
				await setHasCompletedFirstLaunch(true);
			})();
			return;
		}

		safeAsyncEventHandler(async () => {
			const updateCheckResult = await checkForUpdates();
			if (
				updateCheckResult.has_update &&
				updateCheckResult.version !== lastNotifiedUpdateVersion
			) {
				await setLastNotifiedUpdateVersion(updateCheckResult.version);
				toast.show({
					id: "auto-update-available",
					title: "Update available",
					message: `Version ${updateCheckResult.version} is available. Open ⚙ to install.`,
					duration: 7000,
				});
			}
		})();
	}, [hydrated, platform]);

	if (!hydrated) {
		// No window is shown until settings are hydrated
		return null;
	}

	// FirstRunGate decides the boot path: first run (no library) and
	// broken-path (configured library fails validation) render the CDL-19
	// flow, which mounts the app beneath its card once a library is
	// committed; a healthy boot renders the app untouched.
	return (
		<TooltipProvider>
			<Toaster />
			<FirstRunGate>
				<LibraryStoreInitializer>
					<RouterProvider router={router} />
				</LibraryStoreInitializer>
			</FirstRunGate>
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
