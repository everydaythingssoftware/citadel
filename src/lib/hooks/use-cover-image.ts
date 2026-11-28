import { type ReactEventHandler, useCallback, useState } from "react";
import { resolveCoverLoad } from "@/lib/cover-load";

interface CoverSize {
	width: number;
	height: number;
}

/**
 * URLs that have already decoded in this session. Thumbnail URLs carry their
 * cover mtime/version, so a URL we have loaded once is already in the image
 * cache and does not need a ThumbHash placeholder or fade on remount.
 */
const loadedCoverUrls = new Set<string>();
/** Their sizes, so a remounted cover takes its shape at once, not on load. */
const loadedCoverSizes = new Map<string, CoverSize>();

/** Covers fetched ahead of being shown, kept so the browser keeps them. */
const preloaded = new Map<string, HTMLImageElement>();
const PRELOAD_LIMIT = 200;

/**
 * Loads a cover before anything shows it, so it appears at once, at its own
 * size, when something does: the books a review may show next, say.
 */
export const preloadCover = (src: string | null | undefined) => {
	if (!src || preloaded.has(src) || loadedCoverUrls.has(src)) return;
	const image = new Image();
	image.decoding = "async";
	image.onload = () => {
		if (resolveCoverLoad(image) === "failed") return;
		loadedCoverUrls.add(src);
		loadedCoverSizes.set(src, {
			width: image.naturalWidth,
			height: image.naturalHeight,
		});
	};
	image.src = src;
	preloaded.set(src, image);
	// The oldest go first; they've long since been shown or passed by.
	for (const old of preloaded.keys()) {
		if (preloaded.size <= PRELOAD_LIMIT) break;
		preloaded.delete(old);
	}
};

export const useCoverImage = (
	src: string | null | undefined,
	sizeHint: CoverSize | undefined,
	onImageError: ReactEventHandler<HTMLImageElement> | undefined,
) => {
	const [failed, setFailed] = useState(false);
	const [wasCached] = useState(() => Boolean(src && loadedCoverUrls.has(src)));
	const [loaded, setLoaded] = useState(wasCached);
	const [loadedSize, setLoadedSize] = useState<CoverSize | undefined>(() =>
		src ? loadedCoverSizes.get(src) : undefined,
	);
	const imageSrc = failed ? undefined : src || undefined;

	// Cached images not yet recorded in this session (e.g. from browser cache)
	// are already complete on attach; mark them loaded synchronously so they
	// don't flash a fade.
	const imageRef = useCallback(
		(image: HTMLImageElement | null) => {
			if (image?.complete && image.naturalWidth > 0) {
				if (imageSrc) loadedCoverUrls.add(imageSrc);
				setLoaded(true);
			}
		},
		[imageSrc],
	);

	const onError: ReactEventHandler<HTMLImageElement> = (event) => {
		if (imageSrc) loadedCoverUrls.delete(imageSrc);
		setFailed(true);
		onImageError?.(event);
	};
	const onLoad: ReactEventHandler<HTMLImageElement> = (event) => {
		const image = event.currentTarget;
		if (resolveCoverLoad(image) === "failed") {
			onError(event);
		} else {
			if (imageSrc) loadedCoverUrls.add(imageSrc);
			setLoaded(true);
			if (!sizeHint) {
				const natural = {
					width: image.naturalWidth,
					height: image.naturalHeight,
				};
				if (imageSrc) loadedCoverSizes.set(imageSrc, natural);
				setLoadedSize(natural);
			}
		}
	};

	return {
		imageSrc,
		imageRef,
		loaded,
		wasCached,
		size: imageSrc ? (sizeHint ?? loadedSize) : undefined,
		onLoad,
		onError,
	};
};
