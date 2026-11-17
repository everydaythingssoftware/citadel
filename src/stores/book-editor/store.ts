import { create } from "zustand";
import { none, type Option } from "@/lib/option";

export interface OpenBookEditor {
	/** Takes back unsaved edits, then saves; absent with nothing to undo. */
	undo: Option<() => void>;
}

/**
 * The book editor while it is open, so Edit > Undo can reach its Undo
 * outside text fields (fields keep their own typing undo).
 */
export const useBookEditor = create<{ editor: Option<OpenBookEditor> }>(() => ({
	editor: none(),
}));
