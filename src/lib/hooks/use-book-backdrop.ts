import { useCallback, useSyncExternalStore } from "react";

/**
 * Trial switch for the book drawer's backdrop: colours taken from the cover,
 * or the cover itself blurred. Kept per device while both are tried in real
 * libraries; one of them goes once that's settled.
 */
export const BOOK_BACKDROP = {
	colour: "colour",
	blurredCover: "blurred-cover",
} as const;

export type BookBackdrop = (typeof BOOK_BACKDROP)[keyof typeof BOOK_BACKDROP];

const KEY = "citadel.bookBackdrop";
const listeners = new Set<() => void>();

const read = (): BookBackdrop => {
	try {
		return localStorage.getItem(KEY) === BOOK_BACKDROP.blurredCover
			? BOOK_BACKDROP.blurredCover
			: BOOK_BACKDROP.colour;
	} catch {
		return BOOK_BACKDROP.colour;
	}
};

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	// The settings window is another webview on the same origin.
	const onStorage = (event: StorageEvent) => {
		if (event.key === KEY) listener();
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("storage", onStorage);
	};
};

export const useBookBackdrop = (): [
	BookBackdrop,
	(next: BookBackdrop) => void,
] => {
	const value = useSyncExternalStore(
		subscribe,
		read,
		() => BOOK_BACKDROP.colour,
	);
	const set = useCallback((next: BookBackdrop) => {
		try {
			localStorage.setItem(KEY, next);
		} catch {
			// Storage unavailable: the choice lasts until reload.
		}
		for (const listener of listeners) listener();
	}, []);
	return [value, set];
};
