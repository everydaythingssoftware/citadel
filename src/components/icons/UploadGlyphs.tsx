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

export const ChevronDownGlyph = (props: SVGProps<SVGSVGElement>) => (
	<Glyph {...props}>
		<path d="m6 9 6 6 6-6" />
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

/** Two pages, one behind the other: drafts waiting. */
export const DraftsGlyph = (props: SVGProps<SVGSVGElement>) => (
	<Glyph {...props}>
		<path d="M8 3h7l4 4v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
		<path d="M15 3v4h4" />
		<path d="M4 7v13a1 1 0 0 0 1 1h10" />
	</Glyph>
);

/** An in-tray: things waiting for you. */
export const TrayGlyph = (props: SVGProps<SVGSVGElement>) => (
	<Glyph {...props}>
		<path d="M3 13h5l1.5 3h5L16 13h5" />
		<path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z" />
	</Glyph>
);

/** Three book spines, one leaning: books waiting to be shelved. */
export const BooksGlyph = (props: SVGProps<SVGSVGElement>) => (
	<Glyph {...props}>
		<rect x="4" y="5" width="4" height="15" rx="0.5" />
		<rect x="9" y="3" width="4" height="17" rx="0.5" />
		<path d="m15 7.5 3.8-1.2 3.2 12.6-3.8 1.1Z" />
	</Glyph>
);

/** A calendar page showing a day of the month. */
export const CalendarGlyph = ({
	day,
	...props
}: SVGProps<SVGSVGElement> & { day: number }) => (
	<Glyph {...props}>
		<rect x="3.5" y="5" width="17" height="15.5" rx="2" />
		<path d="M3.5 9.5h17M8 3v4M16 3v4" />
		<text
			x="12"
			y="18.2"
			textAnchor="middle"
			fontSize="8"
			fontWeight="700"
			fill="currentColor"
			stroke="none"
			fontFamily="system-ui, sans-serif"
		>
			{day}
		</text>
	</Glyph>
);
