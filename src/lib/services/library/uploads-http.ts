import type { LibraryBook } from "@/bindings";
import type { createCitadelHttpClient } from "@/lib/api/client";
import type { components } from "@/lib/api/schema.generated";
import { sendUploadChunk } from "@/lib/api/upload-chunk";
import {
	type BookUploads,
	UploadError,
	UploadFailure,
	type TUploadFailure,
} from "./types";

type LibraryErrorCode = components["schemas"]["LibraryErrorCode"];

const failureForCode: Partial<Record<LibraryErrorCode, TUploadFailure>> = {
	conflict: UploadFailure.conflict,
	unauthorized: UploadFailure.unauthorized,
	notFound: UploadFailure.notFound,
	tooLarge: UploadFailure.tooLarge,
	storageFull: UploadFailure.storageFull,
	invalidArgument: UploadFailure.invalid,
	readOnly: UploadFailure.readOnly,
	unavailable: UploadFailure.network,
};

const failureForStatus = (status: number): TUploadFailure =>
	status === 401
		? UploadFailure.unauthorized
		: status === 404
			? UploadFailure.notFound
			: status === 409
				? UploadFailure.conflict
				: status === 413
					? UploadFailure.tooLarge
					: status === 507
						? UploadFailure.storageFull
						: status >= 500
							? UploadFailure.server
							: UploadFailure.invalid;

const refusal = (
	status: number,
	error: { code: LibraryErrorCode; message: string } | null | undefined,
): UploadError =>
	new UploadError(
		(error && failureForCode[error.code]) ?? failureForStatus(status),
		error?.message ?? `Upload request failed (${status})`,
	);

const settle = async <T>(
	request: Promise<{
		data?: T;
		error?: { code: LibraryErrorCode; message: string };
		response: Response;
	}>,
): Promise<T> => {
	let result: Awaited<typeof request>;
	try {
		result = await request;
	} catch {
		throw new UploadError(UploadFailure.network, "Couldn't reach the server");
	}
	const { data, error, response } = result;
	if (error || !response.ok || data === undefined)
		throw refusal(response.status, error);
	return data;
};

/** Uploads over the Citadel HTTP API; chunks go through XMLHttpRequest for progress. */
export const createHttpUploads = (
	client: ReturnType<typeof createCitadelHttpClient>,
	baseUrl: string,
	rememberBook: (book: LibraryBook) => LibraryBook,
): BookUploads => {
	const url = (path: string) => new URL(path, baseUrl).toString();
	const path = (uploadId: string) => ({
		params: { path: { upload_id: uploadId } },
	});
	return {
		list: async () => {
			const { uploads, maxFileBytes, chunkBytes, reviewSeconds } = await settle(
				client.GET("/api/uploads"),
			);
			return { limits: { maxFileBytes, chunkBytes, reviewSeconds }, uploads };
		},
		create: ({ name, size }) =>
			settle(client.POST("/api/uploads", { body: { fileName: name, size } })),
		status: (uploadId) =>
			settle(client.GET("/api/uploads/{upload_id}", path(uploadId))),
		sendChunk: async ({ uploadId, ...chunk }) => {
			const response = await sendUploadChunk({
				...chunk,
				url: url(`/api/uploads/${encodeURIComponent(uploadId)}/content`),
			});
			switch (response.kind) {
				case "ok":
					return response.upload;
				case "aborted":
					throw new UploadError(UploadFailure.aborted, "Upload stopped");
				case "network":
					throw new UploadError(
						UploadFailure.network,
						"The connection dropped",
					);
				case "rejected":
					throw refusal(response.status, response.error);
			}
		},
		coverUrl: (uploadId) =>
			url(`/api/uploads/${encodeURIComponent(uploadId)}/cover`),
		commit: async (uploadId, book) =>
			rememberBook(
				(await settle(
					client.POST("/api/uploads/{upload_id}/commit", {
						...path(uploadId),
						body: book,
					}),
				)) as LibraryBook,
			),
		cancel: async (uploadId) => {
			let response: Response;
			let error: { code: LibraryErrorCode; message: string } | undefined;
			try {
				({ response, error } = await client.DELETE(
					"/api/uploads/{upload_id}",
					path(uploadId),
				));
			} catch {
				throw new UploadError(
					UploadFailure.network,
					"Couldn't reach the server",
				);
			}
			// Already gone (expired, or removed in another tab) is cancelled enough.
			if (response.status === 404) return;
			if (error || !response.ok) throw refusal(response.status, error);
		},
	};
};
