import type { DefaultApp } from "../types";

/** "epub" for "/books/A Title.EPUB"; null without an extension. */
export const fileExtension = (path: string): string | null => {
	const name = path.split(/[\\/]/).pop() ?? "";
	const dot = name.lastIndexOf(".");
	return dot > 0 && dot < name.length - 1
		? name.slice(dot + 1).toLowerCase()
		: null;
};

/**
 * One lookup per file extension: every EPUB opens in the same app. Files
 * without an extension are looked up each time. A failed lookup reads as
 * no default app and is tried again next time.
 */
export const cacheByExtension = (
	lookup: (path: string) => Promise<DefaultApp | null>,
): ((path: string) => Promise<DefaultApp | null>) => {
	const cache = new Map<string, Promise<DefaultApp | null>>();
	const safely = (path: string) => lookup(path).catch(() => null);
	return (path) => {
		const extension = fileExtension(path);
		if (extension === null) return safely(path);
		const cached = cache.get(extension);
		if (cached !== undefined) return cached;
		const pending = lookup(path).catch(() => {
			cache.delete(extension);
			return null;
		});
		cache.set(extension, pending);
		return pending;
	};
};
