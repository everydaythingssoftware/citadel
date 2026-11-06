import { useEffect, useState } from "react";
import { type ServerAddresses, serverService } from "@/lib/services/server";

export interface ServerAddressesState {
	/** Null until the list has loaded. */
	addresses: ServerAddresses | null;
	error: string | null;
}

/**
 * The public URLs browsers may reach the server at; administrators only.
 * Read-only: they're set in the server's configuration or with its CLI.
 */
export const useServerAddresses = (): ServerAddressesState => {
	const [addresses, setAddresses] = useState<ServerAddresses | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		serverService
			.addresses()
			.then((loaded) => {
				if (!cancelled) setAddresses(loaded);
			})
			.catch((failure: unknown) => {
				if (!cancelled)
					setError(
						failure instanceof Error ? failure.message : String(failure),
					);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return { addresses, error };
};
