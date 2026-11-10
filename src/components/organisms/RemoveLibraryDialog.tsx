import { useRef } from "react";
import { AlertDialog, NoBreak } from "@/components/ui";
import type { RemoveLibrary } from "@/lib/hooks/use-remove-library";
import { usePlatform } from "@/lib/platform/context";

interface RemoveLibraryDialogProps {
	remove: RemoveLibrary;
}

/** Confirms "Remove from Citadel…", then offers the folder it left behind. */
export const RemoveLibraryDialog = ({ remove }: RemoveLibraryDialogProps) => {
	const { fileManagerName } = usePlatform().fileOpener;
	const { step } = remove;
	// Kept through the closing animation, so the title never empties.
	const shownName = useRef("");
	if (step.id !== "idle") shownName.current = step.library.displayName;
	const name = shownName.current;

	return (
		<>
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
						: "Your books will not be removed: you can re-add your library anytime."
				}
				confirmLabel={
					step.id === "confirm" && step.busy ? "Removing…" : "Remove"
				}
				onConfirm={remove.confirm}
			/>
			<AlertDialog
				open={step.id === "removed"}
				onOpenChange={(open) => {
					if (!open) remove.done();
				}}
				title={
					<>
						Removed <NoBreak>“{name}”</NoBreak>
					</>
				}
				description="Its folder is still on disk, if you’d like to delete it."
				cancelLabel="Done"
				confirmLabel={`Show in ${fileManagerName}`}
				onConfirm={remove.showFolder}
			/>
		</>
	);
};
