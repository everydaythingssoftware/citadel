import { createRouter, RouterProvider } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
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
import { scrollRestorationOptions } from "@/lib/navigation";
import { usePlatform } from "@/lib/platform/context";
import { useApplyColorScheme } from "@/lib/theme-manager";
import { safeAsyncEventHandler } from "$lib/async";
import { BrowserLibraryGate } from "./components/organisms/BrowserLibraryGate";
import { FirstRunGate } from "./components/organisms/FirstRunFlow";
import { LibrarySwitchCurtain } from "./components/organisms/LibrarySwitchCurtain";
import { routeTree } from "./routeTree.gen";
import { LibraryState, useLibraryStore } from "./stores/library/store";
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
	...scrollRestorationOptions,
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

export const App = () => {
	const hydrated = useSettings((state) => state.hydrated);
	const activeLibraryId = useSettings((state) => state.activeLibraryId);
	const theme = useSettings((state) => state.theme);
	const libraryState = useLibraryStore((state) => state.libraryState);
	const platform = usePlatform();
	useApplyColorScheme(theme);
	const { stage: switchStage } = useLibrarySwitch();
	useRestoredDatabaseNotice(hydrated);

	// Keep the native window hidden until the first ready grid frame (or
	// first-run / error state) has painted, so desktop launches straight into
	// the populated library with no empty window or "Loading books..." flash.
	const windowShownRef = useRef(false);
	const readyToShow =
		hydrated &&
		(!activeLibraryId ||
			libraryState === LibraryState.ready ||
			libraryState === LibraryState.error);

	useEffect(() => {
		if (!hydrated || windowShownRef.current) return;
		let cancelled = false;
		const reveal = () => {
			if (cancelled || windowShownRef.current) return;
			windowShownRef.current = true;
			safeAsyncEventHandler(() => platform.window.show())();
		};
		if (!readyToShow) {
			// Safety net for onboarding/recovery cards or slow external drives.
			const fallback = window.setTimeout(reveal, 600);
			return () => {
				cancelled = true;
				window.clearTimeout(fallback);
			};
		}
		// macOS WKWebView suspends requestAnimationFrame while hidden, so use
		// a short tick to let the ready grid commit, then wait briefly for the
		// initial visible covers to decode (capped at 150 ms) so desktop opens
		// straight into sharp covers when the SSD is fast, or ThumbHashes if not.
		let capTimer = 0;
		const tick = window.setTimeout(() => {
			capTimer = window.setTimeout(reveal, 150);
			const imgs = Array.from(document.querySelectorAll("img")).slice(0, 25);
			void Promise.allSettled(
				imgs.map((img) =>
					img.complete ? Promise.resolve() : img.decode().catch(() => {}),
				),
			).then(reveal);
		}, 16);
		return () => {
			cancelled = true;
			window.clearTimeout(tick);
			window.clearTimeout(capTimer);
		};
	}, [hydrated, readyToShow, platform]);

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

		// A found update downloads in the background where it can install at
		// quit; once ready, the sidebar footer row and Citadel > Restart to
		// Update… offer it (CDL-51, CDL-90).
		safeAsyncEventHandler(async () => {
			await platform.updates.check();
			await platform.updates.later();
		})();
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
