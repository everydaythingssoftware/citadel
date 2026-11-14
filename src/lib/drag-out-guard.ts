export interface DragOutGuard {
	/** A drag of our own files out of the window has started. */
	begin(): void;
	/** It ended (dropped somewhere or cancelled). */
	end(): void;
	/** Drops arriving now are our own files coming back: ignore them. */
	active(): boolean;
}

interface DragOutGuardOptions {
	now?: () => number;
	/**
	 * The window's own drop event can land just after the drag reports its
	 * end, so the guard holds a moment longer.
	 */
	graceMs?: number;
	/** A drag whose end never arrives stops guarding after this long. */
	maxMs?: number;
}

/**
 * Remembers that a drag-out is in flight, so dropping the dragged books
 * back on the window doesn't import them again as copies.
 */
export const createDragOutGuard = ({
	now = Date.now,
	graceMs = 750,
	maxMs = 120_000,
}: DragOutGuardOptions = {}): DragOutGuard => {
	let startedAt: number | null = null;
	let endedAt: number | null = null;
	return {
		begin: () => {
			startedAt = now();
			endedAt = null;
		},
		end: () => {
			if (startedAt !== null) endedAt = now();
		},
		active: () => {
			if (startedAt === null) return false;
			const time = now();
			if (time - startedAt >= maxMs) return false;
			return endedAt === null || time - endedAt < graceMs;
		},
	};
};

/** The window's one drag-out guard, shared by the drag and drop sides. */
export const dragOutGuard = createDragOutGuard();
