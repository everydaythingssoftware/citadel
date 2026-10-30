import { describe, expect, it } from "vitest";
import { createWebAccountService } from "./web";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});

const info = {
	provider: "hardcover",
	displayName: "Hardcover",
	accountName: "reader",
	createdAt: 1_700_000_000,
	verifiedAt: null,
	needsReentry: false,
};

describe("Web account service", () => {
	it("saves keys through the server and reads back only their description", async () => {
		const requests: Request[] = [];
		const account = createWebAccountService({
			baseUrl: "https://citadel.test",
			fetch: async (request) => {
				requests.push(request.clone());
				if (request.method === "DELETE")
					return json({ code: "notFound", message: "No key" }, 404);
				if (request.method === "PUT") {
					const body = (await request.json()) as { secret: string };
					return body.secret === "bad"
						? json(
								{
									code: "invalidArgument",
									message: "Hardcover didn't accept that API key",
								},
								400,
							)
						: json(info);
				}
				return json([info]);
			},
		});

		const saved = await account.saveProviderCredential("hardcover", "token");
		expect(saved.accountName).toBe("reader");
		expect(saved.createdAt).toEqual(new Date(1_700_000_000_000));
		expect(saved.verifiedAt).toBeNull();
		await expect(
			account.saveProviderCredential("hardcover", "bad"),
		).rejects.toThrow("didn't accept");
		expect(await account.listProviderCredentials()).toHaveLength(1);
		await account.removeProviderCredential("hardcover");

		expect(new URL(requests[0]?.url ?? "").pathname).toBe(
			"/api/account/provider-credentials/hardcover",
		);
		expect(await requests[0]?.json()).toEqual({ secret: "token" });
		expect(requests.at(-1)?.method).toBe("DELETE");
	});
});
