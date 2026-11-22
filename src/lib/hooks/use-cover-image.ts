import { type ReactEventHandler, useState } from "react";
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
	const [loadedSize, setLoadedSize] = useState<CoverSize>();
	const imageSrc = failed ? undefined : src || undefined;

	const onError: ReactEventHandler<HTMLImageElement> = (event) => {
		setFailed(true);
		onImageError?.(event);
	};
	const onLoad: ReactEventHandler<HTMLImageElement> = (event) => {
		const image = event.currentTarget;
		if (resolveCoverLoad(image) === "failed") {
			onError(event);
		} else if (!sizeHint) {
			setLoadedSize({ width: image.naturalWidth, height: image.naturalHeight });
		}
	};

	return {
		imageSrc,
		size: imageSrc ? (sizeHint ?? loadedSize) : undefined,
		onLoad,
		onError,
	};
};
