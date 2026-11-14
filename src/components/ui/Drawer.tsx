import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { usePrefersReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { useSwipeToClose } from "@/lib/hooks/use-swipe-to-close";
import { DialogCloseButton } from "./DialogCloseButton";
import styles from "./Drawer.module.css";
import { ignorePopoverInteractOutside } from "./popover-interop";

export interface DrawerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title?: string;
	children: ReactNode;
	width?: number;
	/**
	 * Drawers are usually opened programmatically (no Dialog.Trigger), so Radix
	 * has no trigger to return focus to on close. Callers should preventDefault
	 * here and refocus the control that opened the drawer.
	 */
	onCloseAutoFocus?: (event: Event) => void;
	/**
	 * Radix autofocuses the first focusable element — the header close button.
	 * Callers can preventDefault here and focus a more useful default.
	 */
	onOpenAutoFocus?: (event: Event) => void;
	/**
	 * Content runs to the drawer's edges and under the close button, for a
	 * header with its own background; the content sets its own padding.
	 */
	bleed?: boolean;
}

/**
 * A right-edge slide-over panel, e.g. for book details. On touch screens it
 * can be swiped closed toward its edge.
 */
export const Drawer = ({
	open,
	onOpenChange,
	title,
	children,
	width = 420,
	onCloseAutoFocus,
	onOpenAutoFocus,
	bleed = false,
}: DrawerProps) => {
	const swipe = useSwipeToClose({
		edge: "right",
		enabled: open,
		onClose: () => onOpenChange(false),
		reducedMotion: usePrefersReducedMotion(),
	});

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay ref={swipe.scrimRef} className={styles.overlay} />
				{/* No Dialog.Description; aria-describedby={undefined} silences the Radix warning. */}
				<Dialog.Content
					ref={swipe.panelRef}
					className={styles.content}
					data-bleed={bleed || undefined}
					style={{ width: `min(${width}px, calc(100vw - 32px))` }}
					aria-describedby={undefined}
					onCloseAutoFocus={onCloseAutoFocus}
					onOpenAutoFocus={onOpenAutoFocus}
					onPointerDownOutside={ignorePopoverInteractOutside}
					onInteractOutside={ignorePopoverInteractOutside}
				>
					<div className={styles.header}>
						{title ? (
							<Dialog.Title className={styles.title}>{title}</Dialog.Title>
						) : (
							// Radix requires a Title for screen readers even when the
							// drawer has no visible heading.
							<Dialog.Title className={styles.hiddenTitle}>
								Details
							</Dialog.Title>
						)}
						<Dialog.Close asChild>
							<DialogCloseButton />
						</Dialog.Close>
					</div>
					<div className={styles.body}>{children}</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
};
