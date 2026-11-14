import { useEffect, useRef } from "react";
import { useKeymap } from "@/lib/hooks/use-keymap";
import type { KeyBinding } from "@/lib/keymap";
import {
	registerBookEditor,
	unregisterBookEditor,
} from "@/stores/book-editor/store";

interface BookEditorCommandsOptions {
	canUndo: boolean;
	undo: () => void;
	save: () => void;
}

/**
 * The book editor's keys: ⌘S (Ctrl+S) saves on every platform, never the
 * browser's Save Page. While it is open its Undo, which steps back its
 * saves, is what Edit > Undo and ⌘Z/Ctrl+Z run outside text fields
 * (`useMenuCommands`); text fields keep their own typing undo.
 */
export const useBookEditorCommands = ({
	canUndo,
	undo,
	save,
}: BookEditorCommandsOptions) => {
	const latest = useRef({ undo, save });
	latest.current = { undo, save };

	useEffect(() => {
		registerBookEditor({ canUndo, undo: () => latest.current.undo() });
	}, [canUndo]);
	useEffect(() => unregisterBookEditor, []);

	const bindings: KeyBinding[] = [
		{
			chord: "mod+s",
			allowInEditable: true,
			onMatch: () => latest.current.save(),
		},
	];
	useKeymap(bindings);
};
