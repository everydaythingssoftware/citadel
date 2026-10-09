import { Link } from "@tanstack/react-router";
import clsx from "clsx";
import { type CSSProperties, useMemo, useState } from "react";

import type { LibrarySeries } from "@/bindings";
import { SearchField } from "@/components/ui";
import { useSeriesRows } from "@/lib/hooks/use-series-rows";
import { useSeriesList, useSeriesLoading } from "@/stores/library/store";
import styles from "./Series.module.css";

/**
 * Shared column template so the header row and every series row align:
 * name (flexible) | count (fixed).
 */
const SERIES_GRID: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "minmax(160px, 1fr) 72px",
	alignItems: "center",
	columnGap: 16,
};

export const Series = () => {
	// The store's series list (clb_query_list_series) arrives sorted by name
	// with book counts; no need to derive it from the full book list.
	const seriesList = useSeriesList();
	const loadingSeries = useSeriesLoading();

	const [searchTerm, setSearchTerm] = useState("");

	const filteredSeries = useMemo(() => {
		const lowerSearch = searchTerm.toLowerCase();
		return seriesList.filter(({ name }) =>
			name.toLowerCase().includes(lowerSearch),
		);
	}, [seriesList, searchTerm]);

	if (loadingSeries) {
		return null;
	}

	return (
		<div className={styles.page}>
			<div className={styles.filterBar}>
				<SearchField
					placeholder="Search series"
					aria-label="Search series"
					value={searchTerm}
					onChange={(event) => setSearchTerm(event.currentTarget.value)}
					className={styles.searchInput}
				/>
			</div>

			<div data-series-header className={styles.headerRow} style={SERIES_GRID}>
				<span className={styles.columnLabel}>Name</span>
				<span className={clsx(styles.columnLabel, styles.columnLabelRight)}>
					Books
				</span>
			</div>

			<SeriesRows series={filteredSeries} />

			<div data-series-footer className={styles.footer}>
				<span className={styles.footerText}>
					{filteredSeries.length === seriesList.length
						? `${seriesList.length} series`
						: `${filteredSeries.length} of ${seriesList.length} series`}
				</span>
			</div>
		</div>
	);
};

interface SeriesRowsProps {
	series: LibrarySeries[];
}

const SeriesRows = ({ series }: SeriesRowsProps) => {
	const { rowsRef, virtualizer, scrollMargin } = useSeriesRows(series);

	return (
		<div
			ref={rowsRef}
			className={styles.rows}
			style={{ position: "relative", height: virtualizer.getTotalSize() }}
		>
			{virtualizer.getVirtualItems().map((virtualRow) => {
				const item = series[virtualRow.index];
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
						<SeriesRow series={item} />
					</div>
				);
			})}
		</div>
	);
};

const SeriesRow = ({ series }: { series: LibrarySeries }) => {
	return (
		// The whole row links to the library filtered by this series. The hover
		// background, 40px min-height, and the overlay-link positioning live in
		// styles.css (.ctd-author-row / .ctd-author-row-link).
		<div className={clsx("ctd-author-row", styles.row)} style={SERIES_GRID}>
			{/* Real anchor overlaying the row so middle-click / cmd-click /
			    keyboard all work. The count link sits above it (position:
			    relative + zIndex), so it keeps working without stopPropagation. */}
			<Link
				to="/"
				search={{ series_id: series.id }}
				className="ctd-author-row-link"
				aria-label={`Show books in ${series.name}`}
			/>

			<span className={styles.cellText}>{series.name}</span>

			<Link
				to="/"
				search={{ series_id: series.id }}
				className={styles.countLink}
			>
				{series.book_count}
			</Link>
		</div>
	);
};
