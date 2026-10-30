import { convertFileSrc, isTauri } from "@tauri-apps/api/core";

/** Host detection belongs to adapter selection, never to components. */
export const isDesktop = isTauri();

/**
 * A URL the webview can load from one of the app's own URI schemes; its form
 * differs by OS (`scheme://localhost/…` or `http://scheme.localhost/…`).
 */
export const appSchemeUrl = (scheme: string, path: string): string =>
	convertFileSrc(path, scheme);
