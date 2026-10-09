import {
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { Authors } from "../../src/components/pages/Authors";
import { Series } from "../../src/components/pages/Series";
import { TooltipProvider } from "../../src/components/ui";
import shell from "../../src/routes/root.module.css";
import { getListScenario } from "../../src/test/list-scenarios";
import "../../src/styles.css";

const pages = { series: Series, authors: Authors };
const parameters = new URLSearchParams(location.search);
const name = parameters.get("scenario") ?? "series";
if (!Object.hasOwn(pages, name)) {
	throw new Error(`Unknown list scenario: ${name}`);
}
const scenario = getListScenario(name);
const requestedCount = Number(parameters.get("count") ?? 100_000);
const count = Number.isFinite(requestedCount)
	? Math.max(0, Math.min(100_000, Math.floor(requestedCount)))
	: 100_000;
scenario.install(count, parameters.has("long"));
document.documentElement.setAttribute("data-theme", "light");
const Page = pages[name as keyof typeof pages];

const rootRoute = createRootRoute({
	component: () => (
		<TooltipProvider>
			<div className={shell.shell} data-sidebar-open>
				<div className={shell.header}>Citadel list fixtures: {name}</div>
				<div className={shell.body}>
					<nav className={shell.nav}>
						{Object.keys(pages).map((page) => (
							<p key={page}><a href={`?scenario=${page}&count=${count}`}>{page}</a></p>
						))}
					</nav>
					<main className={shell.main}>
						<div className={shell.content} tabIndex={0} role="region" aria-label="List viewport">
							<Outlet />
						</div>
					</main>
				</div>
			</div>
		</TooltipProvider>
	),
});
const previewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/tools/testing/preview.html",
	component: Page,
});
const booksRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: () => <p>List link target: {location.search}</p>,
});
const router = createRouter({ routeTree: rootRoute.addChildren([previewRoute, booksRoute]) });
const root = document.getElementById("root");
if (root) createRoot(root).render(<RouterProvider router={router} />);
