import { create } from "zustand";

interface BookEditorState {
	/** The book editor is on screen. */
	open: boolean;
	/** It has a saved change, or unsaved edits, that Undo can take back. */
	canUndo: boolean;
	undo: () => void;
}

const idle: BookEditorState = { open: false, canUndo: false, undo: () => {} };

/**
 * The open book editor's Undo, so the menu bar's Edit > Undo can reach it
 * outside text fields (fields keep their own typing undo).
 */
export const useBookEditor = create<BookEditorState>(() => idle);

export const registerBookEditor = (state: Omit<BookEditorState, "open">) =>
	useBookEditor.setState({ open: true, ...state });

export const unregisterBookEditor = () => useBookEditor.setState(idle);
