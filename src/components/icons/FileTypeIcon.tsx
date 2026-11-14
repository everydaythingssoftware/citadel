import type { SVGProps } from "react";
import { formatTone } from "@/lib/book-file-actions";
import styles from "./FileTypeIcon.module.css";

interface FileTypeIconProps extends SVGProps<SVGSVGElement> {
	/** "EPUB", "PDF", …: printed on the page's label. */
	format: string;
}

const labelSize = (format: string) =>
	format.length <= 3 ? 6 : format.length === 4 ? 5.2 : 4.4;

/**
 * A document icon the way Finder draws one: a page with a folded corner and
 * the format on a coloured label, one colour per family of formats.
 */
export const FileTypeIcon = ({ format, ...props }: FileTypeIconProps) => {
	const text = format.slice(0, 5).toUpperCase();
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="26"
			height="32"
			viewBox="0 0 26 32"
			aria-hidden="true"
			data-tone={formatTone(format)}
			className={styles.icon}
			{...props}
		>
			<path
				className={styles.paper}
				d="M3.5 1.5h13l7 7v20a2 2 0 0 1-2 2h-18a2 2 0 0 1-2-2v-25a2 2 0 0 1 2-2Z"
			/>
			<path className={styles.fold} d="M16.5 1.5v5a2 2 0 0 0 2 2h5" />
			<path className={styles.lines} d="M5.5 8.5h7M5.5 11.5h12" />
			<rect
				className={styles.label}
				x="3.5"
				y="17"
				width="19"
				height="8.5"
				rx="1.75"
			/>
			<text
				className={styles.text}
				x="13"
				y="21.25"
				textAnchor="middle"
				dominantBaseline="central"
				fontSize={labelSize(text)}
			>
				{text}
			</text>
		</svg>
	);
};
