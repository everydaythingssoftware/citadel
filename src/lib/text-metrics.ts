import { useEffect } from "react";

const ATTRIBUTE = "data-text-metrics";

/**
 * Switches the document between Citadel's own line heights and heading
 * weights and Apple's. `styles.css` defines the `--ctd-leading-*` and
 * `--ctd-emphasis-*` tokens only under this attribute; without it every rule
 * falls back to the value written beside the token.
 */
export const applyTextMetrics = (apple: boolean): void => {
	if (apple) {
		document.documentElement.setAttribute(ATTRIBUTE, "apple");
	} else {
		document.documentElement.removeAttribute(ATTRIBUTE);
	}
};

export const useApplyTextMetrics = (apple: boolean): void => {
	useEffect(() => {
		applyTextMetrics(apple);
	}, [apple]);
};
