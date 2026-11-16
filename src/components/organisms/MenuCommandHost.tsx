import { AddLibraryDialog } from "@/components/organisms/AddLibraryDialog";
import { useMenuCommands } from "@/lib/hooks/use-menu-commands";

/**
 * Runs the menu bar's commands and the app-wide shortcuts for the library
 * window, and shows the one dialog they open that no page owns.
 */
export const MenuCommandHost = () => {
	const { addLibrary } = useMenuCommands();
	return <AddLibraryDialog step={addLibrary.step} send={addLibrary.send} />;
};
