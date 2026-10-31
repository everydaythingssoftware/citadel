import { useEffect, useState } from "react";

/** Whether a media query matches, live. */
export const useMediaQuery = (query: string): boolean => {
	const [matches, setMatches] = useState(
		() => typeof matchMedia !== "undefined" && matchMedia(query).matches,
	);
	useEffect(() => {
		const list = matchMedia(query);
		const onChange = () => setMatches(list.matches);
		onChange();
		list.addEventListener("change", onChange);
		return () => list.removeEventListener("change", onChange);
	}, [query]);
	return matches;
};
