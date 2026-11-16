/** The server names its build (version and commit) on every API response. */
export const SERVER_BUILD_HEADER = "Citadel-Build";

export interface ServerBuildWatch {
	/** The build this page first heard from. */
	loaded: string | null;
	/** The newest build already announced, so each one is told once. */
	announced: string | null;
}

export const INITIAL_SERVER_BUILD_WATCH: ServerBuildWatch = {
	loaded: null,
	announced: null,
};

/**
 * Folds one response's build into the watch. `announce` is the build to
 * tell the reader about: one that differs from the page's, not yet told.
 */
export const observeServerBuild = (
	watch: ServerBuildWatch,
	build: string | null,
): { watch: ServerBuildWatch; announce: string | null } => {
	const named = build?.trim() || null;
	if (named === null) return { watch, announce: null };
	if (watch.loaded === null) {
		return { watch: { ...watch, loaded: named }, announce: null };
	}
	if (named === watch.loaded || named === watch.announced) {
		return { watch, announce: null };
	}
	return { watch: { ...watch, announced: named }, announce: named };
};

type Listener = (build: string) => void;

let watch = INITIAL_SERVER_BUILD_WATCH;
let pending: string | null = null;
const listeners = new Set<Listener>();

/** Called for every API response; cheap when nothing changed. */
export const reportServerBuild = (build: string | null): void => {
	const next = observeServerBuild(watch, build);
	watch = next.watch;
	if (next.announce === null) return;
	if (listeners.size === 0) {
		pending = next.announce;
		return;
	}
	for (const listener of listeners) listener(next.announce);
};

/**
 * Hears each newly changed build. A change that arrived before anyone
 * listened is delivered at once, to the first listener only.
 */
export const onServerBuildChange = (listener: Listener): (() => void) => {
	listeners.add(listener);
	if (pending !== null) {
		const build = pending;
		pending = null;
		listener(build);
	}
	return () => {
		listeners.delete(listener);
	};
};
