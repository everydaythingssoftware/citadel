import { usePlatform } from "@/lib/platform/context";

export const CITADEL_HELP_URL =
	"https://github.com/everydaythingssoftware/citadel#readme";

export const useAppHelp = () => {
	const platform = usePlatform();
	return () => {
		void platform.fileOpener
			.openPath(CITADEL_HELP_URL)
			.catch((error: unknown) => console.error("Citadel Help:", error));
	};
};
