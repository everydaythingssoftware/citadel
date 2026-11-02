import { create } from "zustand";
import type { ProviderId } from "@/lib/metadata-providers/types";
import {
	metadataService,
	type ProviderAvailability,
} from "@/lib/services/metadata";

interface MetadataAvailabilityState {
	byProvider: Partial<Record<ProviderId, ProviderAvailability>>;
	loaded: boolean;
	/** Ask the host again, e.g. after the user changes a credential. */
	refresh: () => Promise<void>;
}

let inFlight: Promise<void> | null = null;

/**
 * Which providers the signed-in user can use, as the host reports it. Only
 * meaningful where credentials live on the server; the desktop's keys are in
 * local settings.
 */
export const useMetadataAvailability = create<MetadataAvailabilityState>()(
	(set) => ({
		byProvider: {},
		loaded: false,
		refresh: () => {
			inFlight ??= metadataService
				.availability()
				.then((items) =>
					set({
						byProvider: Object.fromEntries(
							items.map((item) => [item.provider, item]),
						),
						loaded: true,
					}),
				)
				.catch(() => set({ loaded: true }))
				.finally(() => {
					inFlight = null;
				});
			return inFlight;
		},
	}),
);
