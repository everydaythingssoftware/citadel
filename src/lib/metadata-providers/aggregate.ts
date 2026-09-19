import type { BookMetadata } from "@/bindings";
import { isbnEquivalent, toIsbn13 } from "@/lib/isbn";
import { getAdapter, getDescriptor } from "./registry";
import type {
	ProviderDescriptor,
	ProviderId,
	ResolvedProviderConfig,
} from "./types";

export interface AggregatedResult {
	/** The winning record, plus a borrowed cover and merged genre candidates. */
	book: BookMetadata;
	/** Display names of other providers that returned the same ISBN. */
	alsoOn: string[];
	/** Whether this row's ISBN matches the originating file's ISBN. */
	isIsbnMatch: boolean;
}

/**
 * Merge results from several providers into one list. Records sharing an ISBN
 * collapse to the single highest-preference provider's WHOLE record — no
 * field-level merge — except that a cover-less winner borrows a peer's cover
 * and explicit, provenanced genre candidates are combined. Rows matching
 * `pinIsbn` are pinned to the top.
 */
export const mergeResults = (
	books: BookMetadata[],
	order: ProviderId[],
	pinIsbn: string | null,
): AggregatedResult[] => {
	const rank = (id: ProviderId) => {
		const index = order.indexOf(id);
		return index === -1 ? Number.MAX_SAFE_INTEGER : index;
	};

	// Group by normalized ISBN; ISBN-less rows are their own singleton groups.
	const groups = new Map<string, BookMetadata[]>();
	const groupOrder: string[] = [];
	for (const book of books) {
		const canonical = book.isbn ? toIsbn13(book.isbn) : undefined;
		const key = canonical ?? `nokey:${book.provider}:${book.provider_id}`;
		const existing = groups.get(key);
		if (existing) {
			existing.push(book);
		} else {
			groups.set(key, [book]);
			groupOrder.push(key);
		}
	}

	const results: AggregatedResult[] = [];
	for (const key of groupOrder) {
		const members = groups.get(key);
		if (!members || members.length === 0) continue;

		const sorted = [...members].sort(
			(a, b) => rank(a.provider) - rank(b.provider),
		);
		const top = sorted[0];
		if (!top) continue;

		const winner: BookMetadata = { ...top };
		if (!winner.image_url) {
			const peerCover = sorted.find((member) => member.image_url);
			if (peerCover) winner.image_url = peerCover.image_url;
		}
		const seenGenres = new Set<string>();
		winner.genre_candidates = sorted
			.flatMap((member) => member.genre_candidates)
			.filter((candidate) => {
				const key = candidate.name.trim().toLocaleLowerCase();
				if (!key || seenGenres.has(key)) return false;
				seenGenres.add(key);
				return true;
			});

		const alsoOn = [
			...new Set(
				sorted
					.slice(1)
					.map((member) => member.provider)
					.filter((provider) => provider !== top.provider),
			),
		].map((provider) => getDescriptor(provider).displayName);

		results.push({
			book: winner,
			alsoOn,
			isIsbnMatch: pinIsbn ? isbnEquivalent(winner.isbn, pinIsbn) : false,
		});
	}

	// Pin ISBN matches to the top; otherwise keep first-seen order (stable sort).
	return results
		.map((result, index) => ({ result, index }))
		.sort((a, b) => {
			if (a.result.isIsbnMatch !== b.result.isIsbnMatch) {
				return a.result.isIsbnMatch ? -1 : 1;
			}
			return a.index - b.index;
		})
		.map(({ result }) => result);
};

export interface SearchHandle {
	abort: () => void;
}

export interface SearchCallbacks {
	/** Called with the merged results each time a provider returns. */
	onUpdate: (results: AggregatedResult[]) => void;
	/** Called when a single provider finishes (ok=false if it errored). */
	onProviderDone: (id: ProviderId, ok: boolean) => void;
	/** Called once every provider has settled. */
	onAllDone: () => void;
}

/**
 * Search across providers concurrently, emitting merged results as each one
 * returns (so a slow library never blocks a fast one). Returns a handle whose
 * `abort()` suppresses any further updates.
 */
export const searchAcrossProviders = (
	providers: ProviderDescriptor[],
	args: { query: string; isbn: string | null },
	getConfig: (id: ProviderId) => ResolvedProviderConfig,
	callbacks: SearchCallbacks,
): SearchHandle => {
	let aborted = false;
	const order = providers.map((provider) => provider.id);
	const byProvider = new Map<ProviderId, BookMetadata[]>();
	let remaining = providers.length;

	if (providers.length === 0) {
		callbacks.onAllDone();
		return { abort: () => {} };
	}

	const emit = () => {
		const all = order.flatMap((id) => byProvider.get(id) ?? []);
		callbacks.onUpdate(mergeResults(all, order, args.isbn));
	};

	const query = args.query.trim();

	for (const descriptor of providers) {
		const adapter = getAdapter(descriptor.id);
		const config = getConfig(descriptor.id);

		const tasks: Promise<BookMetadata[]>[] = [];
		if (args.isbn) tasks.push(adapter.searchByIsbn(args.isbn, config));
		if (query && descriptor.capabilities.supportsFreeTextSearch) {
			tasks.push(adapter.search(query, config));
		}

		const work = tasks.length
			? Promise.allSettled(tasks)
			: Promise.resolve<PromiseSettledResult<BookMetadata[]>[]>([]);

		work
			.then((settled) => {
				if (aborted) return;
				const books = settled.flatMap((outcome) =>
					outcome.status === "fulfilled" ? outcome.value : [],
				);
				const ok =
					settled.every((outcome) => outcome.status === "fulfilled") ||
					books.length > 0;

				// Dedupe within a provider by its native id.
				const seen = new Set<string>();
				const deduped = books.filter((book) => {
					const dedupeKey = `${book.provider}:${book.provider_id}`;
					if (seen.has(dedupeKey)) return false;
					seen.add(dedupeKey);
					return true;
				});

				byProvider.set(descriptor.id, deduped);
				callbacks.onProviderDone(descriptor.id, ok);
				emit();
			})
			.finally(() => {
				remaining -= 1;
				if (remaining === 0 && !aborted) callbacks.onAllDone();
			});
	}

	return {
		abort: () => {
			aborted = true;
		},
	};
};
