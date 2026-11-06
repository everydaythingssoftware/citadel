import { tauriOpdsClient } from "./tauri";
import type { OpdsClient } from "./types";
export type { OpdsClient } from "./types";

/** A web build gets no client at all, making accidental backend calls harder
 * than merely hiding or disabling a button. */
export const opdsClientForPlatform = (
	supported: boolean,
	desktopClient: OpdsClient = tauriOpdsClient,
): OpdsClient | null => (supported ? desktopClient : null);
