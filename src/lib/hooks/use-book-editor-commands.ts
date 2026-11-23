import { useEffect } from "react";
import { useKeymap } from "@/lib/hooks/use-keymap";
import { none, type Option, some } from "@/lib/option";
import { EDITOR_SAVE_CHORD } from "@/lib/shortcut-list";
import { useBookEditor } from "@/stores/book-editor/store";

/**
 * The book editor's keys: ⌘S (Ctrl+S) saves on every platform, never the
 * browser's Save Page. While it is open its Undo is what Edit > Undo and
 * ⌘Z/Ctrl+Z run outside text fields (`useMenuCommands`).
 */
export const useBookEditorCommands = (
	undo: Option<() => void>,
	save: () => void,
) => {
	useEffect(() => {
		useBookEditor.setState({ editor: some({ undo }) });
		return () => useBookEditor.setState({ editor: none() });
	}, [undo]);
	useKeymap([
		{ chord: EDITOR_SAVE_CHORD, allowInEditable: true, onMatch: save },
	]);
};
