import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { commands } from "@/bindings";
import { toast } from "@/components/ui";
import { POPOVER_ATTRIBUTE } from "@/components/ui/popover-interop";
import { ADOPT_INVALID_ERROR } from "@/lib/first-run/machine";
import { usePlatform } from "@/lib/platform/context";
import { createLibrary, setActiveLibrary } from "@/stores/settings/actions";
import { useSettings } from "@/stores/settings/store";
import styles from "./LibraryPicker.module.css";

interface MenuRect {
	left: number;
	top: number;
	width: number;
	maxHeight: number;
}

const MENU_MIN_WIDTH = 180;
const MENU_GAP = 6;
const INVALID_TOAST_ID = "library-picker-invalid";

const ChevronDown = () => (
	<svg width="8" height="5" viewBox="0 0 8 5" fill="none" aria-hidden="true">
		<path
			d="M1 1l3 3 3-3"
			stroke="currentColor"
			strokeWidth="1.3"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

const CheckmarkIcon = () => (
	<svg
		width="10"
		height="10"
		viewBox="0 0 10 10"
		fill="none"
		aria-hidden="true"
	>
		<path
			d="M1.5 5.5L4 8l4.5-6"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

const PlusIcon = () => (
	<svg
		width="10"
		height="10"
		viewBox="0 0 10 10"
		fill="none"
		aria-hidden="true"
	>
		<path
			d="M5 1v8M1 5h8"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
		/>
	</svg>
);

/**
 * Sidebar-top library picker (replaces the "Library" section label when two
 * or more libraries exist). Apple-style menu: library names with a checkmark
 * on the active one, then "Add Library…". Switches validate before
 * committing; the resulting curtain is driven by the store-watching machine,
 * not by this component.
 */
export const LibraryPicker = () => {
	const libraries = useSettings((state) => state.libraryPaths);
	const activeLibraryId = useSettings((state) => state.activeLibraryId);
	const platform = usePlatform();

	const [open, setOpen] = useState(false);
	const [menuRect, setMenuRect] = useState<MenuRect | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);

	const activeLibrary = libraries.find(
		(library) => library.id === activeLibraryId,
	);

	// Re-measured on scroll/resize like TagsInput's completion list.
	useLayoutEffect(() => {
		if (!open) {
			setMenuRect(null);
			return;
		}
		const update = () => {
			const rect = triggerRef.current?.getBoundingClientRect();
			if (!rect) return;
			// NSPopUpButton behavior: the menu matches the trigger's width.
			const width = Math.max(rect.width, MENU_MIN_WIDTH);
			const left = Math.min(rect.left, window.innerWidth - width - 8);
			const top = rect.bottom + MENU_GAP;
			setMenuRect({
				left,
				top,
				width,
				maxHeight: window.innerHeight - top - 8,
			});
		};
		update();
		window.addEventListener("resize", update);
		window.addEventListener("scroll", update, true);
		return () => {
			window.removeEventListener("resize", update);
			window.removeEventListener("scroll", update, true);
		};
	}, [open]);

	// Open lands focus on the active item (Apple menu behavior); Escape
	// returns it to the trigger.
	useLayoutEffect(() => {
		if (!open || !menuRect) return;
		const menu = menuRef.current;
		if (!menu) return;
		const target =
			menu.querySelector<HTMLButtonElement>(
				'[role="menuitemradio"][aria-checked="true"]',
			) ??
			menu.querySelector<HTMLButtonElement>(
				'[role="menuitemradio"], [role="menuitem"]',
			);
		target?.focus();
	}, [open, menuRect]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (menuRef.current?.contains(target)) return;
			if (triggerRef.current?.contains(target)) return;
			setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			setOpen(false);
			triggerRef.current?.focus();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, [open]);

	if (!activeLibrary) return null;

	const switchTo = (id: string) => {
		if (id === activeLibraryId) return;
		const library = libraries.find((entry) => entry.id === id);
		if (!library) return;
		void (async () => {
			try {
				const valid = await commands.clbQueryIsPathValidLibrary(
					library.absolutePath,
				);
				if (!valid) {
					toast.show({
						id: INVALID_TOAST_ID,
						title: "Not a Calibre library",
						message: ADOPT_INVALID_ERROR,
					});
					return;
				}
				await setActiveLibrary(id);
			} catch (error) {
				console.error("Library switch failed:", error);
				toast.show({
					id: INVALID_TOAST_ID,
					title: "Couldn't switch libraries",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		})();
	};

	const addLibrary = () => {
		void (async () => {
			try {
				const path = await platform.dialogs.openDirectory({
					title: "Select Calibre Library Folder",
				});
				if (path === null) return;
				const valid = await commands.clbQueryIsPathValidLibrary(path);
				if (!valid) {
					toast.show({
						id: INVALID_TOAST_ID,
						title: "Not a Calibre library",
						message: ADOPT_INVALID_ERROR,
					});
					return;
				}
				const newLibraryId = await createLibrary(path);
				await setActiveLibrary(newLibraryId);
			} catch (error) {
				console.error("Adding a library failed:", error);
				toast.show({
					id: "library-picker-add-failed",
					title: "Couldn't add that folder",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		})();
	};

	const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const items = Array.from(
			menuRef.current?.querySelectorAll<HTMLButtonElement>(
				'[role="menuitem"], [role="menuitemradio"]',
			) ?? [],
		);
		if (items.length === 0) return;
		const activeElement = document.activeElement;
		const current =
			activeElement instanceof HTMLButtonElement
				? items.indexOf(activeElement)
				: -1;
		let next: number;
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				next = current + 1;
				break;
			case "ArrowUp":
				event.preventDefault();
				next = current - 1;
				break;
			case "Home":
				event.preventDefault();
				next = 0;
				break;
			case "End":
				event.preventDefault();
				next = items.length - 1;
				break;
			default:
				return;
		}
		if (next < 0) next = items.length - 1;
		if (next >= items.length) next = 0;
		items[next]?.focus();
	};

	const menu =
		open &&
		menuRect &&
		createPortal(
			<div
				ref={menuRef}
				role="menu"
				aria-label="Switch library"
				className={styles.menu}
				{...{ [POPOVER_ATTRIBUTE]: "" }}
				style={{
					left: menuRect.left,
					top: menuRect.top,
					width: menuRect.width,
					maxHeight: menuRect.maxHeight,
				}}
				onKeyDown={onMenuKeyDown}
			>
				{libraries.map((library) => (
					<button
						key={library.id}
						type="button"
						role="menuitemradio"
						aria-checked={library.id === activeLibrary.id}
						className={styles.menuRow}
						onClick={() => {
							switchTo(library.id);
							setOpen(false);
						}}
					>
						<span className={styles.menuCheck}>
							{library.id === activeLibrary.id ? <CheckmarkIcon /> : null}
						</span>
						<span className={styles.menuName}>{library.displayName}</span>
					</button>
				))}
				<div className={styles.menuDivider} />
				<button
					type="button"
					role="menuitem"
					className={styles.menuRow}
					onClick={() => {
						addLibrary();
						setOpen(false);
					}}
				>
					<span className={styles.menuCheck}>
						<PlusIcon />
					</span>
					<span className={styles.menuName}>Add Library…</span>
				</button>
			</div>,
			document.body,
		);

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				className={styles.trigger}
				data-open={open || undefined}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={`Library: ${activeLibrary.displayName}`}
				onClick={() => setOpen((prev) => !prev)}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown" && !open) {
						event.preventDefault();
						setOpen(true);
					}
				}}
			>
				<span className={styles.triggerName}>{activeLibrary.displayName}</span>
				<span className={styles.triggerChevron}>
					<ChevronDown />
				</span>
			</button>
			{menu}
		</>
	);
};
