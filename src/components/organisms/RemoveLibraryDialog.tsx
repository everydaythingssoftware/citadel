import { useRef } from "react";
import { AlertDialog, NoBreak } from "@/components/ui";
import type { RemoveLibrary } from "@/lib/hooks/use-remove-library";

interface RemoveLibraryDialogProps {
	remove: RemoveLibrary;
}

/** "Forget…": says what forgetting does, and that the books stay put. */
export const RemoveLibraryDialog = ({ remove }: RemoveLibraryDialogProps) => {
	const { step } = remove;
	// Kept through the closing animation, so the text never empties.
	const shown = useRef({ name: "", isLast: false });
	if (step.id === "confirm") {
		shown.current = { name: step.library.displayName, isLast: step.isLast };
	}
	const { name, isLast } = shown.current;

	return (
		<AlertDialog
			open={step.id === "confirm"}
			onOpenChange={(open) => {
				if (!open) remove.cancel();
			}}
			title={
				<>
					Forget <NoBreak>“{name}”</NoBreak>?
				</>
			}
			description={
				isLast
					? "Citadel will stop showing this library and return to the welcome screen. Your books stay where they are."
					: "Citadel will stop showing this library. Your books stay where they are."
			}
			confirmLabel="Forget"
			onConfirm={remove.confirm}
		/>
	);
};
