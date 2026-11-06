import { useCallback, useEffect, useRef, useState } from "react";
import type { NewDeviceKey } from "@/bindings";

const COPIED_MS = 1_500;

export type DeviceKeySheetView =
	| { step: "naming" }
	| { step: "showing"; key: NewDeviceKey };

interface DeviceKeySheetOptions {
	createDeviceKey: (name: string) => Promise<NewDeviceKey | null>;
	rotateDeviceKey: (keyId: string) => Promise<NewDeviceKey | null>;
	clearError: () => void;
	copyText: (text: string) => Promise<void>;
}

/** Adding or rotating a device password, ending on the one screen that shows it.
 * `view` outlives `open` until the close animation ends, then drops the key. */
export const useDeviceKeySheet = ({
	createDeviceKey,
	rotateDeviceKey,
	clearError,
	copyText,
}: DeviceKeySheetOptions) => {
	const [open, setOpen] = useState(false);
	const [view, setView] = useState<DeviceKeySheetView | null>(null);
	const [name, setName] = useState("");
	const [copied, setCopied] = useState(false);
	const copiedTimer = useRef<number | null>(null);

	useEffect(
		() => () => {
			if (copiedTimer.current !== null)
				window.clearTimeout(copiedTimer.current);
		},
		[],
	);

	const show = useCallback((key: NewDeviceKey) => {
		setCopied(false);
		setName("");
		setView({ step: "showing", key });
		setOpen(true);
	}, []);

	const startAdding = useCallback(() => {
		clearError();
		setName("");
		setView({ step: "naming" });
		setOpen(true);
	}, [clearError]);

	const submitName = useCallback(async () => {
		if (view?.step !== "naming" || !name.trim()) return;
		const created = await createDeviceKey(name);
		if (created) show(created);
	}, [view, name, createDeviceKey, show]);

	const rotate = useCallback(
		async (keyId: string) => {
			const rotated = await rotateDeviceKey(keyId);
			if (rotated) show(rotated);
		},
		[rotateDeviceKey, show],
	);

	const copyKey = useCallback(async () => {
		if (view?.step !== "showing") return;
		await copyText(view.key.secret);
		setCopied(true);
		if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
		copiedTimer.current = window.setTimeout(() => {
			copiedTimer.current = null;
			setCopied(false);
		}, COPIED_MS);
	}, [view, copyText]);

	const close = useCallback(() => {
		clearError();
		setOpen(false);
	}, [clearError]);

	const closed = useCallback(() => {
		setView(null);
		setName("");
		setCopied(false);
	}, []);

	return {
		open,
		view,
		name,
		setName,
		copied,
		startAdding,
		submitName,
		rotate,
		copyKey,
		close,
		closed,
	};
};
