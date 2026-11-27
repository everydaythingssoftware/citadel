/**
 * Drilling down from a list page (Authors, Series, Tags, Publishers) into
 * the books of one row. The books view carries where it came from in its
 * search (`from`), so the sidebar keeps that section lit, a breadcrumb leads
 * back, and a reload keeps both.
 */

export const DRILL_SOURCE = {
	authors: "authors",
	series: "series",
	tags: "tags",
	publishers: "publishers",
} as const;

export type TDrillSource = (typeof DRILL_SOURCE)[keyof typeof DRILL_SOURCE];

const SOURCES: readonly TDrillSource[] = Object.values(DRILL_SOURCE);

export const drillSourceFrom = (value: unknown): TDrillSource | undefined =>
	SOURCES.find((source) => source === value);

/** The list page a drill-down came from, as the sidebar links it. */
export const drillSourcePath = (
	source: TDrillSource,
): "/authors" | "/series" | "/tags" | "/publishers" => `/${source}`;

/** The breadcrumb's first step, the list's name in the sidebar. */
export const DRILL_SOURCE_LABEL: Record<TDrillSource, string> = {
	authors: "Authors",
	series: "Series",
	tags: "Tags",
	publishers: "Publishers",
};

/** The row filter each list drills down with. */
export interface DrillFilters {
	author_id?: string;
	series_id?: number;
	tag_id?: number;
	publisher_id?: number;
}

/** Whether `filters` holds the filter of the list `source` names. */
export const drillFilterPresent = (
	source: TDrillSource,
	filters: DrillFilters,
): boolean => {
	switch (source) {
		case DRILL_SOURCE.authors:
			return filters.author_id !== undefined;
		case DRILL_SOURCE.series:
			return filters.series_id !== undefined;
		case DRILL_SOURCE.tags:
			return filters.tag_id !== undefined;
		case DRILL_SOURCE.publishers:
			return filters.publisher_id !== undefined;
	}
};
