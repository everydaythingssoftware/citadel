import type { SVGProps } from "react";

/** Delete: a bin drawn in the same stroke as EditGlyph; sizes with the font. */
export const TrashGlyph = (props: SVGProps<SVGSVGElement>) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="1em"
		height="1em"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.3"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
		{...props}
	>
		<path d="M2.75 4.25h10.5M6.25 4.25V3a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75v1.25" />
		<path d="m3.9 4.25.65 8.6a1 1 0 0 0 1 .9h4.9a1 1 0 0 0 1-.9l.65-8.6M6.6 6.75v4.5M9.4 6.75v4.5" />
	</svg>
);
