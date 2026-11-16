interface QuickLookFallbackInput {
	quickLook(path: string): Promise<void>;
	openPath(path: string): Promise<void>;
}

export interface QuickLookFallback {
	quickLook(path: string): Promise<void>;
	/** False for the rest of the session once Quick Look has failed. */
	available(): boolean;
}

/**
 * Quick Look that degrades to the default app. A failed preview opens the
 * file in its default app instead and switches Quick Look off for the
 * session, so the menus stop offering it. If the default app can't open
 * the file either, the file is the problem, not Quick Look: the preview's
 * error is reported and Quick Look stays on. This is not gated on the OS
 * version: the native side catches the panel's failure on any release.
 */
export const quickLookWithFallback = ({
	quickLook,
	openPath,
}: QuickLookFallbackInput): QuickLookFallback => {
	let available = true;
	return {
		available: () => available,
		quickLook: async (path) => {
			if (!available) return openPath(path);
			try {
				await quickLook(path);
			} catch (error) {
				try {
					await openPath(path);
				} catch {
					throw error;
				}
				available = false;
			}
		},
	};
};
