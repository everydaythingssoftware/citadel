import * as Dialog from "@radix-ui/react-dialog";
import clsx from "clsx";
import {
	type CSSProperties,
	type HTMLAttributes,
	type ReactNode,
	useCallback,
} from "react";
import { PHONE_QUERY } from "@/lib/hooks/use-breakpoint";
import { useKeymap } from "@/lib/hooks/use-keymap";
import { usePrefersReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { useSwipeToClose } from "@/lib/hooks/use-swipe-to-close";
import { panelTakesEscape } from "@/lib/keymap";
import { DialogCloseButton } from "./DialogCloseButton";
import styles from "./Drawer.module.css";

export interface DrawerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: ReactNode;
	width: number;
	/**
	 * Drawers are opened programmatically (no Dialog.Trigger), so Radix has
	 * no trigger to return focus to on close. Callers should preventDefault
	 * here and refocus the control that opened the drawer.
	 */
	onCloseAutoFocus?: (event: Event) => void;
	/**
	 * Radix autofocuses the first focusable element — the close button.
	 * Callers can preventDefault here and focus a more useful default.
	 */
	onOpenAutoFocus?: (event: Event) => void;
	/** Positions the drawer within its page. */
	className?: string;
	/** A resize handle on the drawer's leading edge. */
	resizeHandleProps?: HTMLAttributes<HTMLDivElement>;
	contentRef?: (element: HTMLDivElement | null) => void;
}

const preventDefault = (event: Event) => event.preventDefault();

/** Layers that take an Escape before the drawer does. */
const ESCAPE_FIRST_SELECTOR =
	'[role="dialog"][data-state="open"]:not([data-drawer]), [role="alertdialog"], [role="menu"], [role="listbox"][data-state="open"]';

/**
 * A non-modal inspector at the right of the page that renders it (placed
 * with `className`), with no scrim: what it sits beside stays usable, and
 * a press outside never closes it. Escape (one press, wherever focus is;
 * see `panelTakesEscape`), the close button or the page (`open`) do. Its
 * content runs to its edges and under the close button. On a phone it is
 * a full-screen sheet that swipes closed toward its edge.
 */
export const Drawer = ({
	open,
	onOpenChange,
	children,
	width,
	onCloseAutoFocus,
	onOpenAutoFocus,
	className,
	resizeHandleProps,
	contentRef,
}: DrawerProps) => {
	const swipe = useSwipeToClose({
		edge: "right",
		enabled: open,
		onClose: () => onOpenChange(false),
		reducedMotion: usePrefersReducedMotion(),
		media: PHONE_QUERY,
	});
	const { panelRef } = swipe;
	const ref = useCallback(
		(element: HTMLDivElement | null) => {
			panelRef(element);
			contentRef?.(element);
		},
		[panelRef, contentRef],
	);
	// Window capture: read before anything handles the key, so a tooltip
	// that happens to be showing can't spend the press the way Radix's
	// layer stack let it, and one press closes the drawer without also
	// clearing the grid's selection behind it.
	useKeymap(
		open
			? [
					{
						chord: "escape",
						allowInEditable: true,
						when: (event) =>
							panelTakesEscape(
								event.target,
								document.querySelector(ESCAPE_FIRST_SELECTOR) !== null,
							),
						onMatch: () => onOpenChange(false),
					},
				]
			: [],
		{ capture: true },
	);

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange} modal={false}>
			<Dialog.Content
				ref={ref}
				className={clsx(styles.content, className)}
				data-drawer=""
				style={{ "--drawer-width": `${width}px` } as CSSProperties}
				aria-describedby={undefined}
				onCloseAutoFocus={onCloseAutoFocus}
				onOpenAutoFocus={onOpenAutoFocus}
				// A press on another cover switches the book; the page decides
				// when a press outside closes the drawer.
				onInteractOutside={preventDefault}
				// Escape is the keymap's above, not Radix's layer stack.
				onEscapeKeyDown={preventDefault}
			>
				{resizeHandleProps && (
					<div className={styles.resizer} {...resizeHandleProps} />
				)}
				<div className={styles.header}>
					{/* Radix requires a Title for screen readers. */}
					<Dialog.Title className={styles.hiddenTitle}>Details</Dialog.Title>
					<Dialog.Close asChild>
						<DialogCloseButton />
					</Dialog.Close>
				</div>
				<div className={styles.body}>{children}</div>
			</Dialog.Content>
		</Dialog.Root>
	);
};
