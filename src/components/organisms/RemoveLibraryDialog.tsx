import { useRef } from "react";
import { AlertDialog, NoBreak } from "@/components/ui";
import type { RemoveLibrary } from "@/lib/hooks/use-remove-library";

interface RemoveLibraryDialogProps {
	remove: RemoveLibrary;
}

/** Confirms removing the last library, the one removal Undo can't follow. */
export const RemoveLibraryDialog = ({ remove }: RemoveLibraryDialogProps) => {
	const { step } = remove;
	// Kept through the closing animation, so the title never empties.
	const shownName = useRef("");
	if (step.id !== "idle") shownName.current = step.library.displayName;
	const name = shownName.current;

	return (
		<AlertDialog
			open={step.id === "confirm"}
			onOpenChange={(open) => {
				if (!open) remove.cancel();
			}}
			title={
				<>
					Remove <NoBreak>“{name}”</NoBreak> from Citadel?
				</>
			}
			description={
				step.id === "confirm" && step.error !== null
					? step.error
					: "It’s your only library. Your books will not be removed: you can re-add your library anytime."
			}
			confirmLabel={step.id === "confirm" && step.busy ? "Removing…" : "Remove"}
			onConfirm={remove.confirm}
		/>
	);
};
