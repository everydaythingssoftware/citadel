import type { SVGProps } from "react";

/** 16px stroked glyphs for inline row actions; they inherit the text color. */
const Glyph = ({
	title,
	children,
	...props
}: SVGProps<SVGSVGElement> & { title: string }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="16"
		height="16"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.4"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
		{...props}
	>
		<title>{title}</title>
		{children}
	</svg>
);

export const GlyphLookUp = (props: SVGProps<SVGSVGElement>) => (
	<Glyph title="Look up" {...props}>
		<circle cx="7" cy="7" r="4.25" />
		<path d="M10.25 10.25 13.5 13.5" />
	</Glyph>
);

export const GlyphOpenExternal = (props: SVGProps<SVGSVGElement>) => (
	<Glyph title="Open" {...props}>
		<path d="M6.5 3.5h-3v9h9v-3" />
		<path d="M9 2.75h4.25V7M13 3 7.75 8.25" />
	</Glyph>
);

export const GlyphRemove = (props: SVGProps<SVGSVGElement>) => (
	<Glyph title="Remove" {...props}>
		<circle cx="8" cy="8" r="5.75" />
		<path d="M5.5 8h5" />
	</Glyph>
);

export const GlyphDownload = (props: SVGProps<SVGSVGElement>) => (
	<Glyph title="Download" {...props}>
		<path d="M8 2.5v7.5M4.75 7 8 10.25 11.25 7M3 13.25h10" />
	</Glyph>
);
