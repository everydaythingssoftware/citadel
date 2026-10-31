import {
	createRootRoute,
	Outlet,
	useRouterState,
} from "@tanstack/react-router";
import clsx from "clsx";
import { useState } from "react";
import { F7SidebarLeft } from "@/components/icons/F7SidebarLeft";
import { AddBookButton, AddBookProvider } from "@/components/organisms/AddBook";
import { Sidebar } from "@/components/organisms/Sidebar";
import { IconButton } from "@/components/ui";
import { useAppKeymap } from "@/lib/hooks/use-app-keymap";
import { useNativeThemeSync } from "@/lib/hooks/use-native-theme-sync";
import classes from "./root.module.css";

const Root = () => {
	// The phone sidebar belongs to the page it was opened on: going anywhere
	// closes it.
	const [mobileOpenedOn, setMobileOpenedOn] = useState<string | null>(null);
	const [desktopOpened, setDesktopOpened] = useState(true);
	const { location } = useRouterState();
	const mobileOpened = mobileOpenedOn === location.href;
	useNativeThemeSync();
	// Self-disables in the settings window (/settings pathname check inside).
	useAppKeymap();

	// The settings window loads /settings in its own webview; it brings its
	// own full-window layout and must not inherit the library chrome
	// (toolbar, sidebar, Add Book).
	if (location.pathname.startsWith("/settings")) {
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
							onClick={() =>
								setMobileOpenedOn(mobileOpened ? null : location.href)
							}
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
					</div>
				</header>

				<div className={classes.body}>
					<nav className={classes.nav}>
						<Sidebar />
					</nav>
					{mobileOpened && (
						<button
							type="button"
							tabIndex={-1}
							aria-label="Close sidebar"
							className={classes.scrim}
							onClick={() => setMobileOpenedOn(null)}
						/>
					)}

					<main className={classes.main}>
						<div className={classes.content}>
							<Outlet />
						</div>
					</main>
				</div>
			</div>
		</AddBookProvider>
	);
};

export const Route = createRootRoute({
	component: Root,
});
