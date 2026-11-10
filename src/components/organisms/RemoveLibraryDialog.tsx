import { useRef } from "react";
import { AlertDialog, NoBreak } from "@/components/ui";
import type { RemoveLibrary } from "@/lib/hooks/use-remove-library";

interface RemoveLibraryDialogProps {
	remove: RemoveLibrary;
}

/** "Forget…": says that forgetting leaves the library's files alone. */
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
					? "Citadel will return to the welcome screen. Your files will not be removed."
					: "Your files will not be removed."
			}
			confirmLabel="Forget"
			onConfirm={remove.confirm}
		/>
	);
};
