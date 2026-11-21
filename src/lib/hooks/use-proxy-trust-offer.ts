import { useCallback, useEffect, useState } from "react";
import {
	type ServerProxies,
	serverService,
	type UntrustedProxy,
} from "@/lib/services/server";

export interface ProxyTrustOfferState {
	/** The most recently seen untrusted forwarder, if any. */
	offer: UntrustedProxy | null;
	/** The address just trusted, to confirm in place. */
	trusted: string | null;
	pending: boolean;
	error: string | null;
	trust: () => void;
	dismiss: () => void;
}

const message = (failure: unknown) =>
	failure instanceof Error ? failure.message : String(failure);

const firstOffer = (proxies: ServerProxies): UntrustedProxy | null =>
	proxies.untrusted[0] ?? null;

/**
 * Whether to offer trusting a reverse proxy, for administrators: a peer on a
 * private network sent forwarding headers that Citadel ignores. Trusting it
 * or dismissing the offer acts at once.
 */
export const useProxyTrustOffer = (): ProxyTrustOfferState => {
	const [offer, setOffer] = useState<UntrustedProxy | null>(null);
	const [trusted, setTrusted] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		serverService
			.proxies()
			.then((proxies) => {
				if (!cancelled) setOffer(firstOffer(proxies));
			})
			.catch((failure: unknown) => {
				if (!cancelled) setError(message(failure));
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const act = useCallback(
		async (
			change: (range: string) => Promise<ServerProxies>,
			confirm: boolean,
		) => {
			if (!offer) return;
			setPending(true);
			setError(null);
			try {
				const proxies = await change(offer.address);
				setTrusted(confirm ? offer.address : null);
				setOffer(firstOffer(proxies));
			} catch (failure) {
				setError(message(failure));
			} finally {
				setPending(false);
			}
		},
		[offer],
	);

	const trust = useCallback(() => {
		void act(serverService.trustProxy, true);
	}, [act]);
	const dismiss = useCallback(() => {
		void act(serverService.forgetProxy, false);
	}, [act]);

	return { offer, trusted, pending, error, trust, dismiss };
};
