import { type ReactEventHandler, useCallback, useState } from "react";
import { resolveCoverLoad } from "@/lib/cover-load";

interface CoverSize {
	width: number;
	height: number;
}

export const useCoverImage = (
	src: string | null | undefined,
	sizeHint: CoverSize | undefined,
	onImageError: ReactEventHandler<HTMLImageElement> | undefined,
) => {
	const [failed, setFailed] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [loadedSize, setLoadedSize] = useState<CoverSize>();
	const imageSrc = failed ? undefined : src || undefined;

	// Cached images (e.g. virtualized grid remounts) are already complete on
	// attach; mark them loaded synchronously so they don't flash a fade.
	const imageRef = useCallback((image: HTMLImageElement | null) => {
		if (image?.complete && image.naturalWidth > 0) {
			setLoaded(true);
		}
	}, []);

	const onError: ReactEventHandler<HTMLImageElement> = (event) => {
		setFailed(true);
		onImageError?.(event);
	};
	const onLoad: ReactEventHandler<HTMLImageElement> = (event) => {
		const image = event.currentTarget;
		if (resolveCoverLoad(image) === "failed") {
			onError(event);
		} else {
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
		size: imageSrc ? (sizeHint ?? loadedSize) : undefined,
		onLoad,
		onError,
	};
};
