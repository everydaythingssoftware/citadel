import { describe, expect, it } from "vitest";
import {
	INITIAL_SERVER_BUILD_WATCH,
	observeServerBuild,
	type ServerBuildWatch,
} from "./server-build";

const run = (builds: (string | null)[]) => {
	let watch: ServerBuildWatch = INITIAL_SERVER_BUILD_WATCH;
	const announced: string[] = [];
	for (const build of builds) {
		const next = observeServerBuild(watch, build);
		watch = next.watch;
		if (next.announce) announced.push(next.announce);
	}
	return announced;
};

describe("observeServerBuild", () => {
	it("takes the first build it hears as the page's own", () => {
		expect(run(["0.8.0+abc", "0.8.0+abc"])).toEqual([]);
	});

	it("announces a changed build once", () => {
		expect(run(["0.8.0+abc", "0.8.1+def", "0.8.1+def", "0.8.1+def"])).toEqual([
			"0.8.1+def",
		]);
	});

	it("announces each later build again", () => {
		expect(run(["0.8.0+abc", "0.8.1+def", "0.8.2+123"])).toEqual([
			"0.8.1+def",
			"0.8.2+123",
		]);
	});

	it("ignores responses without the header", () => {
		expect(run([null, "0.8.0+abc", null, "", "0.8.0+abc"])).toEqual([]);
	});

	it("does not announce going back to the page's own build", () => {
		expect(run(["0.8.0+abc", "0.8.1+def", "0.8.0+abc"])).toEqual(["0.8.1+def"]);
	});
});
