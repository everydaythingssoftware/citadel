import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/** Tracks `prefers-reduced-motion: reduce`, live. */
export const usePrefersReducedMotion = (): boolean => {
	const [reduced, setReduced] = useState(
		() => typeof matchMedia !== "undefined" && matchMedia(QUERY).matches,
	);

	useEffect(() => {
		const mq = matchMedia(QUERY);
		const onChange = () => setReduced(mq.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

	return reduced;
};
