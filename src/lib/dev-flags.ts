/**
 * Developer-only switches for design variants still being decided, set in the
 * browser console, e.g. `localStorage.setItem("citadel:placeholderCovers",
 * "patterns")`, then reload. Unknown or missing values fall back to the
 * default. Remove a flag once its variant is chosen.
 */
export const DEV_FLAGS = {
	/** Books without covers: "paintings" (default) or "patterns". */
	placeholderCovers: ["paintings", "patterns"],
	/** The drop overlay's fan: "paintings" (default), "motifs" or "plain". */
	dropFan: ["paintings", "motifs", "plain"],
	/** Review countdown: "sand" (default), "ring" or "bar". */
	hourglass: ["sand", "ring", "bar"],
	/** How an added book leaves the review card: "deal" (default), "shelve" or "lift". */
	addedMotion: ["deal", "shelve", "lift"],
} as const;

type Flags = typeof DEV_FLAGS;

export const devFlag = <K extends keyof Flags>(name: K): Flags[K][number] => {
	const options: readonly string[] = DEV_FLAGS[name];
	let stored: string | null = null;
	try {
		stored = globalThis.localStorage?.getItem(`citadel:${name}`) ?? null;
	} catch {
		// Storage can be unavailable (private windows, blocked site data).
	}
	return (
		stored !== null && options.includes(stored) ? stored : options[0]
	) as Flags[K][number];
};
