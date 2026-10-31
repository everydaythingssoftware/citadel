import { ViewportDebug } from "@/components/atoms/ViewportDebug";
import { DropOverlay } from "@/components/molecules/DropOverlay";
import { UploadIndicator } from "@/components/molecules/UploadIndicator";
import { devFlag } from "@/lib/dev-flags";
import { useUploadController } from "@/lib/hooks/use-upload-controller";
import { useUploadStatus } from "@/lib/hooks/use-upload-status";
import { useVisibleViewport } from "@/lib/hooks/use-visible-viewport";
import { UploadSheet } from "./UploadSheet";

/**
 * Adding books by upload: the drop overlay and the upload sheet. Mount once,
 * inside the library chrome; it renders nothing for libraries that can't
 * take uploads.
 */
export const BookUploads = () => {
	const { enabled, dragging, sheet } = useUploadController();
	if (!enabled) return null;
	return (
		<>
			<DropOverlay visible={dragging} fan={devFlag("dropFan")} />
			<UploadSheet {...sheet} motion={devFlag("addedMotion")} />
			{devFlag("viewportDebug") === "on" && <LiveViewportDebug />}
		</>
	);
};

/** Toolbar status for uploads running while the sheet is closed. */
export const UploadToolbarStatus = () => {
	const { summary, soonest, open } = useUploadStatus();
	return (
		<UploadIndicator
			summary={summary}
			countdown={soonest}
			variant={devFlag("reviewIndicator")}
			onOpen={open}
		/>
	);
};

/** The viewport readout, live (citadel:viewportDebug). */
const LiveViewportDebug = () => {
	const viewport = useVisibleViewport();
	const active = document.activeElement;
	return (
		<ViewportDebug
			viewport={viewport}
			innerHeight={window.innerHeight}
			screenHeight={window.screen.height}
			focused={
				active
					? `${active.tagName.toLowerCase()}${active.getAttribute("type") ? `[${active.getAttribute("type")}]` : ""}`
					: "none"
			}
		/>
	);
};
