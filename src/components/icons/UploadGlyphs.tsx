import type { SVGProps } from "react";

/** Stroke glyphs for the upload flow, drawn at 24×24 and sized by `1em`. */
const Glyph = ({ children, ...props }: SVGProps<SVGSVGElement>) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="1em"
		height="1em"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth={2}
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
		{...props}
	>
		{children}
	</svg>
);

export const XmarkGlyph = (props: SVGProps<SVGSVGElement>) => (
	<Glyph {...props}>
		<path d="M6 6l12 12M18 6 6 18" />
	</Glyph>
);

export const AlertGlyph = (props: SVGProps<SVGSVGElement>) => (
	<Glyph {...props}>
		<circle cx="12" cy="12" r="9" />
		<path d="M12 7v6M12 16.5v.5" />
	</Glyph>
);

export const ChevronLeftGlyph = (props: SVGProps<SVGSVGElement>) => (
	<Glyph {...props}>
		<path d="m15 6-6 6 6 6" />
	</Glyph>
);

export const ChevronRightGlyph = (props: SVGProps<SVGSVGElement>) => (
	<Glyph {...props}>
		<path d="m9 6 6 6-6 6" />
	</Glyph>
);

export const PlusGlyph = (props: SVGProps<SVGSVGElement>) => (
	<Glyph {...props}>
		<path d="M12 5v14M5 12h14" />
	</Glyph>
);

/** An arrow rising out of a tray: uploading. */
export const UploadGlyph = (props: SVGProps<SVGSVGElement>) => (
	<Glyph {...props}>
		<path d="M12 15V4" />
		<path d="m7 9 5-5 5 5" />
		<path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
	</Glyph>
);
