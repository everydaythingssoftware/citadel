import { describe, expect, it } from "vitest";
import { sendUploadChunk } from "./upload-chunk";

/** Just enough XMLHttpRequest to drive the helper from a test. */
class FakeRequest {
	method = "";
	url = "";
	headers: Record<string, string> = {};
	withCredentials = false;
	status = 0;
	responseText = "";
	sent: unknown = undefined;
	aborted = false;
	upload: {
		onprogress: ((event: { loaded: number }) => void) | null;
		onload: (() => void) | null;
	} = { onprogress: null, onload: null };
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	ontimeout: (() => void) | null = null;
	onabort: (() => void) | null = null;
	open(method: string, url: string) {
		this.method = method;
		this.url = url;
	}
	setRequestHeader(name: string, value: string) {
		this.headers[name] = value;
	}
	send(body: unknown) {
		this.sent = body;
	}
	abort() {
		this.aborted = true;
		this.onabort?.();
	}
	respond(status: number, body: unknown) {
		this.status = status;
		this.responseText = JSON.stringify(body);
		this.onload?.();
	}
}

const staged = {
	id: "abc",
	fileName: "Book.epub",
	size: 10,
	receivedBytes: 10,
	expiresAt: "2026-10-31T12:00:00Z",
	book: null,
};

const start = (signal?: AbortSignal) => {
	const xhr = new FakeRequest();
	const progress: number[] = [];
	let sent = false;
	const response = sendUploadChunk(
		{
			url: "https://citadel.test/api/uploads/abc/content",
			offset: 4,
			body: new Blob(["abcdef"]),
			signal,
			onProgress: (bytes) => progress.push(bytes),
			onSent: () => {
				sent = true;
			},
		},
		() => xhr as unknown as XMLHttpRequest,
	);
	return { xhr, progress, response, wasSent: () => sent };
};

describe("sendUploadChunk", () => {
	it("patches the chunk at its offset and reports progress", async () => {
		const { xhr, progress, response, wasSent } = start();
		expect(xhr.method).toBe("PATCH");
		expect(xhr.url).toBe("https://citadel.test/api/uploads/abc/content");
		expect(xhr.headers).toEqual({
			"Upload-Offset": "4",
			"Content-Type": "application/octet-stream",
		});
		expect(xhr.withCredentials).toBe(true);
		expect(xhr.sent).toBeInstanceOf(Blob);
		xhr.upload.onprogress?.({ loaded: 3 });
		xhr.upload.onprogress?.({ loaded: 6 });
		xhr.upload.onload?.();
		expect(progress).toEqual([3, 6]);
		expect(wasSent()).toBe(true);
		xhr.respond(200, staged);
		expect(await response).toEqual({ kind: "ok", upload: staged });
	});

	it("passes on the server's refusal", async () => {
		const { xhr, response } = start();
		xhr.respond(409, {
			code: "conflict",
			message: "The next chunk starts at byte 2",
		});
		expect(await response).toEqual({
			kind: "rejected",
			status: 409,
			error: { code: "conflict", message: "The next chunk starts at byte 2" },
		});
	});

	it("treats a body that isn't an error as an unexplained refusal", async () => {
		const { xhr, response } = start();
		xhr.status = 502;
		xhr.responseText = "<html>Bad gateway</html>";
		xhr.onload?.();
		expect(await response).toEqual({
			kind: "rejected",
			status: 502,
			error: null,
		});
	});

	it("reports lost connections and timeouts as network failures", async () => {
		const lost = start();
		lost.xhr.onerror?.();
		expect(await lost.response).toEqual({ kind: "network" });
		const slow = start();
		slow.xhr.ontimeout?.();
		expect(await slow.response).toEqual({ kind: "network" });
	});

	it("aborts with its signal, even one aborted before sending", async () => {
		const controller = new AbortController();
		const { xhr, response } = start(controller.signal);
		controller.abort();
		expect(xhr.aborted).toBe(true);
		expect(await response).toEqual({ kind: "aborted" });

		const early = new AbortController();
		early.abort();
		const before = start(early.signal);
		expect(before.xhr.sent).toBeUndefined();
		expect(await before.response).toEqual({ kind: "aborted" });
	});
});
