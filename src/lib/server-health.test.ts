import { describe, expect, it } from "vitest";
import type { HealthCheck } from "@/lib/services/server";
import { healthCheckLabel, healthChecksInOrder } from "./server-health";

const check = (name: string, status: HealthCheck["status"]): HealthCheck => ({
	name,
	status,
	detail: null,
});

describe("server health", () => {
	it("puts what needs attention first and keeps the rest in order", () => {
		expect(
			healthChecksInOrder([
				check("database", "ok"),
				check("library", "degraded"),
				check("opds", "ok"),
				check("stateDisk", "failing"),
			]).map((each) => each.name),
		).toEqual(["stateDisk", "library", "database", "opds"]);
	});

	it("names checks for people and falls back to the server's name", () => {
		expect(healthCheckLabel(check("opds", "ok"))).toBe("E-readers (OPDS)");
		expect(healthCheckLabel(check("somethingNew", "ok"))).toBe("somethingNew");
	});
});
