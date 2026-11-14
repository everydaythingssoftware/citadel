import { describe, expect, it } from "vitest";
import {
	type DownloadProgress,
	fetchContentLength,
	fetchWithProgress,
} from "./download";

const streamOf = (chunks: number[]) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			for (const size of chunks) controller.enqueue(new Uint8Array(size));
			controller.close();
		},
	});

const respond =
	(response: Response) =>
	async (_input: string, _init?: RequestInit): Promise<Response> =>
		response;

describe("fetchWithProgress", () => {
	it("reports each chunk against the Content-Length", async () => {
		const progress: DownloadProgress[] = [];
		const blob = await fetchWithProgress("/book.epub", {
			onProgress: (update) => progress.push(update),
			fetcher: respond(
				new Response(streamOf([3, 5]), {
					headers: {
						"Content-Length": "8",
						"Content-Type": "application/epub+zip",
					},
				}),
			),
		});
		expect(progress).toEqual([
			{ received: 0, total: 8 },
			{ received: 3, total: 8 },
			{ received: 8, total: 8 },
		]);
		expect(blob.size).toBe(8);
		expect(blob.type).toBe("application/epub+zip");
	});

	it("reports an unknown total without a Content-Length", async () => {
		const progress: DownloadProgress[] = [];
		await fetchWithProgress("/book.epub", {
			onProgress: (update) => progress.push(update),
			fetcher: respond(new Response(streamOf([4]))),
		});
		expect(progress.at(-1)).toEqual({ received: 4, total: null });
	});

	it("rejects an error answer", async () => {
		await expect(
			fetchWithProgress("/book.epub", {
				onProgress: () => {},
				fetcher: respond(new Response("nope", { status: 404 })),
			}),
		).rejects.toThrow("Download failed (404)");
	});

	it("passes the abort signal to the request", async () => {
		const controller = new AbortController();
		let seen: AbortSignal | null | undefined;
		await fetchWithProgress("/book.epub", {
			signal: controller.signal,
			onProgress: () => {},
			fetcher: async (_input, init) => {
				seen = init?.signal;
				return new Response(streamOf([1]));
			},
		});
		expect(seen).toBe(controller.signal);
	});
});

describe("fetchContentLength", () => {
	it("reads the size from a HEAD request", async () => {
		let method: string | undefined;
		const size = await fetchContentLength(
			"/book.epub",
			async (_input, init) => {
				method = init?.method;
				return new Response(null, { headers: { "Content-Length": "2100000" } });
			},
		);
		expect(method).toBe("HEAD");
		expect(size).toBe(2_100_000);
	});

	it("is null when the request fails or says nothing", async () => {
		expect(
			await fetchContentLength("/x", async () => {
				throw new Error("offline");
			}),
		).toBeNull();
		expect(
			await fetchContentLength("/x", async () => new Response(null)),
		).toBeNull();
	});
});
