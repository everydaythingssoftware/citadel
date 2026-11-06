import { useEffect, useState } from "react";
import { type CoverPalette, extractCoverPalette } from "@/lib/cover-palette";

const SAMPLE_SIZE = 48;
const cache = new Map<string, CoverPalette | null>();

const readPalette = (url: string): Promise<CoverPalette | null> =>
	new Promise((resolve) => {
		const image = new Image();
		image.crossOrigin = "anonymous";
		image.decoding = "async";
		image.onload = () => {
			try {
				const canvas = document.createElement("canvas");
				canvas.width = SAMPLE_SIZE;
				canvas.height = SAMPLE_SIZE;
				const context = canvas.getContext("2d", { willReadFrequently: true });
				if (!context) return resolve(null);
				context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
				const { data } = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
				resolve(extractCoverPalette(data));
			} catch {
				// A cover served without CORS taints the canvas; go without colour.
				resolve(null);
			}
		};
		image.onerror = () => resolve(null);
		image.src = url;
	});

/** The cover's colours, or null while loading and when it has none. */
export const useCoverPalette = (url: string | null): CoverPalette | null => {
	const [palette, setPalette] = useState<CoverPalette | null>(() =>
		url === null ? null : (cache.get(url) ?? null),
	);
	useEffect(() => {
		if (url === null) {
			setPalette(null);
			return;
		}
		if (cache.has(url)) {
			setPalette(cache.get(url) ?? null);
			return;
		}
		let current = true;
		setPalette(null);
		void readPalette(url).then((result) => {
			cache.set(url, result);
			if (current) setPalette(result);
		});
		return () => {
			current = false;
		};
	}, [url]);
	return palette;
};
