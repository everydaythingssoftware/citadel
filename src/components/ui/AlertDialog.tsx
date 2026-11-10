import * as RadixAlertDialog from "@radix-ui/react-alert-dialog";
import type { ReactNode } from "react";
import styles from "./AlertDialog.module.css";
import { Button } from "./Button";

export interface AlertDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Bold one-line question, e.g. "Delete author?" */
	title: ReactNode;
	/** Smaller informative text below the title. */
	description?: string;
	textAlign?: "left" | "center";
	confirmLabel: string;
	cancelLabel?: string;
	/** Style the confirm button as destructive (red). */
	destructive?: boolean;
	onConfirm: () => void;
}

/**
 * An NSAlert-style confirmation: centered, narrow, message on top and a
 * cancel / confirm button pair below. Confirm sits on the right.
 */
export const AlertDialog = ({
	open,
	onOpenChange,
	title,
	description,
	textAlign = "center",
	confirmLabel,
	cancelLabel = "Cancel",
	destructive = false,
	onConfirm,
}: AlertDialogProps) => (
	<RadixAlertDialog.Root open={open} onOpenChange={onOpenChange}>
		<RadixAlertDialog.Portal>
			<RadixAlertDialog.Overlay className={styles.overlay} />
			<RadixAlertDialog.Content
				className={styles.content}
				data-text-align={textAlign}
			>
				<RadixAlertDialog.Title className={styles.title}>
					{title}
				</RadixAlertDialog.Title>
				{description ? (
					<RadixAlertDialog.Description className={styles.description}>
						{description}
					</RadixAlertDialog.Description>
				) : null}
				<div className={styles.buttons}>
					<RadixAlertDialog.Cancel asChild>
						<Button fullWidth>{cancelLabel}</Button>
					</RadixAlertDialog.Cancel>
					<RadixAlertDialog.Action asChild>
						<Button
							fullWidth
							variant={destructive ? "danger" : "primary"}
							onClick={onConfirm}
						>
							{confirmLabel}
						</Button>
					</RadixAlertDialog.Action>
				</div>
			</RadixAlertDialog.Content>
		</RadixAlertDialog.Portal>
	</RadixAlertDialog.Root>
);
