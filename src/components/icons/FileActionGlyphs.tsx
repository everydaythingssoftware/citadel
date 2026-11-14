import type { SVGProps } from "react";

/**
 * File-row actions in two drawings: macOS's (thin, SF Symbols-like, on a
 * 16px grid) and our icon pack's (Tabler, on a 24px grid) for Windows and
 * Linux. All inherit the text colour.
 */
const Glyph = ({
	viewBox,
	strokeWidth,
	children,
	...props
}: SVGProps<SVGSVGElement>) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="16"
		height="16"
		viewBox={viewBox}
		fill="none"
		stroke="currentColor"
		strokeWidth={strokeWidth}
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
		{...props}
	>
		{children}
	</svg>
);

/** "folder": Show in Finder. */
export const MacFolderGlyph = (props: SVGProps<SVGSVGElement>) => (
	<Glyph viewBox="0 0 16 16" strokeWidth={1.25} {...props}>
		<path d="M1.75 4.4c0-.75.6-1.35 1.35-1.35h2.7c.36 0 .7.14.95.4l1.05 1.05h5.1c.75 0 1.35.6 1.35 1.35v6.3c0 .75-.6 1.35-1.35 1.35H3.1c-.75 0-1.35-.6-1.35-1.35Z" />
		<path d="M1.75 6.5h12.5" />
	</Glyph>
);

/** "book": Open, when no app claims the file type. */
export const MacOpenBookGlyph = (props: SVGProps<SVGSVGElement>) => (
	<Glyph viewBox="0 0 16 16" strokeWidth={1.25} {...props}>
		<path d="M8 4.2C6.6 3.2 4.7 2.9 2.5 3.2v9c2.2-.3 4.1 0 5.5 1 1.4-1 3.3-1.3 5.5-1v-9c-2.2-.3-4.1 0-5.5 1Zm0 0v9" />
	</Glyph>
);

/** Tabler "folder": Show in File Explorer / File Manager. */
export const TablerFolderGlyph = (props: SVGProps<SVGSVGElement>) => (
	<Glyph viewBox="0 0 24 24" strokeWidth={1.75} {...props}>
		<path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2" />
	</Glyph>
);

/** Tabler "book": Open. */
export const TablerOpenBookGlyph = (props: SVGProps<SVGSVGElement>) => (
	<Glyph viewBox="0 0 24 24" strokeWidth={1.75} {...props}>
		<path d="M3 19a9 9 0 0 1 9 0a9 9 0 0 1 9 0" />
		<path d="M3 6a9 9 0 0 1 9 0a9 9 0 0 1 9 0" />
		<path d="M3 6v13M12 6v13M21 6v13" />
	</Glyph>
);

/** Try a failed download again. */
export const RetryGlyph = (props: SVGProps<SVGSVGElement>) => (
	<Glyph viewBox="0 0 16 16" strokeWidth={1.3} {...props}>
		<path d="M12.9 8.6A5 5 0 1 1 11.4 4.4" />
		<path d="M11.9 1.9v2.9H9" />
	</Glyph>
);
