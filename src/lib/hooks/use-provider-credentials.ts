import { useCallback, useEffect, useState } from "react";
import type { MetadataProvider } from "@/bindings";
import {
	accountService,
	type ProviderCredentialSummary,
} from "@/lib/services/account";
import { useMetadataAvailability } from "@/stores/metadata-availability/store";
import { useSettings } from "@/stores/settings/store";

export const CREDENTIAL_BUSY = {
	idle: "idle",
	saving: "saving",
	testing: "testing",
	removing: "removing",
} as const;
export type CredentialBusy =
	(typeof CREDENTIAL_BUSY)[keyof typeof CREDENTIAL_BUSY];

export interface CredentialNotice {
	tone: "ok" | "error";
	message: string;
}

export interface ProviderCredentialController {
	saved: ProviderCredentialSummary | null;
	loading: boolean;
	busy: CredentialBusy;
	notice: CredentialNotice | null;
	save: (secret: string) => Promise<boolean>;
	test: () => Promise<void>;
	remove: () => Promise<void>;
}

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/**
 * The signed-in user's server-side key for one provider: load, check-and-save,
 * test and remove. Saving also turns the provider on in this browser and
 * refreshes which providers lookups may use.
 */
export const useProviderCredential = (
	provider: MetadataProvider,
): ProviderCredentialController => {
	const [saved, setSaved] = useState<ProviderCredentialSummary | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<CredentialBusy>(CREDENTIAL_BUSY.idle);
	const [notice, setNotice] = useState<CredentialNotice | null>(null);
	const refreshAvailability = useMetadataAvailability((state) => state.refresh);
	const setProviderEnabled = useSettings((state) => state.setProviderEnabled);

	useEffect(() => {
		let cancelled = false;
		accountService
			.listProviderCredentials()
			.then((items) => {
				if (!cancelled)
					setSaved(items.find((item) => item.provider === provider) ?? null);
			})
			.catch((error: unknown) => {
				if (!cancelled) setNotice({ tone: "error", message: messageOf(error) });
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [provider]);

	const save = useCallback(
		async (secret: string) => {
			setBusy(CREDENTIAL_BUSY.saving);
			setNotice(null);
			try {
				setSaved(await accountService.saveProviderCredential(provider, secret));
				await setProviderEnabled(provider, true);
				await refreshAvailability();
				setNotice({ tone: "ok", message: "Key checked and saved." });
				return true;
			} catch (error) {
				setNotice({ tone: "error", message: messageOf(error) });
				return false;
			} finally {
				setBusy(CREDENTIAL_BUSY.idle);
			}
		},
		[provider, refreshAvailability, setProviderEnabled],
	);

	const test = useCallback(async () => {
		setBusy(CREDENTIAL_BUSY.testing);
		setNotice(null);
		const result = await accountService.testProviderCredential(provider);
		setNotice({
			tone: result.ok ? "ok" : "error",
			message: result.ok ? "Key works." : result.message,
		});
		if (result.ok)
			setSaved((current) =>
				current ? { ...current, verifiedAt: new Date() } : current,
			);
		setBusy(CREDENTIAL_BUSY.idle);
	}, [provider]);

	const remove = useCallback(async () => {
		setBusy(CREDENTIAL_BUSY.removing);
		setNotice(null);
		try {
			await accountService.removeProviderCredential(provider);
			setSaved(null);
			await refreshAvailability();
		} catch (error) {
			setNotice({ tone: "error", message: messageOf(error) });
		} finally {
			setBusy(CREDENTIAL_BUSY.idle);
		}
	}, [provider, refreshAvailability]);

	return { saved, loading, busy, notice, save, test, remove };
};
