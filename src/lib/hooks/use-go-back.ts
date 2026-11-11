import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

/**
 * Returns to the page this one was opened from, as the system Back gesture
 * would, so that page comes back as it was left (scroll included). With no
 * in-app page behind this one — a direct link or a reload — it opens the
 * library instead, replacing this entry so Back doesn't return to it.
 */
export const useGoBack = (): (() => void) => {
	const router = useRouter();
	const canGoBack = useCanGoBack();
	const navigate = useNavigate();

	return useCallback(() => {
		if (canGoBack) {
			router.history.back();
			return;
		}
		void navigate({ to: "/", replace: true });
	}, [canGoBack, router, navigate]);
};
