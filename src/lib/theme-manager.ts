import { useEffect, useSyncExternalStore } from "react";

export type ColorScheme = "light" | "dark" | "auto";

export type ResolvedColorScheme = Exclude<ColorScheme, "auto">;

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Single shared MediaQueryList so subscribe/unsubscribe pairs always match. */
let systemDarkQuery: MediaQueryList | null = null;
const getSystemDarkQuery = (): MediaQueryList => {
	if (systemDarkQuery === null) {
		systemDarkQuery = window.matchMedia(DARK_QUERY);
	}
	return systemDarkQuery;
};

export const resolveColorScheme = (
	scheme: ColorScheme,
): ResolvedColorScheme => {
	if (scheme === "auto") {
		return getSystemDarkQuery().matches ? "dark" : "light";
	}
	return scheme;
};

const setRootAttributes = (resolved: ResolvedColorScheme) => {
	document.documentElement.setAttribute("data-theme", resolved);
	try {
		localStorage.setItem("citadel:theme", resolved);
	} catch {
		// Private mode or non-browser test environment.
	}
};

/** Active OS-theme subscription while the applied scheme is "auto". */
let autoListener: ((event: MediaQueryListEvent) => void) | null = null;

const unsubscribeAuto = () => {
	if (autoListener !== null) {
		getSystemDarkQuery().removeEventListener("change", autoListener);
		autoListener = null;
	}
};

/**
 * Applies a color scheme to the document. "auto" resolves against the OS
 * preference and keeps following it live until a different scheme is applied
 * (any call replaces the previous matchMedia subscription).
 */
export const applyColorScheme = (scheme: ColorScheme): void => {
	unsubscribeAuto();
	if (scheme === "auto") {
		autoListener = (event) => {
			setRootAttributes(event.matches ? "dark" : "light");
		};
		getSystemDarkQuery().addEventListener("change", autoListener);
	}
	setRootAttributes(resolveColorScheme(scheme));
};

/**
 * React wrapper around {@link applyColorScheme}: re-applies whenever the
 * scheme changes and drops the OS subscription on unmount.
 */
export const useApplyColorScheme = (scheme: ColorScheme): void => {
	useEffect(() => {
		applyColorScheme(scheme);
		return unsubscribeAuto;
	}, [scheme]);
};

const subscribeSystemDark = (onChange: () => void) => {
	const query = getSystemDarkQuery();
	query.addEventListener("change", onChange);
	return () => {
		query.removeEventListener("change", onChange);
	};
};

const getSystemDarkSnapshot = () => getSystemDarkQuery().matches;

/**
 * The scheme actually in effect for the given setting: "auto" tracks the OS
 * preference live, "light"/"dark" pass through unchanged.
 */
export const useResolvedColorScheme = (
	scheme: ColorScheme,
): ResolvedColorScheme => {
	const systemDark = useSyncExternalStore(
		subscribeSystemDark,
		getSystemDarkSnapshot,
	);
	if (scheme === "auto") {
		return systemDark ? "dark" : "light";
	}
	return scheme;
};
