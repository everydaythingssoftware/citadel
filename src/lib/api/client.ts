import createClient, { type ClientOptions } from "openapi-fetch";
import type { paths } from "./schema.generated";

export const SERVER_UNREACHABLE_MESSAGE =
	"Couldn't reach the server. Check your connection and try again.";

/** The request never got an answer: the network is down or the server isn't running. */
export class ServerUnreachableError extends Error {
	constructor(options?: ErrorOptions) {
		super(SERVER_UNREACHABLE_MESSAGE, options);
		this.name = "ServerUnreachableError";
	}
}

const isAbort = (error: unknown) =>
	error instanceof DOMException && error.name === "AbortError";

// Browsers report a failed connection with their own terse wording ("Load
// failed", "Failed to fetch", "NetworkError…"), which means nothing to a
// reader. Cancelled requests are left alone.
const reportingUnreachable =
	(fetcher: ClientOptions["fetch"]) =>
	async (input: Request): Promise<Response> => {
		try {
			return await (fetcher ?? globalThis.fetch)(input);
		} catch (error) {
			if (isAbort(error)) throw error;
			throw new ServerUnreachableError({ cause: error });
		}
	};

/** Typed HTTP transport; authentication and server selection belong to its caller. */
export function createCitadelHttpClient(options: ClientOptions) {
	return createClient<paths>({
		...options,
		fetch: reportingUnreachable(options.fetch),
	});
}
