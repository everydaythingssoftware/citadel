import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { DialogCloseButton } from "./DialogCloseButton";
import { ignorePopoverInteractOutside } from "./popover-interop";
import styles from "./Sheet.module.css";

export interface SheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	children: ReactNode;
	width?: number;
	/**
	 * False when closing would lose something for good: Escape, clicks outside
	 * and the close button all stop working, so the content must offer its own
	 * way out.
	 */
	dismissible?: boolean;
	/** Lets the content choose where focus starts; preventDefault to take over. */
	onOpenAutoFocus?: (event: Event) => void;
	/**
	 * Sheets are usually opened programmatically (no Dialog.Trigger), so Radix
	 * has no trigger to return focus to on close. Callers should preventDefault
	 * here and refocus the control that opened the sheet.
	 */
	onCloseAutoFocus?: (event: Event) => void;
}

const preventClosing = (event: Event) => event.preventDefault();

/** A macOS document sheet: detached below the toolbar, dimming the window. */
export const Sheet = ({
	open,
	onOpenChange,
	title,
	children,
	width = 540,
	dismissible = true,
	onOpenAutoFocus,
	onCloseAutoFocus,
}: SheetProps) => (
	<Dialog.Root open={open} onOpenChange={onOpenChange}>
		<Dialog.Portal>
			<Dialog.Overlay className={styles.overlay} />
			{/* No Dialog.Description; aria-describedby={undefined} silences the Radix warning. */}
			<Dialog.Content
				className={styles.content}
				style={{ width: `min(${width}px, calc(100vw - 32px))` }}
				aria-describedby={undefined}
				onOpenAutoFocus={onOpenAutoFocus}
				onCloseAutoFocus={onCloseAutoFocus}
				onEscapeKeyDown={dismissible ? undefined : preventClosing}
				onPointerDownOutside={
					dismissible ? ignorePopoverInteractOutside : preventClosing
				}
				onInteractOutside={
					dismissible ? ignorePopoverInteractOutside : preventClosing
				}
			>
				<div className={styles.header}>
					<Dialog.Title className={styles.title}>{title}</Dialog.Title>
					{dismissible && (
						<Dialog.Close asChild>
							<DialogCloseButton />
						</Dialog.Close>
					)}
				</div>
				<div className={styles.body}>{children}</div>
			</Dialog.Content>
		</Dialog.Portal>
	</Dialog.Root>
);
