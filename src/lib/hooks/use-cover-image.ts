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

export const useCoverImage = (
	src: string | null | undefined,
	sizeHint: CoverSize | undefined,
	onImageError: ReactEventHandler<HTMLImageElement> | undefined,
) => {
	const [failed, setFailed] = useState(false);
	const [wasCached] = useState(() => Boolean(src && loadedCoverUrls.has(src)));
	const [loaded, setLoaded] = useState(wasCached);
	const [loadedSize, setLoadedSize] = useState<CoverSize>();
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
				setLoadedSize({
					width: image.naturalWidth,
					height: image.naturalHeight,
				});
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
