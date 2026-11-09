import { useCallback, useRef, useState } from "react";
import { toast } from "@/components/ui";
import {
	type AddLibraryEffect,
	type AddLibraryEvent,
	type AddLibraryStep,
	initialAddLibraryStep,
	transition,
} from "@/lib/add-library/flow";
import { createErrorCodeFor } from "@/lib/first-run/machine";
import { useLibrarySelection } from "@/lib/hooks/use-library-selection";
import { usePlatform } from "@/lib/platform/context";
import { libraryCatalog } from "@/lib/services/library-catalog";

export const PICK_FOLDER_TITLE = "Choose a folder for your library";

const ADD_LIBRARY_TOAST_ID = "add-library-failed";

export interface AddLibraryFlow {
	step: AddLibraryStep;
	send: (event: AddLibraryEvent) => void;
	/** Opens the folder picker; ignored while a step is already under way. */
	start: () => void;
}

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/**
 * Imperative shell for "Add Library…": owns the flow's step and runs its
 * effects (the folder picker, the folder inspection, the book count, and
 * the create/open that commits). Render `AddLibraryDialog` with its result.
 */
export const useAddLibraryFlow = (): AddLibraryFlow => {
	const platform = usePlatform();
	const { adoptLibrary } = useLibrarySelection();
	const [step, setStep] = useState<AddLibraryStep>(initialAddLibraryStep);
	const stepRef = useRef(step);

	const sendRef = useRef<(event: AddLibraryEvent) => void>(() => {});

	const adopt = useCallback(
		async (path: string) => {
			const result = await adoptLibrary(path);
			sendRef.current(
				result.ok
					? { type: "SUCCEEDED" }
					: { type: "FAILED", message: result.message },
			);
		},
		[adoptLibrary],
	);

	const run = useCallback(
		async (effect: AddLibraryEffect) => {
			const send = sendRef.current;
			try {
				switch (effect.type) {
					case "pick": {
						const path = await platform.dialogs.openDirectory({
							title: PICK_FOLDER_TITLE,
						});
						send({ type: "PICKED", path });
						return;
					}
					case "inspect": {
						try {
							const contents = await libraryCatalog.inspectFolder(
								effect.folder,
							);
							send({ type: "INSPECTED", contents });
						} catch (error) {
							send({ type: "INSPECT_FAILED", message: messageOf(error) });
						}
						return;
					}
					case "count-books": {
						const stats = await libraryCatalog.stats(effect.libraryPath);
						send({
							type: "BOOK_COUNT",
							libraryPath: effect.libraryPath,
							count: stats.book_count,
						});
						return;
					}
					case "adopt":
						await adopt(effect.path);
						return;
					case "create": {
						try {
							await libraryCatalog.create(effect.path);
						} catch (error) {
							const message = messageOf(error);
							send({
								type: "FAILED",
								message,
								code: createErrorCodeFor(message),
							});
							return;
						}
						await adopt(effect.path);
						return;
					}
					case "notify-failure":
						toast.show({
							id: ADD_LIBRARY_TOAST_ID,
							title: effect.title,
							message: effect.message,
						});
						return;
				}
			} catch (error) {
				console.error(`Add Library step "${effect.type}" failed:`, error);
				// A missing book count only leaves the line out; anything else
				// lands back on the dialog (or a toast) as a failure.
				if (effect.type !== "count-books") {
					send({ type: "FAILED", message: messageOf(error) });
				}
			}
		},
		[platform, adopt],
	);

	const send = useCallback(
		(event: AddLibraryEvent) => {
			const next = transition(stepRef.current, event);
			stepRef.current = next.step;
			setStep(next.step);
			for (const effect of next.effects) void run(effect);
		},
		[run],
	);
	sendRef.current = send;

	const start = useCallback(() => send({ type: "START" }), [send]);

	return { step, send, start };
};
