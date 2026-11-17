import { AddLibraryDialog } from "@/components/organisms/AddLibraryDialog";
import { useMenuBarSync } from "@/lib/hooks/use-menu-bar-sync";
import { useMenuCommands } from "@/lib/hooks/use-menu-commands";

/**
 * Runs the menu bar's commands and the app-wide shortcuts for the library
 * window, keeps the menu bar in step with it, and shows the one dialog
 * they open that no page owns.
 */
export const MenuCommandHost = () => {
	useMenuBarSync();
	const { addLibrary } = useMenuCommands();
	return <AddLibraryDialog step={addLibrary.step} send={addLibrary.send} />;
};
