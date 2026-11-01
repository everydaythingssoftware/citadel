import { DropOverlay } from "@/components/molecules/DropOverlay";
import { UploadIndicator } from "@/components/molecules/UploadIndicator";
import { useUploadController } from "@/lib/hooks/use-upload-controller";
import { useUploadStatus } from "@/lib/hooks/use-upload-status";
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
			<DropOverlay visible={dragging} />
			<UploadSheet {...sheet} />
		</>
	);
};

/** Toolbar status for uploads running while the sheet is closed. */
export const UploadToolbarStatus = () => {
	const { summary, soonest, open } = useUploadStatus();
	return (
		<UploadIndicator summary={summary} countdown={soonest} onOpen={open} />
	);
};
