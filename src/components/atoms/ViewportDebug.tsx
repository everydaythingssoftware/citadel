import type { VisibleViewport } from "@/lib/hooks/use-visible-viewport";
import styles from "./ViewportDebug.module.css";

export interface ViewportDebugProps {
	viewport: VisibleViewport;
	/** Layout and screen sizes as the browser reports them. */
	innerHeight: number;
	screenHeight: number;
	focused: string;
}

/** A developer readout of what the app thinks the screen and keyboard are doing. */
export const ViewportDebug = ({
	viewport,
	innerHeight,
	screenHeight,
	focused,
}: ViewportDebugProps) => (
	<pre className={styles.debug} aria-hidden="true">
		{[
			`visual  top ${Math.round(viewport.top)}  height ${Math.round(viewport.height)}`,
			`inner   ${innerHeight}  screen ${screenHeight}`,
			`touch ${viewport.touch}  keyboard ${viewport.keyboard}  cramped ${viewport.cramped}`,
			`focus   ${focused}`,
		].join("\n")}
	</pre>
);
