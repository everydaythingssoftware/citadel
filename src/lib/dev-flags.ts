/**
 * Developer-only switches for design variants still being decided, set in the
 * browser console, e.g. `localStorage.setItem("citadel:placeholderCovers",
 * "patterns")`, then reload, or in the address, e.g. `?placeholderCovers=patterns`. Unknown or missing values fall back to the
 * default. Remove a flag once its variant is chosen.
 */
export const DEV_FLAGS = {
	/** Books without covers: "paintings" (default) or "patterns". */
	placeholderCovers: ["paintings", "patterns"],
	/** The drop overlay's fan: "paintings" (default), "motifs" or "plain". */
	dropFan: ["paintings", "motifs", "plain"],
	/** The toolbar's icon for new books waiting for review; "arrival" by default. */
	reviewIndicator: ["arrival", "download"],
	/** How an added book leaves the review card: "deal" (default), "shelve" or "lift". */
	addedMotion: ["deal", "shelve", "lift"],
	/** Covers on touch screens: natively scrolled "native" (default) or "physics", as with a trackpad. */
	touchCovers: ["native", "physics"],
	/** "on" shows what the browser reports about the visible viewport and keyboard. */
	viewportDebug: ["off", "on"],
} as const;

type Flags = typeof DEV_FLAGS;

/**
 * A flag in the address (`?touchCovers=physics`), for devices without a
 * console such as iPhones; it's remembered until changed the same way.
 */
const fromAddress = (name: string, options: readonly string[]) => {
	const value = new URLSearchParams(globalThis.location?.search ?? "").get(
		name,
	);
	if (value === null || !options.includes(value)) return null;
	try {
		globalThis.localStorage?.setItem(`citadel:${name}`, value);
	} catch {
		// Not remembered; the address still applies.
	}
	return value;
};

export const devFlag = <K extends keyof Flags>(name: K): Flags[K][number] => {
	const options: readonly string[] = DEV_FLAGS[name];
	let stored: string | null = fromAddress(name, options);
	try {
		stored ??= globalThis.localStorage?.getItem(`citadel:${name}`) ?? null;
	} catch {
		// Storage can be unavailable (private windows, blocked site data).
	}
	return (
		stored !== null && options.includes(stored) ? stored : options[0]
	) as Flags[K][number];
};
