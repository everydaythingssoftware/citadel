import type { SVGProps } from "react";

/**
 * Edit, the way macOS draws it (square.and.pencil): a page with a pencil
 * writing out of its corner. Stroked like the other row glyphs; sizes with
 * the surrounding font (1em).
 */
export const EditGlyph = (props: SVGProps<SVGSVGElement>) => (
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
		<path d="M7.5 2.75H4.25a1.5 1.5 0 0 0-1.5 1.5v7.5a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5V8.5" />
		<path d="M12.15 2.35a1.27 1.27 0 0 1 1.8 1.8L8.5 9.6l-2.4.6.6-2.4 5.45-5.45Z" />
	</svg>
);
