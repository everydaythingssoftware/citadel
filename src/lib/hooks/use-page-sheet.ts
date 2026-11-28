import { useEffect } from "react";

/**
 * On a phone an open sheet is the page: the app behind it is hidden and the
 * document scrolls the sheet, so Safari can tuck its toolbar away, keep a
 * focused field in view and keep sticky bars above its own. Returns to the
 * app's fixed layout as the sheet closes.
 */
export const usePageSheet = (active: boolean, page: boolean) => {
	useEffect(() => {
		if (!active || !page) return;
		const root = document.documentElement;
		root.dataset.pageSheet = "";
		return () => {
			delete root.dataset.pageSheet;
			window.scrollTo(0, 0);
		};
	}, [active, page]);
};
