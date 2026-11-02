import { Link } from "@tanstack/react-router";
import clsx from "clsx";
import { type CSSProperties, useMemo, useState } from "react";

import { SearchField } from "@/components/ui";
import { useVirtualListRows } from "@/lib/hooks/use-virtual-list-rows";
import styles from "./NamedCountList.module.css";

/** A named library entity with its linked-book count. */
export interface NamedCount {
	id: number;
	name: string;
	book_count: number;
}

/** Deep-link search params for the library route ("/"). */
export type BookListSearch =
	| { series_id: number }
	| { tag_id: number }
	| { publisher_id: number };

/**
 * Shared column template so the header row and every row align:
 * name (flexible) | count (fixed).
 */
const ROW_GRID: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "minmax(160px, 1fr) 72px",
	alignItems: "center",
	columnGap: 16,
};

interface NamedCountListProps<T extends NamedCount> {
	/** Rows, already sorted by name. */
	items: T[];
	/**
	 * Names the page's `data-{kind}-header` / `data-{kind}-footer` hooks,
	 * which the list regression tooling (tools/testing) looks for.
	 */
	kind: string;
	/** Singular and plural nouns, e.g. ["tag", "tags"]. */
	noun: readonly [one: string, many: string];
	/** Where a row links to: the library filtered by this entry. */
	toSearch: (item: T) => BookListSearch;
}

/**
 * A searchable, virtualized "name | book count" list that links each row to
 * the library filtered by that entry. Backs the Series, Tags and Publishers
 * pages.
 */
export const NamedCountList = <T extends NamedCount>({
	items,
	kind,
	noun,
	toSearch,
}: NamedCountListProps<T>) => {
	const [searchTerm, setSearchTerm] = useState("");
	const [one, many] = noun;

	const filteredItems = useMemo(() => {
		const lowerSearch = searchTerm.toLowerCase();
		return items.filter(({ name }) => name.toLowerCase().includes(lowerSearch));
	}, [items, searchTerm]);

	const countNoun = (count: number) => (count === 1 ? one : many);

	return (
		<div className={styles.page}>
			<div className={styles.filterBar}>
				<SearchField
					placeholder={`Search ${many}`}
					aria-label={`Search ${many}`}
					value={searchTerm}
					onChange={(event) => setSearchTerm(event.currentTarget.value)}
					className={styles.searchInput}
				/>
			</div>

			<div
				{...{ [`data-${kind}-header`]: "" }}
				className={styles.headerRow}
				style={ROW_GRID}
			>
				<span className={styles.columnLabel}>Name</span>
				<span className={clsx(styles.columnLabel, styles.columnLabelRight)}>
					Books
				</span>
			</div>

			<NamedCountRows items={filteredItems} toSearch={toSearch} />

			<div {...{ [`data-${kind}-footer`]: "" }} className={styles.footer}>
				<span className={styles.footerText}>
					{filteredItems.length === items.length
						? `${items.length} ${countNoun(items.length)}`
						: `${filteredItems.length} of ${items.length} ${countNoun(items.length)}`}
				</span>
			</div>
		</div>
	);
};

interface NamedCountRowsProps<T extends NamedCount> {
	items: T[];
	toSearch: (item: T) => BookListSearch;
}

const NamedCountRows = <T extends NamedCount>({
	items,
	toSearch,
}: NamedCountRowsProps<T>) => {
	const { rowsRef, virtualizer, scrollMargin } = useVirtualListRows(items);

	return (
		<div
			ref={rowsRef}
			className={styles.rows}
			style={{ position: "relative", height: virtualizer.getTotalSize() }}
		>
			{virtualizer.getVirtualItems().map((virtualRow) => {
				const item = items[virtualRow.index];
				if (!item) return null;
				return (
					<div
						key={virtualRow.key}
						ref={virtualizer.measureElement}
						data-index={virtualRow.index}
						style={{
							position: "absolute",
							top: 0,
							left: 0,
							width: "100%",
							transform: `translateY(${virtualRow.start - scrollMargin}px)`,
						}}
					>
						<NamedCountRow item={item} search={toSearch(item)} />
					</div>
				);
			})}
		</div>
	);
};

const NamedCountRow = ({
	item,
	search,
}: {
	item: NamedCount;
	search: BookListSearch;
}) => {
	return (
		// The whole row links to the library filtered by this entry. The hover
		// background, 40px min-height, and the overlay-link positioning live in
		// styles.css (.ctd-author-row / .ctd-author-row-link).
		<div className={clsx("ctd-author-row", styles.row)} style={ROW_GRID}>
			{/* Real anchor overlaying the row so middle-click / cmd-click /
			    keyboard all work. The count link sits above it (position:
			    relative + zIndex), so it keeps working without stopPropagation. */}
			<Link
				to="/"
				search={search}
				className="ctd-author-row-link"
				aria-label={`Show books in ${item.name}`}
			/>

			<span className={styles.cellText}>{item.name}</span>

			<Link to="/" search={search} className={styles.countLink}>
				{item.book_count}
			</Link>
		</div>
	);
};
