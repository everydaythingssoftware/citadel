import { useEffect, useMemo, useRef, useState } from "react";
import type { BookMetadata, LibraryBook } from "@/bindings";
import { commands } from "@/bindings";
import { normalizeIsbn } from "@/lib/isbn";
import type {
	AggregatedResult,
	SearchHandle,
} from "@/lib/metadata-providers/aggregate";
import { searchAcrossProviders } from "@/lib/metadata-providers/aggregate";
import {
	deepLinkForIdentifier,
	getDescriptor,
} from "@/lib/metadata-providers/registry";
import type { ProviderId } from "@/lib/metadata-providers/types";
import { usePlatform } from "@/lib/platform/context";
import {
	useEnabledProviders,
	useResolvedProviderConfig,
} from "@/stores/settings/metadata-providers";

export interface MetadataMessage {
	type: "success" | "error";
	text: string;
}

interface FormSetter {
	setFieldValue: (field: string, value: unknown) => void;
}

interface UseMetadataBookActionsParams {
	book: LibraryBook;
	allAuthorNames: string[];
	form: FormSetter;
	onReloadBooks: () => Promise<void>;
	onUpsertIdentifier: (
		bookId: string,
		identifierId: number | null,
		label: string,
		value: string,
	) => Promise<void>;
	onCreateAuthor: (name: string) => Promise<void>;
}

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/**
 * Metadata lookup for the Edit Book flow (an existing book). Searches the
 * user's enabled providers, applies a chosen record to the library, and exposes
 * the just-applied subjects so the caller can offer them as tag suggestions.
 */
export const useMetadataBookActions = ({
	book,
	allAuthorNames,
	form,
	onReloadBooks,
	onUpsertIdentifier,
	onCreateAuthor,
}: UseMetadataBookActionsParams) => {
	const platform = usePlatform();
	const enabledProviders = useEnabledProviders();
	const getConfig = useResolvedProviderConfig();
	const anySourceEnabled = enabledProviders.length > 0;

	const [isFetching, setIsFetching] = useState(false);
	const [message, setMessage] = useState<MetadataMessage | null>(null);
	const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [isSearching, setIsSearching] = useState(false);
	const [results, setResults] = useState<AggregatedResult[]>([]);
	const [pendingProviders, setPendingProviders] = useState<ProviderId[]>([]);
	const [lastResolvedSubjects, setLastResolvedSubjects] = useState<string[]>(
		[],
	);
	const [lastResolvedGenres, setLastResolvedGenres] = useState<string[]>([]);
	const [lastSubjectsSource, setLastSubjectsSource] = useState<string | null>(
		null,
	);
	const searchHandleRef = useRef<SearchHandle | null>(null);

	useEffect(
		() => () => {
			searchHandleRef.current?.abort();
		},
		[],
	);

	const isbnIdentifier = useMemo(
		() => book.identifier_list.find((id) => id.label.toLowerCase() === "isbn"),
		[book.identifier_list],
	);

	const fileIsbn = isbnIdentifier
		? (normalizeIsbn(isbnIdentifier.value) ?? null)
		: null;

	/** Apply a chosen record to the library, preserving the reload→form-reset dance. */
	const applyBookToLibrary = async (chosen: BookMetadata) => {
		for (const authorName of chosen.authors) {
			if (!allAuthorNames.includes(authorName)) {
				await onCreateAuthor(authorName);
			}
		}

		// Store the provider's own id under its label (slug for Hardcover so its
		// deep-link works; the native id otherwise). Triggers a book reload.
		const identifierValue = chosen.slug ?? chosen.provider_id;
		if (identifierValue) {
			const existing = book.identifier_list.find(
				(id) => id.label.toLowerCase() === chosen.identifier_label,
			);
			await onUpsertIdentifier(
				book.id,
				existing?.id ?? null,
				chosen.identifier_label,
				identifierValue,
			);
		}

		if (chosen.isbn) {
			const normalized = normalizeIsbn(chosen.isbn);
			if (normalized) {
				await onUpsertIdentifier(
					book.id,
					isbnIdentifier?.id ?? null,
					"isbn",
					normalized,
				);
			}
		}

		if (chosen.image_url) {
			await commands.clbCmdSetBookCoverFromUrl(book.id, chosen.image_url);
			await onReloadBooks();
		}

		// Yield a microtask so React flushes the book reload (which resets the
		// form) before we set form values. Matches the original Hardcover flow.
		await new Promise((resolve) => setTimeout(resolve, 0));

		if (chosen.title) form.setFieldValue("title", chosen.title);
		if (chosen.description)
			form.setFieldValue("description", chosen.description);
		if (chosen.authors.length > 0) {
			form.setFieldValue("authorList", chosen.authors);
		}
		setLastResolvedSubjects(chosen.subjects);
		setLastResolvedGenres(
			chosen.genre_candidates.map((candidate) => candidate.name),
		);
		setLastSubjectsSource(
			chosen.subjects.length > 0
				? getDescriptor(chosen.provider).displayName
				: null,
		);
	};

	const runLookup = (args: {
		query: string;
		isbn: string | null;
	}): Promise<AggregatedResult[]> =>
		new Promise((resolve) => {
			let latest: AggregatedResult[] = [];
			searchAcrossProviders(enabledProviders, args, getConfig, {
				onUpdate: (next) => {
					latest = next;
				},
				onProviderDone: () => {},
				onAllDone: () => resolve(latest),
			});
		});

	const startSearch = (queryOverride?: string) => {
		const query = (queryOverride ?? searchQuery).trim();
		if (!anySourceEnabled) {
			setMessage({
				type: "error",
				text: "Turn on a metadata source in Settings → Metadata first.",
			});
			return;
		}
		if (!query && !fileIsbn) return;

		searchHandleRef.current?.abort();
		setIsSearching(true);
		setResults([]);
		setPendingProviders(enabledProviders.map((provider) => provider.id));

		searchHandleRef.current = searchAcrossProviders(
			enabledProviders,
			{ query, isbn: fileIsbn },
			getConfig,
			{
				onUpdate: setResults,
				onProviderDone: (id) =>
					setPendingProviders((prev) => prev.filter((p) => p !== id)),
				onAllDone: () => {
					setIsSearching(false);
					setPendingProviders([]);
				},
			},
		);
	};

	const fetchFromIsbn = async () => {
		if (!anySourceEnabled) {
			setMessage({
				type: "error",
				text: "Turn on a metadata source in Settings → Metadata first.",
			});
			return;
		}
		if (!fileIsbn) {
			setMessage({
				type: "error",
				text: "This book needs a valid ISBN to look up metadata.",
			});
			return;
		}

		setIsFetching(true);
		setMessage(null);
		try {
			const found = await runLookup({ query: "", isbn: fileIsbn });
			const match = found.find((result) => result.isIsbnMatch) ?? found[0];
			if (!match) {
				setMessage({
					type: "error",
					text: `No match found for ISBN ${fileIsbn}.`,
				});
				return;
			}
			await applyBookToLibrary(match.book);
			setMessage({
				type: "success",
				text: `Updated from ${getDescriptor(match.book.provider).displayName}.`,
			});
		} catch (error) {
			setMessage({ type: "error", text: `Error: ${errorText(error)}` });
		} finally {
			setIsFetching(false);
		}
	};

	const openSearch = (initialQuery: string) => {
		setSearchQuery(initialQuery);
		setMessage(null);
		setIsSearchModalOpen(true);
		startSearch(initialQuery);
	};

	const selectResult = async (result: AggregatedResult) => {
		searchHandleRef.current?.abort();
		try {
			await applyBookToLibrary(result.book);
			setIsSearchModalOpen(false);
			setMessage({
				type: "success",
				text: `Updated from ${getDescriptor(result.book.provider).displayName}.`,
			});
		} catch (error) {
			setMessage({ type: "error", text: `Error: ${errorText(error)}` });
		}
	};

	const stopSearch = () => {
		searchHandleRef.current?.abort();
		setIsSearching(false);
		setPendingProviders([]);
	};

	const openIdentifierLink = async (label: string, value: string) => {
		const url = deepLinkForIdentifier(label, value);
		if (!url) {
			setMessage({
				type: "error",
				text: "No link is available for this identifier.",
			});
			return;
		}
		try {
			await platform.fileOpener.openPath(url);
		} catch (error) {
			setMessage({
				type: "error",
				text: `Failed to open link: ${errorText(error)}`,
			});
		}
	};

	return {
		anySourceEnabled,
		isFetching,
		message,
		setMessage,
		isSearchModalOpen,
		setIsSearchModalOpen,
		searchQuery,
		setSearchQuery,
		isSearching,
		results,
		pendingProviderNames: pendingProviders.map(
			(id) => getDescriptor(id).displayName,
		),
		lastResolvedSubjects,
		lastResolvedGenres,
		lastSubjectsSource,
		isbnIdentifier,
		fetchFromIsbn,
		openSearch,
		search: () => startSearch(),
		selectResult,
		stopSearch,
		openIdentifierLink,
	};
};
