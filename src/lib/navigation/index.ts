/**
 * Scroll regions the router records per history entry, so going Back can
 * return to where the entry was left. Pages apply the record themselves
 * (useEntryScroll): their content can arrive after the route renders, when
 * the router's own restore would land short.
 */
export const SCROLL_REGION = {
	libraryGrid: "library-grid",
} as const;

export type TScrollRegion = (typeof SCROLL_REGION)[keyof typeof SCROLL_REGION];

export const scrollRegionAttributes = (region: TScrollRegion) => ({
	"data-scroll-restoration-id": region,
});

/** Record scroll positions, but leave restoring them to the pages. */
export const scrollRestorationOptions = {
	scrollRestoration: () => false,
};
