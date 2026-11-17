import { toast } from "@/components/ui";

/** The server names its build (version and commit) on every API response. */
export const SERVER_BUILD_HEADER = "Citadel-Build";

export interface ServerBuildWatch {
	/** The build this page first heard from. */
	loaded: string | null;
	/** The newest build already announced, so each one is told once. */
	announced: string | null;
}

/**
 * Folds one response's build into the watch. `announce` is the build to
 * tell the reader about: one that differs from the page's, not yet told.
 */
export const observeServerBuild = (
	watch: ServerBuildWatch,
	build: string | null,
): { watch: ServerBuildWatch; announce: boolean } => {
	const named = build?.trim() || null;
	if (named === null) return { watch, announce: false };
	if (watch.loaded === null) {
		return { watch: { ...watch, loaded: named }, announce: false };
	}
	if (named === watch.loaded || named === watch.announced) {
		return { watch, announce: false };
	}
	return { watch: { ...watch, announced: named }, announce: true };
};

let watch: ServerBuildWatch = { loaded: null, announced: null };

/**
 * Called for every API response. Reloading is the only way a page
 * updates, so the notice carries the action and stays until dismissed.
 */
export const reportServerBuild = (build: string | null): void => {
	const next = observeServerBuild(watch, build);
	watch = next.watch;
	if (!next.announce) return;
	toast.show({
		id: "server-updated",
		title: "Citadel was updated",
		message: "Reload to get the latest version.",
		duration: Number.POSITIVE_INFINITY,
		action: { label: "Reload", onSelect: () => window.location.reload() },
	});
};
