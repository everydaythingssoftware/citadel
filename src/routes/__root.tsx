import {
	createRootRoute,
	Outlet,
	type ParsedLocation,
	useRouterState,
} from "@tanstack/react-router";
import clsx from "clsx";
import { useCallback, useState } from "react";
import { NavigationProgress } from "@/components/atoms/NavigationProgress";
import { F7SidebarLeft } from "@/components/icons/F7SidebarLeft";
import { AddBookButton, AddBookProvider } from "@/components/organisms/AddBook";
import {
	BookUploads,
	UploadToolbarStatus,
} from "@/components/organisms/BookUploads";
import { Sidebar } from "@/components/organisms/Sidebar";
import { IconButton } from "@/components/ui";
import { useAppKeymap } from "@/lib/hooks/use-app-keymap";
import { useNativeThemeSync } from "@/lib/hooks/use-native-theme-sync";
import { useNavigationPending } from "@/lib/hooks/use-navigation-pending";
import { usePrefersReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { useSwipeToClose } from "@/lib/hooks/use-swipe-to-close";
import { usePlatform } from "@/lib/platform/context";
import classes from "./root.module.css";

const Root = () => {
	// The phone sidebar belongs to the visit it was opened on: going anywhere
	// closes it, including Back to the same page. Each navigation parses a new
	// location, so comparing the object (not the URL) tells visits apart.
	const [mobileOpenedOn, setMobileOpenedOn] = useState<ParsedLocation | null>(
		null,
	);
	const [desktopOpened, setDesktopOpened] = useState(true);
	const { location } = useRouterState();
	const platform = usePlatform();
	const mobileOpened = mobileOpenedOn === location;
	const closeMobile = useCallback(() => setMobileOpenedOn(null), []);
	const sidebarSwipe = useSwipeToClose({
		edge: "left",
		enabled: mobileOpened,
		onClose: closeMobile,
		reducedMotion: usePrefersReducedMotion(),
	});
	// A page whose data comes back within a frame or two shows no bar.
	const navigationPending = useNavigationPending(50);
	useNativeThemeSync();
	// Self-disables in the settings window (/settings pathname check inside).
	useAppKeymap();

	// The desktop settings window loads /settings in its own webview; it
	// brings its own full-window layout and must not inherit the library
	// chrome (toolbar, sidebar, Add Book). On the web, Settings is a page of
	// the app like any other.
	if (
		platform.capabilities.supportsNativeWindows &&
		location.pathname.startsWith("/settings")
	) {
		return <Outlet />;
	}

	return (
		<AddBookProvider>
			<div
				className={classes.shell}
				data-sidebar-open={desktopOpened || undefined}
				data-mobile-sidebar-open={mobileOpened || undefined}
			>
				<header className={classes.header} data-tauri-drag-region>
					<div className={classes.headerControls} data-tauri-drag-region>
						<IconButton
							aria-label="Toggle sidebar"
							className={clsx(classes.sidebarToggle, classes.mobileOnly)}
							onClick={() => setMobileOpenedOn(mobileOpened ? null : location)}
						>
							<F7SidebarLeft title="Toggle sidebar" />
						</IconButton>
						<IconButton
							aria-label="Toggle sidebar"
							className={clsx(classes.sidebarToggle, classes.desktopOnly)}
							onClick={() => setDesktopOpened((open) => !open)}
						>
							<F7SidebarLeft title="Toggle sidebar" />
						</IconButton>
						<AddBookButton />
						<UploadToolbarStatus />
					</div>
				</header>

				<div className={classes.body}>
					<nav ref={sidebarSwipe.panelRef} className={classes.nav}>
						<Sidebar />
					</nav>
					{mobileOpened && (
						<button
							type="button"
							tabIndex={-1}
							aria-label="Close sidebar"
							ref={sidebarSwipe.scrimRef}
							className={classes.scrim}
							onClick={closeMobile}
						/>
					)}

					<main className={classes.main}>
						<NavigationProgress visible={navigationPending} />
						<div className={classes.content}>
							<Outlet />
						</div>
					</main>
				</div>
			</div>
			<BookUploads />
		</AddBookProvider>
	);
};

export const Route = createRootRoute({
	component: Root,
});
