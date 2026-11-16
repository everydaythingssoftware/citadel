import * as RadixAlertDialog from "@radix-ui/react-alert-dialog";
import { type ReactNode, useRef } from "react";
import { isDefaultButtonKey } from "@/lib/default-button";
import styles from "./AlertDialog.module.css";
import { Button } from "./Button";

export interface AlertDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The question, in title case, e.g. "Delete “Middlemarch”?" */
	title: ReactNode;
	/** Smaller informative text below the title: what is and isn't affected. */
	description?: string;
	textAlign?: "left" | "center";
	confirmLabel: string;
	cancelLabel?: string;
	/**
	 * A destructive confirmation: the confirm button is red text and Cancel is
	 * the default button, so Return never destroys anything.
	 */
	destructive?: boolean;
	onConfirm: () => void;
}

/**
 * An NSAlert: centered, narrow, message on top and a button pair below with
 * the default button on the right. The default button is filled and answers
 * Return wherever focus is; Escape is Cancel.
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
}: AlertDialogProps) => {
	const defaultButtonRef = useRef<HTMLButtonElement>(null);

	const cancel = (
		<RadixAlertDialog.Cancel asChild>
			<Button
				ref={destructive ? defaultButtonRef : undefined}
				fullWidth
				variant={destructive ? "primary" : "default"}
				data-default-button={destructive || undefined}
			>
				{cancelLabel}
			</Button>
		</RadixAlertDialog.Cancel>
	);
	const confirm = (
		<RadixAlertDialog.Action asChild>
			<Button
				ref={destructive ? undefined : defaultButtonRef}
				fullWidth
				variant={destructive ? "danger" : "primary"}
				data-default-button={!destructive || undefined}
				onClick={onConfirm}
			>
				{confirmLabel}
			</Button>
		</RadixAlertDialog.Action>
	);

	return (
		<RadixAlertDialog.Root open={open} onOpenChange={onOpenChange}>
			<RadixAlertDialog.Portal>
				<RadixAlertDialog.Overlay className={styles.overlay} />
				<RadixAlertDialog.Content
					className={styles.content}
					data-text-align={textAlign}
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						defaultButtonRef.current?.focus();
					}}
					onKeyDown={(event) => {
						if (!isDefaultButtonKey(event)) return;
						event.preventDefault();
						defaultButtonRef.current?.click();
					}}
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
						{destructive ? confirm : cancel}
						{destructive ? cancel : confirm}
					</div>
				</RadixAlertDialog.Content>
			</RadixAlertDialog.Portal>
		</RadixAlertDialog.Root>
	);
};
