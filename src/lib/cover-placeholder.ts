import type { CSSProperties } from "react";
import type { CoverColors } from "@/bindings";
import { thumbHashToDataURL } from "@/lib/thumbhash";

/**
 * What a grid cover paints behind its image until the image arrives: the
 * cover's ThumbHash, else a flat wash of its main colour, else nothing (the
 * cell keeps its usual look).
 */
export const coverPlaceholder = (
	colors: CoverColors | null | undefined,
): CSSProperties | undefined => {
	if (colors?.thumbhash) {
		try {
			return {
				backgroundImage: `url("${thumbHashToDataURL(colors.thumbhash)}")`,
				backgroundSize: "100% 100%",
			};
		} catch {
			// Not a hash we can read; fall back to the colour.
		}
	}
	const dominant = colors?.palette?.dominant;
	if (!dominant) return undefined;
	return {
		backgroundColor: `oklab(${(dominant.l * 100).toFixed(1)}% ${dominant.a.toFixed(3)} ${dominant.b.toFixed(3)})`,
	};
};
