import { useWindowDragStrip } from "@/lib/hooks/use-window-drag-strip";
import { usePlatform } from "@/lib/platform/context";
import styles from "./WindowDragStrip.module.css";

/**
 * A toolbar-high strip across the top of the window, above every layer
 * (first run, recovery, the library-switch curtain, sheets and alerts), so
 * the window can always be moved. Desktop only.
 */
export const WindowDragStrip = () => {
	const platform = usePlatform();
	const { ref, onPointerDown } = useWindowDragStrip();
	if (!platform.capabilities.supportsNativeWindows) return null;
	return (
		<div
			ref={ref}
			className={styles.strip}
			aria-hidden="true"
			data-tauri-drag-region
			onPointerDown={onPointerDown}
		/>
	);
};
