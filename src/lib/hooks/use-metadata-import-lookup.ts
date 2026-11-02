import { useEffect, useRef, useState } from "react";
import type { BookMetadata } from "@/bindings";
import { normalizeIsbn } from "@/lib/isbn";
import type {
	AggregatedResult,
	SearchHandle,
} from "@/lib/metadata-providers/aggregate";
import { searchAcrossProviders } from "@/lib/metadata-providers/aggregate";
import { getDescriptor } from "@/lib/metadata-providers/registry";
import type { ProviderId } from "@/lib/metadata-providers/types";
import { metadataService } from "@/lib/services/metadata";
import {
	useAutoLookupOnImport,
	useEnabledProviders,
	useResolvedProviderConfig,
} from "@/stores/settings/metadata-providers";

export interface MetadataImportMessage {
	type: "success" | "error";
	text: string;
}

/** How the current pending metadata was produced. */
export type PendingMetadataSource = "auto" | "manual";

interface UseMetadataImportLookupParams {
	/** The imported file's embedded identifier (e.g. an ISBN from an EPUB). */
	fileIdentifier: string | null;
}

/**
 * Metadata lookup for the Add Book (import) flow. Unlike the Edit Book hook this
 * never touches the library — the book does not exist yet. Lookups produce a
 * pending record that the caller applies after the book is created.
 */
export const useMetadataImportLookup = ({
	fileIdentifier,
}: UseMetadataImportLookupParams) => {
	const enabledProviders = useEnabledProviders();
	const getConfig = useResolvedProviderConfig();
	const autoLookup = useAutoLookupOnImport();
	const anySourceEnabled = enabledProviders.length > 0;

	const [pending, setPending] = useState<{
		metadata: BookMetadata;
		source: PendingMetadataSource;
	} | null>(null);
	const [message, setMessage] = useState<MetadataImportMessage | null>(null);
	const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [isSearching, setIsSearching] = useState(false);
	const [results, setResults] = useState<AggregatedResult[]>([]);
	const [pendingProviders, setPendingProviders] = useState<ProviderId[]>([]);
	const searchHandleRef = useRef<SearchHandle | null>(null);
	// Cover previews use IDs that expire; a broken preview re-runs the
	// search once per opening to get fresh ones.
	const coverRetriedRef = useRef(false);

	// The chosen cover is applied only after the book is created; fetch it at
	// full size now so that step doesn't wait on the provider.
	const pendingCoverId = pending?.metadata.cover_id ?? null;
	useEffect(() => {
		if (pendingCoverId)
			void metadataService.prefetchCover(pendingCoverId).catch(() => {});
	}, [pendingCoverId]);

	// Guards against stale async resolutions: any lookup, selection, or clear
	// bumps the generation; an in-flight operation only commits if its captured
	// generation is still current.
	const generationRef = useRef(0);

	const fileIsbn = fileIdentifier
		? (normalizeIsbn(fileIdentifier) ?? null)
		: null;
	const canLookupByIsbn = anySourceEnabled && Boolean(fileIsbn);

	useEffect(
		() => () => {
			searchHandleRef.current?.abort();
		},
		[],
	);

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

	const autoLookupFromFileIsbn = async () => {
		if (!fileIsbn || !anySourceEnabled) return;
		generationRef.current += 1;
		const generation = generationRef.current;
		try {
			const found = await runLookup({ query: "", isbn: fileIsbn });
			if (generationRef.current !== generation) return;
			// The user didn't ask for this, so a miss stays silent.
			const match = found.find((result) => result.isIsbnMatch) ?? found[0];
			if (match) setPending({ metadata: match.book, source: "auto" });
		} catch {
			// Silent for the same reason.
		}
	};

	const startSearch = (queryOverride?: string) => {
		const query = (queryOverride ?? searchQuery).trim();
		if (!anySourceEnabled || (!query && !fileIsbn)) return;

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

	const openSearch = (initialQuery: string) => {
		coverRetriedRef.current = false;
		setSearchQuery(initialQuery);
		setResults([]);
		setIsSearchModalOpen(true);
		if (initialQuery.trim() || canLookupByIsbn) startSearch(initialQuery);
	};

	const selectSearchResult = (result: AggregatedResult) => {
		generationRef.current += 1;
		searchHandleRef.current?.abort();
		setPending({ metadata: result.book, source: "manual" });
		setMessage(null);
		setIsSearchModalOpen(false);
	};

	const retryAfterCoverError = () => {
		if (coverRetriedRef.current || isSearching) return;
		coverRetriedRef.current = true;
		startSearch();
	};

	const stopSearch = () => {
		searchHandleRef.current?.abort();
		setIsSearching(false);
		setPendingProviders([]);
	};

	// Auto-lookup once on mount when enabled and the file has a usable ISBN.
	const didAutoLookup = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberately fires at most once, guarded by didAutoLookup.
	useEffect(() => {
		if (didAutoLookup.current) return;
		if (!autoLookup || !canLookupByIsbn) return;
		didAutoLookup.current = true;
		void autoLookupFromFileIsbn();
	}, [autoLookup, canLookupByIsbn]);

	return {
		anySourceEnabled,
		pending: pending?.metadata ?? null,
		pendingSource: pending?.source ?? null,
		message,
		isSearchModalOpen,
		searchQuery,
		setSearchQuery,
		isSearching,
		results,
		pendingProviderNames: pendingProviders.map(
			(id) => getDescriptor(id).displayName,
		),
		clearMessage: () => setMessage(null),
		closeSearchModal: () => setIsSearchModalOpen(false),
		openSearch,
		search: () => startSearch(),
		selectSearchResult,
		retryAfterCoverError,
		stopSearch,
		clearPending: () => {
			generationRef.current += 1;
			setPending(null);
		},
	};
};
