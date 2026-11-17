import { useEffect, useState } from "react";

export const useWindowWidth = (): number => {
	const [width, setWidth] = useState(() => window.innerWidth);
	useEffect(() => {
		const update = () => setWidth(window.innerWidth);
		window.addEventListener("resize", update);
		return () => window.removeEventListener("resize", update);
	}, []);
	return width;
};
