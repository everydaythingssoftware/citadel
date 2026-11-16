const isClientSide = typeof window !== "undefined";

/** Download a file from a URL.
 * Requires a browser environment.
 * @param url The URL to download from.
 */
export const downloadFile = (url: string) => {
	if (!isClientSide) {
		return;
	}

	const a = document.createElement("a");
	a.href = url;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
};

export interface DownloadProgress {
	received: number;
	/** Null when the response didn't say how long it is. */
	total: number | null;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const contentLength = (response: Response): number | null => {
	const header = response.headers.get("Content-Length");
	const length = header === null ? Number.NaN : Number(header);
	return Number.isFinite(length) && length > 0 ? length : null;
};

/**
 * Fetches a file as a Blob, reporting bytes as they arrive. Rejects on a
 * non-2xx answer; an abort rejects with the signal's AbortError.
 */
export const fetchWithProgress = async (
	url: string,
	{
		signal,
		onProgress,
		fetcher = globalThis.fetch,
	}: {
		signal?: AbortSignal;
		onProgress: (progress: DownloadProgress) => void;
		fetcher?: Fetcher;
	},
): Promise<Blob> => {
	const response = await fetcher(url, { signal, credentials: "same-origin" });
	if (!response.ok) throw new Error(`Download failed (${response.status})`);
	const total = contentLength(response);
	const type = response.headers.get("Content-Type") ?? "";
	if (!response.body) {
		const blob = await response.blob();
		onProgress({ received: blob.size, total: total ?? blob.size });
		return blob;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	onProgress({ received, total });
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.byteLength;
		onProgress({ received, total });
	}
	return new Blob(chunks as BlobPart[], { type });
};

/** Hands a Blob to the browser as a download named `filename`. */
export const saveBlob = (blob: Blob, filename: string) => {
	if (!isClientSide) return;
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	// Safari reads the object URL after click() returns.
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
};

/** The file's size from a HEAD request, or null when it can't be told. */
export const fetchContentLength = async (
	url: string,
	fetcher: Fetcher = globalThis.fetch,
): Promise<number | null> => {
	try {
		const response = await fetcher(url, {
			method: "HEAD",
			credentials: "same-origin",
		});
		return response.ok ? contentLength(response) : null;
	} catch {
		return null;
	}
};
