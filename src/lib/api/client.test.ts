import { describe, expect, it } from "vitest";
import type { LibraryBook, LibraryBookPage } from "@/bindings";
import {
	createCitadelHttpClient,
	SERVER_UNREACHABLE_MESSAGE,
	ServerUnreachableError,
} from "./client";
import type { components } from "./schema.generated";

type HttpBook = components["schemas"]["LibraryBook"];
type HttpPage = components["schemas"]["LibraryBookPage"];
// Compile-time checks: nullable response fields, tagged unions and IDs must
// remain compatible with the separately generated IPC bindings.
const asIpcBook = (book: HttpBook): LibraryBook => book;
const asHttpBook = (book: LibraryBook): HttpBook => book;
const asIpcPage = (page: HttpPage): LibraryBookPage => page;
const asHttpPage = (page: LibraryBookPage): HttpPage => page;
void [asIpcBook, asHttpBook, asIpcPage, asHttpPage];

function invalidInputs(client: ReturnType<typeof createCitadelHttpClient>) {
	// @ts-expect-error Unknown routes cannot be called.
	void client.GET("/api/unknown");
	void client.POST("/api/books/query", {
		// @ts-expect-error Limits are numbers, not strings.
		body: { limit: "50", offset: 0, hide_read: false, sort: "TitleAsc" },
	});
}
void invalidInputs;

describe("generated HTTP client", () => {
	it("serializes the shared query and returns a typed page", async () => {
		const client = createCitadelHttpClient({
			baseUrl: "https://citadel.test",
			fetch: async (request) => {
				expect(request.url).toBe("https://citadel.test/api/books/query");
				expect(await request.json()).toEqual({
					limit: 50,
					offset: 0,
					hide_read: false,
					sort: "TitleAsc",
				});
				return new Response(JSON.stringify({ items: [], total: 0 }), {
					headers: { "content-type": "application/json" },
				});
			},
		});
		const result = await client.POST("/api/books/query", {
			body: { limit: 50, offset: 0, hide_read: false, sort: "TitleAsc" },
		});
		expect(result.data).toEqual({ items: [], total: 0 });
	});
	it("returns structured application errors", async () => {
		const client = createCitadelHttpClient({
			baseUrl: "https://citadel.test",
			fetch: async () =>
				new Response(
					JSON.stringify({ code: "notFound", message: "Book not found" }),
					{ status: 404, headers: { "content-type": "application/json" } },
				),
		});
		const result = await client.GET("/api/books/{book_id}", {
			params: { path: { book_id: "999" } },
		});
		expect(result.error?.code).toBe("notFound");
	});
});

describe("unreachable server", () => {
	it("explains a failed connection instead of the browser's wording", async () => {
		const client = createCitadelHttpClient({
			baseUrl: "https://citadel.test",
			fetch: async () => {
				throw new TypeError("Load failed");
			},
		});
		const request = client.GET("/api/books/{book_id}", {
			params: { path: { book_id: "1" } },
		});
		await expect(request).rejects.toBeInstanceOf(ServerUnreachableError);
		await expect(request).rejects.toThrow(SERVER_UNREACHABLE_MESSAGE);
	});

	it("leaves cancelled requests as cancellations", async () => {
		const client = createCitadelHttpClient({
			baseUrl: "https://citadel.test",
			fetch: async () => {
				throw new DOMException("Aborted", "AbortError");
			},
		});
		const request = client.GET("/api/books/{book_id}", {
			params: { path: { book_id: "1" } },
		});
		await expect(request).rejects.toMatchObject({ name: "AbortError" });
	});
});
