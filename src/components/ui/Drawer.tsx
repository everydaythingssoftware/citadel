import * as Dialog from "@radix-ui/react-dialog";
import clsx from "clsx";
import {
	type CSSProperties,
	type HTMLAttributes,
	type ReactNode,
	type Ref,
	useCallback,
} from "react";
import { usePrefersReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { useSwipeToClose } from "@/lib/hooks/use-swipe-to-close";
import { DialogCloseButton } from "./DialogCloseButton";
import styles from "./Drawer.module.css";
import { ignorePopoverInteractOutside } from "./popover-interop";

export const DrawerPlacement = {
	/** Modal, over the whole window, behind a scrim. */
	window: "window",
	/**
	 * A non-modal inspector inside the page that renders it (placed with
	 * `className`), with no scrim: what it sits beside stays usable, and a
	 * press outside never closes it. Escape, the close button or the page
	 * (`open`) do.
	 */
	panel: "panel",
} as const;

export type DrawerPlacement =
	(typeof DrawerPlacement)[keyof typeof DrawerPlacement];

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
	placement?: DrawerPlacement;
	/** Panel placement: positions the drawer within its page. */
	className?: string;
	/** Panel placement: a resize handle on the drawer's leading edge. */
	resizeHandleProps?: HTMLAttributes<HTMLDivElement>;
	contentRef?: Ref<HTMLDivElement>;
}

const preventDefault = (event: Event) => event.preventDefault();

/**
 * Where the panel placement becomes a full-screen sheet; mirrors the phone
 * query in Drawer.module.css.
 */
const PHONE_SHEET_QUERY = "(max-width: 36em)";

/** Hands one element to the caller's ref and the swipe's. */
const useBothRefs = (
	outer: Ref<HTMLDivElement> | undefined,
	inner: (element: HTMLElement | null) => void,
) =>
	useCallback(
		(element: HTMLDivElement | null) => {
			inner(element);
			if (typeof outer === "function") outer(element);
			else if (outer) outer.current = element;
		},
		[outer, inner],
	);

/**
 * A right-edge slide-over panel, e.g. for book details. On touch screens it
 * can be swiped closed toward its edge: the window drawer always, the panel
 * placement while it is a phone's full-screen sheet.
 */
export const Drawer = ({
	placement = DrawerPlacement.window,
	...props
}: DrawerProps) =>
	placement === DrawerPlacement.panel ? (
		<PanelDrawer {...props} />
	) : (
		<WindowDrawer {...props} />
	);

const WindowDrawer = ({
	open,
	onOpenChange,
	title,
	children,
	width = 420,
	onCloseAutoFocus,
	onOpenAutoFocus,
	bleed = false,
	contentRef,
}: DrawerProps) => {
	const swipe = useSwipeToClose({
		edge: "right",
		enabled: open,
		onClose: () => onOpenChange(false),
		reducedMotion: usePrefersReducedMotion(),
	});
	const ref = useBothRefs(contentRef, swipe.panelRef);

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay ref={swipe.scrimRef} className={styles.overlay} />
				{/* No Dialog.Description; aria-describedby={undefined} silences the Radix warning. */}
				<Dialog.Content
					ref={ref}
					className={clsx(styles.content, styles.window)}
					data-drawer=""
					data-bleed={bleed || undefined}
					style={{ width: `min(${width}px, calc(100vw - 32px))` }}
					aria-describedby={undefined}
					onCloseAutoFocus={onCloseAutoFocus}
					onOpenAutoFocus={onOpenAutoFocus}
					onPointerDownOutside={ignorePopoverInteractOutside}
					onInteractOutside={ignorePopoverInteractOutside}
				>
					<DrawerHeader title={title} />
					<div className={clsx(styles.body, "ctd-scroller")}>{children}</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
};

const PanelDrawer = ({
	open,
	onOpenChange,
	title,
	children,
	width = 420,
	onCloseAutoFocus,
	onOpenAutoFocus,
	bleed = false,
	className,
	resizeHandleProps,
	contentRef,
}: DrawerProps) => {
	// Beside the grid the panel stays put (its leading edge resizes it); as
	// a phone's full-screen sheet it swipes closed from its inner edge.
	const swipe = useSwipeToClose({
		edge: "right",
		enabled: open,
		onClose: () => onOpenChange(false),
		reducedMotion: usePrefersReducedMotion(),
		media: PHONE_SHEET_QUERY,
	});
	const ref = useBothRefs(contentRef, swipe.panelRef);

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange} modal={false}>
			<Dialog.Content
				ref={ref}
				className={clsx(styles.content, styles.panel, className)}
				data-drawer=""
				data-bleed={bleed || undefined}
				style={{ "--drawer-width": `${width}px` } as CSSProperties}
				aria-describedby={undefined}
				onCloseAutoFocus={onCloseAutoFocus}
				onOpenAutoFocus={onOpenAutoFocus}
				// A press on another cover switches the book; the page decides
				// when a press outside closes the drawer.
				onInteractOutside={preventDefault}
			>
				{resizeHandleProps && (
					<div className={styles.resizer} {...resizeHandleProps} />
				)}
				<DrawerHeader title={title} />
				<div className={styles.panelBody}>{children}</div>
			</Dialog.Content>
		</Dialog.Root>
	);
};

const DrawerHeader = ({ title }: { title?: string }) => (
	<div className={styles.header}>
		{title ? (
			<Dialog.Title className={styles.title}>{title}</Dialog.Title>
		) : (
			// Radix requires a Title for screen readers even when the
			// drawer has no visible heading.
			<Dialog.Title className={styles.hiddenTitle}>Details</Dialog.Title>
		)}
		<Dialog.Close asChild>
			<DialogCloseButton />
		</Dialog.Close>
	</div>
);
