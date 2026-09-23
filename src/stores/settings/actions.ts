import type {
	SmartShelf,
	SmartShelfFilter,
} from "@/lib/platform/settings/types";
import { useSettings } from "./store";

// Export store actions for convenient imports
export const setActiveLibrary = (libraryId: string): Promise<void> => {
	return useSettings.getState().setActiveLibrary(libraryId);
};

export const createLibrary = (absolutePath: string): Promise<string> => {
	return useSettings.getState().createLibrary(absolutePath);
};

export const renameLibrary = (
	id: string,
	displayName: string,
): Promise<void> => {
	return useSettings.getState().renameLibrary(id, displayName);
};

export const getActiveLibrary = () => {
	return useSettings.getState().getActiveLibrary();
};

export const setTheme = (theme: "dark" | "light" | "auto"): Promise<void> => {
	return useSettings.getState().setTheme(theme);
};

export const setStartFullscreen = (enabled: boolean): Promise<void> => {
	return useSettings.getState().setStartFullscreen(enabled);
};

export const createSmartShelf = (
	name: string,
	filter: SmartShelfFilter,
): Promise<SmartShelf> => {
	return useSettings.getState().createSmartShelf(name, filter);
};

export const renameSmartShelf = (id: string, name: string): Promise<void> => {
	return useSettings.getState().renameSmartShelf(id, name);
};

export const deleteSmartShelf = (id: string): Promise<void> => {
	return useSettings.getState().deleteSmartShelf(id);
};
