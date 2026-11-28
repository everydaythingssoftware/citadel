import type { SearchScope } from "@/bindings";
import type {
	LibraryBookSortOrderKey,
	ShelfViewFields,
	SmartShelf,
} from "@/lib/platform/settings/types";
import { isSearchScope, SEARCH_SCOPE } from "@/lib/search-scope";
import { create } from "zustand";

const PREFS_KEY = "book-form-prefs";

export const LibraryBookSortOrder = {
	nameAz: "name-asc",
	nameZa: "name-desc",
	authorAz: "author-asc",
	authorZa: "author-desc",
	addedNewest: "added-desc",
	addedOldest: "added-asc",
} as const satisfies Record<LibraryBookSortOrderKey, string>;

export type { LibraryBookSortOrderKey };

/** True when `value` is a key of {@link LibraryBookSortOrder}. */
const isSortOrderKey = (value: unknown): value is LibraryBookSortOrderKey =>
	typeof value === "string" && Object.hasOwn(LibraryBookSortOrder, value);

export interface LibraryViewState {
	query: string;
	sortOrder: LibraryBookSortOrderKey;
	hideRead: boolean;
	searchScope: SearchScope;
	activeShelfId: string | null;

	setQuery: (query: string) => void;
	setSortOrder: (sortOrder: LibraryBookSortOrderKey) => void;
	setHideRead: (hideRead: boolean) => void;
	setSearchScope: (searchScope: SearchScope) => void;
	applyShelf: (shelf: SmartShelf) => void;
	detachShelf: () => void;
	resetToAllBooks: () => void;
	syncActiveShelf: (shelves: readonly SmartShelf[]) => void;
}

/** The view of an empty start. */
const DEFAULT_VIEW: ShelfViewFields = {
	query: "",
	sortOrder: "authorAz",
	hideRead: false,
	searchScope: SEARCH_SCOPE.titlesAuthorsSeries,
};

/** A stored record that can hold the view fields, with any values. */
type StoredViewFields = Partial<Record<keyof ShelfViewFields, unknown>>;

/** The names of the view fields whose values differ in `stored`. */
const changedViewFields = (
	fields: ShelfViewFields,
	stored: StoredViewFields,
): (keyof ShelfViewFields)[] =>
	(Object.keys(fields) as (keyof ShelfViewFields)[]).filter(
		(key) => fields[key] !== stored[key],
	);

/**
 * The view fields of a stored record, from localStorage or from a shelf. A
 * field that is not valid gets its default, and `replaced` names it.
 */
const viewFieldsFrom = (
	stored: StoredViewFields,
): { fields: ShelfViewFields; replaced: (keyof ShelfViewFields)[] } => {
	const fields: ShelfViewFields = {
		query: typeof stored.query === "string" ? stored.query : DEFAULT_VIEW.query,
		sortOrder: isSortOrderKey(stored.sortOrder)
			? stored.sortOrder
			: DEFAULT_VIEW.sortOrder,
		hideRead:
			typeof stored.hideRead === "boolean"
				? stored.hideRead
				: DEFAULT_VIEW.hideRead,
		searchScope: isSearchScope(stored.searchScope)
			? stored.searchScope
			: DEFAULT_VIEW.searchScope,
	};
	return { fields, replaced: changedViewFields(fields, stored) };
};

/**
 * The view fields of a shelf. A hand edit of settings.json can hold any
 * value, so a field that is not valid gets its default, with a warning.
 */
const shelfViewFields = (shelf: SmartShelf): ShelfViewFields => {
	const { fields, replaced } = viewFieldsFrom(shelf.filter);
	if (replaced.length > 0) {
		console.warn(
			`Shelf ${shelf.id} has values that are not valid (${replaced.join(", ")}). Used the defaults.`,
		);
	}
	return fields;
};

const loadInitial = (): Pick<
	LibraryViewState,
	"query" | "sortOrder" | "hideRead" | "searchScope" | "activeShelfId"
> => {
	const defaults = {
		...DEFAULT_VIEW,
		activeShelfId: null as string | null,
	};

	try {
		const stored = window.localStorage.getItem(PREFS_KEY);
		if (!stored) return defaults;
		// Older builds also persisted a `view` ("covers" | "list") key here;
		// unknown keys are ignored and dropped on the next persist().
		const parsed = JSON.parse(stored) as StoredViewFields & {
			activeShelfId?: unknown;
		};
		return {
			...viewFieldsFrom(parsed).fields,
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
			searchScope: state.searchScope,
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
	setSearchScope: (searchScope) => {
		if (searchScope === get().searchScope) return;
		set({ searchScope, activeShelfId: null });
		persist(get());
	},
	// Selecting a shelf applies its filter here and navigates to "/". Shelf
	// identity intentionally stays out of the URL: the route remains clean and
	// activeShelfId is restored from localStorage on relaunch instead.
	applyShelf: (shelf) => {
		set({ ...shelfViewFields(shelf), activeShelfId: shelf.id });
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
	// A shelf that still exists applies its filter again, because the settings
	// migration or another window can change the filter after localStorage
	// copied it.
	syncActiveShelf: (shelves) => {
		const state = get();
		if (state.activeShelfId === null) return;
		const shelf = shelves.find(
			(candidate) => candidate.id === state.activeShelfId,
		);
		if (shelf === undefined) {
			set({ activeShelfId: null });
			persist(get());
			return;
		}
		const fields = shelfViewFields(shelf);
		if (changedViewFields(fields, state).length > 0) {
			set(fields);
			persist(get());
		}
	},
}));
