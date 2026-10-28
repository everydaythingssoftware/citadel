import type {
	LibraryBookSortOrderKey,
	SmartShelf,
} from "@/lib/platform/settings/types";
import { create } from "zustand";

const PREFS_KEY = "book-form-prefs";

export const LibraryBookSortOrder = {
	nameAz: "name-asc",
	nameZa: "name-desc",
	authorAz: "author-asc",
	authorZa: "author-desc",
} as const satisfies Record<LibraryBookSortOrderKey, string>;

export type { LibraryBookSortOrderKey };

export interface LibraryViewState {
	query: string;
	sortOrder: LibraryBookSortOrderKey;
	hideRead: boolean;
	activeShelfId: string | null;

	setQuery: (query: string) => void;
	setSortOrder: (sortOrder: LibraryBookSortOrderKey) => void;
	setHideRead: (hideRead: boolean) => void;
	applyShelf: (shelf: SmartShelf) => void;
	detachShelf: () => void;
	resetToAllBooks: () => void;
	clearMissingActiveShelf: (existingShelfIds: string[]) => void;
}

const loadInitial = (): Pick<
	LibraryViewState,
	"query" | "sortOrder" | "hideRead" | "activeShelfId"
> => {
	const defaults = {
		query: "",
		sortOrder: "authorAz" as LibraryBookSortOrderKey,
		hideRead: false,
		activeShelfId: null as string | null,
	};

	try {
		const stored = window.localStorage.getItem(PREFS_KEY);
		if (!stored) return defaults;
		// Older builds also persisted a `view` ("covers" | "list") key here;
		// unknown keys are ignored and dropped on the next persist().
		const parsed = JSON.parse(stored) as Partial<typeof defaults>;
		return {
			query: typeof parsed.query === "string" ? parsed.query : defaults.query,
			sortOrder:
				parsed.sortOrder && parsed.sortOrder in LibraryBookSortOrder
					? parsed.sortOrder
					: defaults.sortOrder,
			hideRead:
				typeof parsed.hideRead === "boolean"
					? parsed.hideRead
					: defaults.hideRead,
			activeShelfId:
				typeof parsed.activeShelfId === "string" ||
				parsed.activeShelfId === null
					? parsed.activeShelfId
					: defaults.activeShelfId,
		};
	} catch (_e) {
		return defaults;
	}
};

const persist = (state: LibraryViewState) => {
	window.localStorage.setItem(
		PREFS_KEY,
		JSON.stringify({
			query: state.query,
			sortOrder: state.sortOrder,
			hideRead: state.hideRead,
			activeShelfId: state.activeShelfId,
		}),
	);
};

export const useLibraryView = create<LibraryViewState>((set, get) => ({
	...loadInitial(),

	setQuery: (query) => {
		set({ query, activeShelfId: null });
		persist(get());
	},
	setSortOrder: (sortOrder) => {
		set({ sortOrder, activeShelfId: null });
		persist(get());
	},
	setHideRead: (hideRead) => {
		set({ hideRead, activeShelfId: null });
		persist(get());
	},
	// Selecting a shelf applies its filter here and navigates to "/". Shelf
	// identity intentionally stays out of the URL: the route remains clean and
	// activeShelfId is restored from localStorage on relaunch instead.
	applyShelf: (shelf) => {
		set({
			query: shelf.filter.query,
			sortOrder: shelf.filter.sortOrder,
			hideRead: shelf.filter.hideRead,
			activeShelfId: shelf.id,
		});
		persist(get());
	},
	// Keeps the filters but stops claiming a shelf: used when the route no
	// longer shows the shelf's deep-link filters.
	detachShelf: () => {
		if (get().activeShelfId === null) return;
		set({ activeShelfId: null });
		persist(get());
	},
	resetToAllBooks: () => {
		set({ query: "", hideRead: false, activeShelfId: null });
		persist(get());
	},
	// activeShelfId persists in localStorage while shelves live in settings.json;
	// if they desync (settings reset, sync, crash), detach the stale shelf id but
	// keep the filters — they stay visible in the toolbar, so nothing is hidden.
	clearMissingActiveShelf: (existingShelfIds) => {
		const { activeShelfId } = get();
		if (activeShelfId !== null && !existingShelfIds.includes(activeShelfId)) {
			set({ activeShelfId: null });
			persist(get());
		}
	},
}));
