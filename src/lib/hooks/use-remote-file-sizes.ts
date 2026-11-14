import { useEffect, useState } from "react";
import { fetchContentLength } from "@/lib/download";

const sizes = new Map<string, Promise<number | null>>();

const sizeOf = (url: string): Promise<number | null> => {
	const cached = sizes.get(url);
	if (cached) return cached;
	const lookup = fetchContentLength(url);
	sizes.set(url, lookup);
	return lookup;
};

/** Each remote file's size in bytes, asked once per URL with HEAD. */
export const useRemoteFileSizes = (
	urls: string[],
): Record<string, number | null> => {
	const [known, setKnown] = useState<Record<string, number | null>>({});
	const key = urls.join("\n");

	useEffect(() => {
		let live = true;
		const wanted = key.length > 0 ? key.split("\n") : [];
		for (const url of wanted) {
			void sizeOf(url).then((size) => {
				if (live)
					setKnown((previous) =>
						previous[url] === size ? previous : { ...previous, [url]: size },
					);
			});
		}
		return () => {
			live = false;
		};
	}, [key]);

	return known;
};
