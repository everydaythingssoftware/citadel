import type { components } from "./schema.generated";

type StagedUpload = components["schemas"]["StagedUpload"];
type LibraryError = components["schemas"]["LibraryError"];

export interface ChunkRequest {
	/** Absolute URL of `PATCH /api/uploads/{upload_id}/content`. */
	url: string;
	/** Must equal the upload's `receivedBytes`. */
	offset: number;
	body: Blob;
	signal?: AbortSignal;
	/** Bytes of this chunk sent so far. */
	onProgress?: (sentBytes: number) => void;
	/** Every byte has left the browser; the response is still to come. */
	onSent?: () => void;
}

export type ChunkResponse =
	| { kind: "ok"; upload: StagedUpload }
	| { kind: "rejected"; status: number; error: LibraryError | null }
	| { kind: "network" }
	| { kind: "aborted" };

const parse = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

const isLibraryError = (value: unknown): value is LibraryError =>
	typeof value === "object" &&
	value !== null &&
	"code" in value &&
	"message" in value;

/**
 * Sends one upload chunk. Uses XMLHttpRequest rather than the openapi-fetch
 * client because `fetch()` can't report upload progress in any browser, while
 * `xhr.upload.onprogress` works everywhere, iOS Safari included.
 */
export const sendUploadChunk = (
	request: ChunkRequest,
	createRequest: () => XMLHttpRequest = () => new XMLHttpRequest(),
): Promise<ChunkResponse> =>
	new Promise((resolve) => {
		if (request.signal?.aborted) {
			resolve({ kind: "aborted" });
			return;
		}
		const xhr = createRequest();
		const abort = () => xhr.abort();
		const settle = (response: ChunkResponse) => {
			request.signal?.removeEventListener("abort", abort);
			resolve(response);
		};
		xhr.open("PATCH", request.url);
		xhr.withCredentials = true;
		xhr.setRequestHeader("Upload-Offset", String(request.offset));
		xhr.setRequestHeader("Content-Type", "application/octet-stream");
		xhr.upload.onprogress = (event) => request.onProgress?.(event.loaded);
		xhr.upload.onload = () => request.onSent?.();
		xhr.onload = () => {
			const body = parse(xhr.responseText);
			if (xhr.status >= 200 && xhr.status < 300 && body !== null)
				settle({ kind: "ok", upload: body as StagedUpload });
			else
				settle({
					kind: "rejected",
					status: xhr.status,
					error: isLibraryError(body) ? body : null,
				});
		};
		xhr.onerror = () => settle({ kind: "network" });
		xhr.ontimeout = () => settle({ kind: "network" });
		xhr.onabort = () => settle({ kind: "aborted" });
		request.signal?.addEventListener("abort", abort, { once: true });
		xhr.send(request.body);
	});
