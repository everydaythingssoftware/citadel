import { useCallback, useEffect, useRef, useState } from "react";
import { libraryCatalog } from "@/lib/services/library-catalog";
import type {
	SetupEffect,
	SetupEvent,
	SetupSnapshot,
} from "@/lib/web-setup/machine";
import { initSetup, transition } from "@/lib/web-setup/machine";

export interface WebSetupFlow {
	snapshot: SetupSnapshot;
	send: (event: SetupEvent) => void;
}

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/**
 * Imperative shell for the web setup flow: owns the machine snapshot and runs
 * its effects against the server's setup routes through LibraryCatalog.
 */
export const useWebSetupFlow = (): WebSetupFlow => {
	const [init] = useState(() => initSetup());
	const [snapshot, setSnapshot] = useState<SetupSnapshot>(init.snapshot);
	const snapshotRef = useRef(snapshot);

	const sendRef = useRef<(event: SetupEvent) => void>(() => {});
	const send = useCallback((event: SetupEvent) => {
		const { snapshot: next, effects } = transition(snapshotRef.current, event);
		snapshotRef.current = next;
		setSnapshot(next);
		for (const effect of effects) {
			void runEffect(effect, sendRef.current);
		}
	}, []);
	sendRef.current = send;

	const bootedRef = useRef(false);
	useEffect(() => {
		if (bootedRef.current) return;
		bootedRef.current = true;
		for (const effect of init.effects) {
			void runEffect(effect, sendRef.current);
		}
	}, [init]);

	return { snapshot, send };
};

const runEffect = async (
	effect: SetupEffect,
	send: (event: SetupEvent) => void,
): Promise<void> => {
	const { setup } = libraryCatalog;
	switch (effect.kind) {
		case "load-status": {
			try {
				const status = await setup.status();
				send({
					type: "STATUS_LOADED",
					library: status.library,
					browseRoot: status.browseRoot,
					found: status.found,
				});
			} catch (error) {
				send({ type: "STATUS_FAILED", message: message(error) });
			}
			return;
		}
		case "inspect": {
			try {
				const inspection = await setup.inspect(effect.path);
				send({ type: "INSPECTED", path: effect.path, inspection });
			} catch (error) {
				send({
					type: "INSPECT_FAILED",
					path: effect.path,
					message: message(error),
				});
			}
			return;
		}
		case "list": {
			try {
				const listing = await setup.listDirectory(effect.path ?? undefined);
				send({ type: "LISTED", listing });
			} catch (error) {
				send({ type: "LIST_FAILED", message: message(error) });
			}
			return;
		}
		case "commit": {
			try {
				const library = await setup.choose(effect.request);
				send({ type: "COMMITTED", library });
			} catch (error) {
				send({ type: "COMMIT_FAILED", message: message(error) });
			}
			return;
		}
		case "reopen": {
			try {
				const library = await setup.reopen();
				send({ type: "REOPENED", library });
			} catch (error) {
				send({ type: "REOPEN_FAILED", message: message(error) });
			}
			return;
		}
	}
};
