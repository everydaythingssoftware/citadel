import { useEffect, useMemo } from "react";
import { getDescriptor } from "@/lib/metadata-providers/registry";
import type {
	ProviderDescriptor,
	ProviderId,
	ResolvedProviderConfig,
} from "@/lib/metadata-providers/types";
import { CREDENTIAL_HOME, metadataService } from "@/lib/services/metadata";
import { useMetadataAvailability } from "@/stores/metadata-availability/store";
import { useSettings } from "./store";

const serverHoldsKeys = metadataService.credentials === CREDENTIAL_HOME.server;

/** True in a browser: keyed providers use the user's key kept by the server. */
export const providerKeysOnServer = serverHoldsKeys;

/** Why a key-requiring provider can't be used, as the server reports it. */
export const useServerKeyReason = (id: ProviderId): string | null =>
	useMetadataAvailability((state) => state.byProvider[id]?.reason ?? null);

/**
 * Whether a key-requiring provider has a key: in local settings on the
 * desktop, or on the server for the signed-in user in a browser.
 */
export const useProviderKeyAvailable = (): ((id: ProviderId) => boolean) => {
	const configs = useSettings((state) => state.metadataProviders.configs);
	const availability = useMetadataAvailability((state) => state.byProvider);
	const loaded = useMetadataAvailability((state) => state.loaded);
	const refresh = useMetadataAvailability((state) => state.refresh);
	useEffect(() => {
		if (serverHoldsKeys && !loaded) void refresh();
	}, [loaded, refresh]);
	return useMemo(
		() => (id: ProviderId) =>
			serverHoldsKeys
				? availability[id]?.available === true
				: (configs[id]?.apiKey ?? "").trim().length > 0,
		[configs, availability],
	);
};

/**
 * Providers usable for a lookup right now: enabled, in preference order, and —
 * for key-requiring providers — actually configured with a key. This is what
 * makes "no Hardcover key -> library lookup still works" fall out structurally.
 */
export const useEnabledProviders = (): ProviderDescriptor[] => {
	const metadataProviders = useSettings((state) => state.metadataProviders);
	const keyAvailable = useProviderKeyAvailable();
	return useMemo(() => {
		return metadataProviders.preferenceOrder
			.filter((id) => metadataProviders.configs[id]?.enabled)
			.map((id) => getDescriptor(id))
			.filter(
				(descriptor) =>
					!descriptor.capabilities.requiresKey || keyAvailable(descriptor.id),
			);
	}, [metadataProviders, keyAvailable]);
};

/** Whether any source is usable for a lookup (drives the Edit Book guard). */
export const useAnySourceEnabled = (): boolean =>
	useEnabledProviders().length > 0;

/** A stable resolver for a provider's runtime config (its key, if any). */
export const useResolvedProviderConfig = (): ((
	id: ProviderId,
) => ResolvedProviderConfig) => {
	const metadataProviders = useSettings((state) => state.metadataProviders);
	return useMemo(
		() => (id: ProviderId) => ({
			apiKey: metadataProviders.configs[id]?.apiKey ?? "",
		}),
		[metadataProviders],
	);
};

export const useAutoLookupOnImport = (): boolean =>
	useSettings((state) => state.metadataProviders.autoLookupOnImport);
