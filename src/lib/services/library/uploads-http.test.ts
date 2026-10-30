import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpLibrary } from "./http";
import { UploadError, UploadFailure } from "./types";

const json = (data: unknown, status = 200) =>
	new Response(status === 204 ? null : JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});

const staged = {
	id: "abc",
	fileName: "Book.epub",
	size: 6,
	receivedBytes: 0,
	expiresAt: "2026-10-31T12:00:00Z",
	book: null,
};

const library = (fetch: (request: Request) => Promise<Response>) =>
	createHttpLibrary({ baseUrl: "https://citadel.test", fetch }, { writable: true });

const uploadsOf = (fetch: (request: Request) => Promise<Response>) => {
	const uploads = library(fetch).uploads;
	if (!uploads) throw new Error("expected uploads");
	return uploads;
};

/** A stand-in XMLHttpRequest that answers each send with the next response. */
const stubRequests = (responses: { status: number; body: unknown }[]) => {
	const sent: { url: string; headers: Record<string, string> }[] = [];
	class Request {
		url = "";
		headers: Record<string, string> = {};
		status = 0;
		responseText = "";
		withCredentials = false;
		upload = { onprogress: null, onload: null };
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		onabort: (() => void) | null = null;
		ontimeout: (() => void) | null = null;
		open(_method: string, url: string) {
			this.url = url;
		}
		setRequestHeader(name: string, value: string) {
			this.headers[name] = value;
		}
		send() {
			sent.push({ url: this.url, headers: this.headers });
			const next = responses.shift();
			queueMicrotask(() => {
				if (!next) return this.onerror?.();
				this.status = next.status;
				this.responseText = JSON.stringify(next.body);
				this.onload?.();
			});
		}
		abort() {}
	}
	vi.stubGlobal("XMLHttpRequest", Request);
	return sent;
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("HTTP uploads", () => {
	it("is offered only for a library the server opened for writing", () => {
		const fetch = async () => json({});
		expect(createHttpLibrary({ baseUrl: "https://citadel.test", fetch }).uploads).toBeUndefined();
		expect(library(fetch).uploads).toBeDefined();
		expect(library(fetch).readOnly).toBe(true);
	});

	it("lists limits and uploads, starts, checks and cancels uploads", async () => {
		const requests: Request[] = [];
		const uploads = uploadsOf(async (request) => {
			requests.push(request);
			if (request.method === "DELETE") return json(null, 204);
			if (request.method === "POST") return json(staged, 201);
			return request.url.endsWith("/api/uploads")
				? json({
						maxFileBytes: 100,
						chunkBytes: 10,
						reviewSeconds: 86400,
						uploads: [staged],
					})
				: json(staged);
		});
		expect(await uploads.list()).toEqual({
			limits: { maxFileBytes: 100, chunkBytes: 10, reviewSeconds: 86400 },
			uploads: [staged],
		});
		expect(await uploads.create({ name: "Book.epub", size: 6 })).toEqual(staged);
		expect(await requests[1]?.json()).toEqual({ fileName: "Book.epub", size: 6 });
		expect(await uploads.status("abc")).toEqual(staged);
		expect(requests[2]?.url).toBe("https://citadel.test/api/uploads/abc");
		await uploads.cancel("abc");
		expect(requests[3]?.method).toBe("DELETE");
		expect(uploads.coverUrl("abc")).toBe("https://citadel.test/api/uploads/abc/cover");
	});

	it("treats cancelling an upload that's already gone as done", async () => {
		const uploads = uploadsOf(async () =>
			json({ code: "notFound", message: "Upload not found" }, 404),
		);
		await expect(uploads.cancel("abc")).resolves.toBeUndefined();
	});

	it("commits the reviewed book and resolves its asset URLs", async () => {
		let body: unknown;
		const uploads = uploadsOf(async (request) => {
			body = await request.json();
			return json(
				{
					id: "9",
					uuid: null,
					title: "Reviewed",
					author_list: [],
					tag_list: [],
					sortable_title: null,
					file_list: [],
					cover_image: { kind: "Remote", local_path: null, url: "/api/books/9/cover" },
					identifier_list: [],
					description: null,
					is_read: false,
					series: null,
					series_index: null,
					language_list: [],
				},
				201,
			);
		});
		const book = await uploads.commit("abc", { title: "Reviewed", authorNames: ["A"] });
		expect(body).toEqual({ title: "Reviewed", authorNames: ["A"] });
		expect(book.cover_image?.url).toBe("https://citadel.test/api/books/9/cover");
	});

	it("maps refusals to upload failures callers can act on", async () => {
		const failing = (status: number, code: string) =>
			uploadsOf(async () => json({ code, message: `${code} happened` }, status));
		const cases = [
			[409, "conflict", UploadFailure.conflict],
			[413, "tooLarge", UploadFailure.tooLarge],
			[507, "storageFull", UploadFailure.storageFull],
			[401, "unauthorized", UploadFailure.unauthorized],
			[403, "readOnly", UploadFailure.readOnly],
			[400, "invalidArgument", UploadFailure.invalid],
			[503, "unavailable", UploadFailure.network],
		] as const;
		for (const [status, code, failure] of cases) {
			await expect(failing(status, code).create({ name: "a.epub", size: 1 })).rejects.toEqual(
				new UploadError(failure, `${code} happened`),
			);
		}
		const unreachable = uploadsOf(async () => {
			throw new TypeError("Failed to fetch");
		});
		await expect(unreachable.status("abc")).rejects.toMatchObject({
			failure: UploadFailure.network,
		});
	});

	it("sends chunks with their offset and maps chunk failures", async () => {
		const sent = stubRequests([
			{ status: 200, body: { ...staged, receivedBytes: 6 } },
			{ status: 409, body: { code: "conflict", message: "The next chunk starts at byte 6" } },
		]);
		const uploads = uploadsOf(async () => json({}));
		const chunk = { uploadId: "a b", offset: 0, body: new Blob(["abcdef"]) };
		expect((await uploads.sendChunk(chunk)).receivedBytes).toBe(6);
		expect(sent[0]).toEqual({
			url: "https://citadel.test/api/uploads/a%20b/content",
			headers: { "Upload-Offset": "0", "Content-Type": "application/octet-stream" },
		});
		await expect(uploads.sendChunk(chunk)).rejects.toMatchObject({
			failure: UploadFailure.conflict,
		});
		await expect(uploads.sendChunk(chunk)).rejects.toMatchObject({
			failure: UploadFailure.network,
		});
	});
});
