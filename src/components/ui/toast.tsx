import { useSyncExternalStore } from "react";
import { Spinner } from "./Spinner";
import styles from "./toast.module.css";

export interface ToastOptions {
	/** Stable id so later `toast.update(id, ...)` calls can target this toast. */
	id?: string;
	title: string;
	message?: string;
	/** Shows a spinner and disables auto-dismiss until updated. */
	loading?: boolean;
	/** Auto-dismiss delay in ms. Defaults to 5000. Ignored while loading. */
	duration?: number;
}

export type ToastUpdate = Partial<Omit<ToastOptions, "id">>;

interface ToastItem {
	id: string;
	title: string;
	message?: string;
	loading: boolean;
	duration: number;
	exiting: boolean;
}

const DEFAULT_DURATION = 5000;
const EXIT_MS = 160;

/* --- Tiny external store (read via useSyncExternalStore in Toaster). --- */

let toasts: ToastItem[] = [];
const listeners = new Set<() => void>();

const emit = () => {
	for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

const getSnapshot = () => toasts;

/* --- Dismiss timers, with hover pause/resume. --- */

interface Timer {
	handle: ReturnType<typeof setTimeout> | undefined;
	expiresAt: number;
	remaining: number;
}

const timers = new Map<string, Timer>();

const clearTimer = (id: string) => {
	const timer = timers.get(id);
	if (timer?.handle !== undefined) clearTimeout(timer.handle);
	timers.delete(id);
};

const scheduleDismiss = (id: string, ms: number) => {
	clearTimer(id);
	timers.set(id, {
		handle: setTimeout(() => hide(id), ms),
		expiresAt: Date.now() + ms,
		remaining: ms,
	});
};

const pauseDismiss = (id: string) => {
	const timer = timers.get(id);
	if (timer?.handle === undefined) return;
	clearTimeout(timer.handle);
	timer.handle = undefined;
	timer.remaining = Math.max(timer.expiresAt - Date.now(), 500);
};

const resumeDismiss = (id: string) => {
	const timer = timers.get(id);
	if (!timer || timer.handle !== undefined) return;
	timer.handle = setTimeout(() => hide(id), timer.remaining);
	timer.expiresAt = Date.now() + timer.remaining;
};

/* --- Imperative API. --- */

let counter = 0;

const show = (options: ToastOptions): string => {
	const id = options.id ?? `toast-${++counter}`;
	const item: ToastItem = {
		id,
		title: options.title,
		message: options.message,
		loading: options.loading ?? false,
		duration: options.duration ?? DEFAULT_DURATION,
		exiting: false,
	};
	const existing = toasts.findIndex((t) => t.id === id);
	toasts =
		existing >= 0
			? toasts.map((t, i) => (i === existing ? item : t))
			: [...toasts, item];
	if (item.loading) {
		clearTimer(id);
	} else {
		scheduleDismiss(id, item.duration);
	}
	emit();
	return id;
};

const update = (id: string, patch: ToastUpdate) => {
	const current = toasts.find((t) => t.id === id);
	if (!current) return;
	const next: ToastItem = {
		...current,
		...patch,
		loading: patch.loading ?? current.loading,
		duration: patch.duration ?? current.duration,
		exiting: false,
	};
	toasts = toasts.map((t) => (t.id === id ? next : t));
	if (next.loading) {
		clearTimer(id);
	} else {
		scheduleDismiss(id, next.duration);
	}
	emit();
};

const hide = (id: string) => {
	const current = toasts.find((t) => t.id === id);
	if (!current || current.exiting) return;
	clearTimer(id);
	toasts = toasts.map((t) => (t.id === id ? { ...t, exiting: true } : t));
	emit();
	setTimeout(() => {
		toasts = toasts.filter((t) => t.id !== id);
		emit();
	}, EXIT_MS);
};

/**
 * Imperative toast API:
 *
 *   toast.show({ id: "job", title: "Working", loading: true });
 *   toast.update("job", { title: "Done", loading: false });
 *   toast.hide("job");
 */
export const toast = { show, update, hide };

/* --- Banner stack. Mount one <Toaster /> at the app root. --- */

/** macOS notification-banner stack, top right. Mount once. */
export const Toaster = () => {
	const items = useSyncExternalStore(subscribe, getSnapshot);

	if (items.length === 0) return null;

	return (
		<div className={styles.stack}>
			{items.map((item) => (
				<div
					key={item.id}
					role="status"
					className={`${styles.banner} ${item.exiting ? styles.bannerExiting : ""}`}
					onMouseEnter={() => pauseDismiss(item.id)}
					onMouseLeave={() => resumeDismiss(item.id)}
				>
					{item.loading && (
						<div className={styles.spinner}>
							<Spinner size={14} />
						</div>
					)}
					<div className={styles.text}>
						<div className={styles.title}>{item.title}</div>
						{item.message && (
							<div className={styles.message} data-selectable>
								{item.message}
							</div>
						)}
					</div>
					{!item.loading && (
						<button
							type="button"
							className={styles.dismiss}
							aria-label="Dismiss notification"
							onClick={() => hide(item.id)}
						>
							<svg
								width="8"
								height="8"
								viewBox="0 0 8 8"
								fill="none"
								aria-hidden="true"
							>
								<path
									d="M1 1l6 6M7 1L1 7"
									stroke="currentColor"
									strokeWidth="1.3"
									strokeLinecap="round"
								/>
							</svg>
						</button>
					)}
				</div>
			))}
		</div>
	);
};
