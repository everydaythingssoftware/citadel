import {
	createRootRoute,
	Outlet,
	type ParsedLocation,
	useRouterState,
} from "@tanstack/react-router";
import clsx from "clsx";
import { type CSSProperties, useCallback, useState } from "react";
import { NavigationProgress } from "@/components/atoms/NavigationProgress";
import { F7SidebarLeft } from "@/components/icons/F7SidebarLeft";
import { ServerUpdatedBanner } from "@/components/molecules/ServerUpdatedBanner";
import { AddBookButton, AddBookProvider } from "@/components/organisms/AddBook";
import {
	BookUploads,
	UploadToolbarStatus,
} from "@/components/organisms/BookUploads";
import { MenuCommandHost } from "@/components/organisms/MenuCommandHost";
import { Sidebar } from "@/components/organisms/Sidebar";
import { IconButton, Tooltip } from "@/components/ui";
import { useAppKeymap } from "@/lib/hooks/use-app-keymap";
import { useNativeThemeSync } from "@/lib/hooks/use-native-theme-sync";
import { useNavigationPending } from "@/lib/hooks/use-navigation-pending";
import { usePrefersReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { useServerUpdatedNotice } from "@/lib/hooks/use-server-updated-notice";
import { useSidebarResize } from "@/lib/hooks/use-sidebar-resize";
import { useSwipeToClose } from "@/lib/hooks/use-swipe-to-close";
import { useWindowChromeState } from "@/lib/hooks/use-window-chrome-state";
import { usePlatform } from "@/lib/platform/context";
import { useSidebar } from "@/stores/sidebar/store";
import classes from "./root.module.css";

interface SidebarToggleProps {
	open: boolean;
	onToggle: () => void;
	className?: string;
}

const SidebarToggle = ({ open, onToggle, className }: SidebarToggleProps) => {
	const label = open ? "Hide Sidebar" : "Show Sidebar";
	return (
		<Tooltip label={label}>
			<IconButton
				aria-label={label}
				aria-expanded={open}
				className={clsx(classes.sidebarToggle, className)}
				onClick={onToggle}
			>
				<F7SidebarLeft aria-hidden="true" />
			</IconButton>
		</Tooltip>
	);
};

const Root = () => {
	// The phone sidebar belongs to the visit it was opened on: going anywhere
	// closes it, including Back to the same page. Each navigation parses a new
	// location, so comparing the object (not the URL) tells visits apart.
	const [mobileOpenedOn, setMobileOpenedOn] = useState<ParsedLocation | null>(
		null,
	);
	const desktopOpened = useSidebar((s) => s.visible);
	const toggleSidebar = useSidebar((s) => s.toggleSidebar);
	const resize = useSidebarResize();
	const { location } = useRouterState();
	const platform = usePlatform();
	const isDesktop = platform.capabilities.supportsNativeWindows;
	const serverUpdated = useServerUpdatedNotice(!isDesktop);
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
	useWindowChromeState();
	// Self-disables in the settings window (/settings pathname check inside).
	useAppKeymap();

	// The desktop settings window loads /settings in its own webview; it
	// brings its own full-window layout and must not inherit the library
	// chrome (toolbar, sidebar, Add Book). On the web, Settings is a page of
	// the app like any other.
	if (isDesktop && location.pathname.startsWith("/settings")) {
		return <Outlet />;
	}

	return (
		<AddBookProvider>
			<div
				className={classes.shell}
				data-sidebar-open={desktopOpened || undefined}
				data-sidebar-resizing={resize.resizing || undefined}
				data-mobile-sidebar-open={mobileOpened || undefined}
				style={{ "--sidebar-width": `${resize.width}px` } as CSSProperties}
			>
				<header className={classes.header} data-tauri-drag-region>
					<div className={classes.headerControls} data-tauri-drag-region>
						<SidebarToggle
							open={mobileOpened}
							className={classes.mobileOnly}
							onToggle={() => setMobileOpenedOn(mobileOpened ? null : location)}
						/>
						<SidebarToggle
							open={desktopOpened}
							className={classes.desktopOnly}
							onToggle={toggleSidebar}
						/>
						<AddBookButton />
						<UploadToolbarStatus />
					</div>
				</header>

				<div className={classes.body}>
					<nav
						ref={sidebarSwipe.panelRef}
						className={classes.nav}
						aria-label="Sidebar"
						data-closed={!desktopOpened || undefined}
					>
						<div className={classes.navInner}>
							<Sidebar />
						</div>
						<div className={classes.resizer} {...resize.handleProps} />
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
						<div className={clsx(classes.content, "ctd-scroller")}>
							<Outlet />
						</div>
					</main>
				</div>
			</div>
			<BookUploads />
			<MenuCommandHost />
			{serverUpdated.build && (
				<ServerUpdatedBanner
					onReload={serverUpdated.reload}
					onDismiss={serverUpdated.dismiss}
				/>
			)}
		</AddBookProvider>
	);
};

export const Route = createRootRoute({
	component: Root,
});
