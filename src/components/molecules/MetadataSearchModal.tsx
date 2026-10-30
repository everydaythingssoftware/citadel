import { F7BookFill } from "@/components/icons/F7BookFill";
import { Button, Sheet, Spinner, TextInput } from "@/components/ui";
import type { AggregatedResult } from "@/lib/metadata-providers/aggregate";
import { getDescriptor } from "@/lib/metadata-providers/registry";
import styles from "./MetadataSearchModal.module.css";

export interface MetadataSearchModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	query: string;
	onQueryChange: (query: string) => void;
	/** Called when the user presses Enter or clicks the Search button. */
	onSearch: () => void;
	/** Whether any provider is still in flight. */
	isSearching: boolean;
	results: AggregatedResult[];
	/** Display names of providers still being queried, for the trickle footer. */
	pendingProviderNames: string[];
	onSelect: (result: AggregatedResult) => void;
	/** Stops in-flight provider searches. */
	onStop?: () => void;
	/** A cover preview failed to load, e.g. because its ID expired. */
	onCoverError?: () => void;
	/** When set, rendered as an error notice above the results area. */
	error?: string | null;
	width?: number;
}

/**
 * The unified "Find book details" sheet, shared by Edit Book and the Add Book
 * import flow. Purely presentational — the caller owns all state. Results from
 * any provider share one list; each row shows where it came from and a designed
 * placeholder when the source carries no cover.
 */
export const MetadataSearchModal = ({
	open,
	onOpenChange,
	query,
	onQueryChange,
	onSearch,
	isSearching,
	results,
	pendingProviderNames,
	onSelect,
	onStop,
	onCoverError,
	error = null,
	width = 780,
}: MetadataSearchModalProps) => (
	<Sheet
		open={open}
		onOpenChange={onOpenChange}
		title="Find book details"
		width={width}
	>
		<div className={styles.searchStack}>
			<div className={styles.inlineControls}>
				<TextInput
					placeholder="Search by title, author, or ISBN…"
					className={styles.flexGrow}
					value={query}
					onChange={(event) => onQueryChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							onSearch();
						}
					}}
				/>
				<Button variant="primary" disabled={isSearching} onClick={onSearch}>
					Search
				</Button>
			</div>
			{error && (
				<p className={styles.errorNote} role="alert">
					{error}
				</p>
			)}
			<div className={styles.searchResults}>
				{results.length === 0 ? (
					<div className={styles.searchEmpty}>
						{isSearching ? (
							<Spinner />
						) : query ? (
							"No matches found. Try a different title, or search by ISBN."
						) : (
							"Search your enabled sources by title, author, or ISBN."
						)}
					</div>
				) : (
					results.map((result) => (
						<button
							type="button"
							key={`${result.book.provider}:${result.book.provider_id}`}
							className={styles.searchResult}
							onClick={() => onSelect(result)}
						>
							{result.coverUrl ? (
								<img
									src={result.coverUrl}
									alt={result.book.title}
									className={styles.searchResultCover}
									onError={onCoverError}
								/>
							) : (
								<span className={styles.coverPlaceholder} aria-hidden>
									<F7BookFill className={styles.coverPlaceholderIcon} />
								</span>
							)}
							<div className={styles.searchResultMeta}>
								<span className={styles.searchResultTitle}>
									{result.book.title}
									{result.book.subtitle ? `: ${result.book.subtitle}` : ""}
									{result.isIsbnMatch && (
										<span className={styles.isbnBadge}>Matches ISBN</span>
									)}
								</span>
								{result.book.authors.length > 0 && (
									<span className={styles.searchResultDetail}>
										{result.book.authors.join(", ")}
									</span>
								)}
								{(result.book.release_year || result.book.publisher) && (
									<span className={styles.searchResultDetail}>
										{[result.book.release_year, result.book.publisher]
											.filter(Boolean)
											.join(" · ")}
									</span>
								)}
								<span className={styles.searchResultProvenance}>
									{provenance(result)}
								</span>
							</div>
						</button>
					))
				)}
			</div>
			{pendingProviderNames.length > 0 && (
				<div className={styles.trickleFooter}>
					<Spinner size={14} />
					<span className={styles.trickleText}>
						Still checking {joinNames(pendingProviderNames)}…
					</span>
					{onStop && (
						<Button variant="subtle" size="sm" onClick={onStop}>
							Stop
						</Button>
					)}
				</div>
			)}
		</div>
	</Sheet>
);

const provenance = (result: AggregatedResult): string => {
	const winner = getDescriptor(result.book.provider).displayName;
	if (result.alsoOn.length === 0) return winner;
	return `${winner} · also on ${result.alsoOn.join(", ")}`;
};

const joinNames = (names: string[]): string => {
	if (names.length === 1) return names[0] ?? "";
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
};
