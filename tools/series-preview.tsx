import {
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { Series } from "../src/components/pages/Series";
import shell from "../src/routes/root.module.css";
import { useLibraryStore } from "../src/stores/library/store";
import "../src/styles.css";

const requestedCount = Number(new URLSearchParams(location.search).get("count") ?? 100_000);
const count = Number.isFinite(requestedCount)
	? Math.max(0, Math.min(100_000, Math.floor(requestedCount)))
	: 100_000;
useLibraryStore.setState({
	series: Array.from({ length: count }, (_, index) => ({
		id: index + 1,
		name: `Series ${String(index).padStart(6, "0")}${index === count - 1 && new URLSearchParams(location.search).has("long") ? " — a very long series name".repeat(20) : ""}`,
		book_count: index % 7,
	})),
	seriesLoading: false,
});
document.documentElement.setAttribute("data-theme", "light");

const rootRoute = createRootRoute({
	component: () => (
		<div className={shell.shell} data-sidebar-open>
			<div className={shell.header}>Series stress preview</div>
			<div className={shell.body}>
				<nav className={shell.nav}>Series</nav>
				<main className={shell.main}>
					<div className={shell.content} tabIndex={0} role="region" aria-label="Series viewport"><Outlet /></div>
				</main>
			</div>
		</div>
	),
});
const previewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/tools/series-preview.html",
	component: Series,
});
const booksRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: () => <p>Series link target: {location.search}</p>,
});
const router = createRouter({routeTree: rootRoute.addChildren([previewRoute, booksRoute])});
const root = document.getElementById("root");
if (root) createRoot(root).render(<RouterProvider router={router} />);
