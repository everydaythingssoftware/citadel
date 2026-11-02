import { useCallback } from "react";
import { usePlatform } from "@/lib/platform/context";
import { BOOK_EXTENSIONS } from "@/lib/uploads/queue";
import { useUploadsStore } from "@/stores/uploads/store";

/** Opens the file chooser and queues the chosen books. Call from a click. */
export const useChooseBookFiles = (): (() => void) => {
	const platform = usePlatform();
	const addFiles = useUploadsStore((state) => state.addFiles);
	return useCallback(() => {
		void platform.dialogs
			.chooseFiles({ extensions: BOOK_EXTENSIONS, multiple: true })
			.then(addFiles);
	}, [platform, addFiles]);
};
