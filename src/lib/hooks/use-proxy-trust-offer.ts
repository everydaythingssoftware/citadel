import { useCallback, useEffect, useState } from "react";
import {
	type ServerProxies,
	serverService,
	type UntrustedProxy,
} from "@/lib/services/server";

/** A proxy Citadel believes, and whether Settings can stop trusting it. */
export interface TrustedProxyRow {
	range: string;
	/** False when it comes from the server's configuration. */
	removable: boolean;
}

/** What was just changed, to confirm in place. */
export type ProxyTrustChange =
	| { kind: "trusted"; range: string }
	| { kind: "untrusted"; range: string };

export interface ProxyTrustOfferState {
	/** The most recently seen untrusted forwarder, if any. */
	offer: UntrustedProxy | null;
	/** The proxies Citadel trusts, configured ones first. */
	trustedProxies: TrustedProxyRow[];
	/** The last change made here. */
	changed: ProxyTrustChange | null;
	/** The range waiting for confirmation before Citadel stops trusting it. */
	confirmingUntrust: string | null;
	pending: boolean;
	error: string | null;
	trust: () => void;
	dismiss: () => void;
	askUntrust: (range: string) => void;
	cancelUntrust: () => void;
	untrust: () => void;
}

const message = (failure: unknown) =>
	failure instanceof Error ? failure.message : String(failure);

const firstOffer = (proxies: ServerProxies): UntrustedProxy | null =>
	proxies.untrusted[0] ?? null;

/**
 * The proxies to list: configured ones (read-only, changed in the server's
 * configuration) and then those trusted from Settings, each once.
 */
export const trustedProxyRows = (proxies: ServerProxies): TrustedProxyRow[] => {
	const configured = proxies.configured ?? [];
	return [
		...configured.map((range) => ({ range, removable: false })),
		...proxies.trusted
			.filter((range) => !configured.includes(range))
			.map((range) => ({ range, removable: true })),
	];
};

/**
 * Reverse proxies for administrators: an offer to trust a peer on a private
 * network that sent forwarding headers Citadel ignores, and the proxies
 * already trusted. Trusting or dismissing acts at once; stopping trusting a
 * proxy asks first.
 */
export const useProxyTrustOffer = (): ProxyTrustOfferState => {
	const [proxies, setProxies] = useState<ServerProxies | null>(null);
	const [changed, setChanged] = useState<ProxyTrustChange | null>(null);
	const [confirmingUntrust, setConfirmingUntrust] = useState<string | null>(
		null,
	);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		serverService
			.proxies()
			.then((loaded) => {
				if (!cancelled) setProxies(loaded);
			})
			.catch((failure: unknown) => {
				if (!cancelled) setError(message(failure));
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const apply = useCallback(
		async (
			change: (range: string) => Promise<ServerProxies>,
			range: string,
			done: ProxyTrustChange | null,
		) => {
			setPending(true);
			setError(null);
			try {
				setProxies(await change(range));
				setChanged(done);
			} catch (failure) {
				setError(message(failure));
			} finally {
				setPending(false);
			}
		},
		[],
	);

	const offer = proxies ? firstOffer(proxies) : null;

	const trust = useCallback(() => {
		if (!offer) return;
		void apply(serverService.trustProxy, offer.address, {
			kind: "trusted",
			range: offer.address,
		});
	}, [apply, offer]);

	const dismiss = useCallback(() => {
		if (!offer) return;
		void apply(serverService.forgetProxy, offer.address, null);
	}, [apply, offer]);

	const askUntrust = useCallback((range: string) => {
		setConfirmingUntrust(range);
	}, []);
	const cancelUntrust = useCallback(() => setConfirmingUntrust(null), []);
	const untrust = useCallback(() => {
		const range = confirmingUntrust;
		setConfirmingUntrust(null);
		if (!range) return;
		void apply(serverService.forgetProxy, range, { kind: "untrusted", range });
	}, [apply, confirmingUntrust]);

	return {
		offer,
		trustedProxies: proxies ? trustedProxyRows(proxies) : [],
		changed,
		confirmingUntrust,
		pending,
		error,
		trust,
		dismiss,
		askUntrust,
		cancelUntrust,
		untrust,
	};
};
