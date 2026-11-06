import { useCallback, useEffect, useRef, useState } from "react";
import { usePlatform } from "@/lib/platform/context";

const COPIED_MS = 1600;

export interface CopyText {
	/** True for a moment after a copy succeeds. */
	copied: boolean;
	copy: (text: string) => void;
}

/** Copies text with the platform's clipboard and says so briefly. */
export const useCopyText = (): CopyText => {
	const platform = usePlatform();
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | null>(null);

	useEffect(
		() => () => {
			if (timer.current !== null) window.clearTimeout(timer.current);
		},
		[],
	);

	const copy = useCallback(
		(text: string) => {
			void platform.clipboard
				.writeText(text)
				.then(() => {
					setCopied(true);
					if (timer.current !== null) window.clearTimeout(timer.current);
					timer.current = window.setTimeout(() => {
						timer.current = null;
						setCopied(false);
					}, COPIED_MS);
				})
				.catch((error: unknown) => console.error("Copy:", error));
		},
		[platform],
	);

	return { copied, copy };
};
