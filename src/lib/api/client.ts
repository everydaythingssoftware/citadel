import createClient, { type ClientOptions } from "openapi-fetch";
import {
	reportServerBuild,
	SERVER_BUILD_HEADER,
} from "@/lib/updates/server-build";
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

/**
 * The message of a Citadel error body, else `fallback`. A body of another
 * form, for example the HTML page of a proxy, has no message.
 */
export const errorBodyMessage = (error: unknown, fallback: string): string =>
	typeof error === "object" &&
	error !== null &&
	"message" in error &&
	typeof error.message === "string"
		? error.message
		: fallback;

const isAbort = (error: unknown) =>
	error instanceof DOMException && error.name === "AbortError";

// Browsers report a failed connection with their own terse wording ("Load
// failed", "Failed to fetch", "NetworkError…"), which means nothing to a
// reader. Cancelled requests are left alone.
const reportingUnreachable =
	(fetcher: ClientOptions["fetch"]) =>
	async (input: Request): Promise<Response> => {
		try {
			const response = await (fetcher ?? globalThis.fetch)(input);
			reportServerBuild(response.headers.get(SERVER_BUILD_HEADER));
			return response;
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
