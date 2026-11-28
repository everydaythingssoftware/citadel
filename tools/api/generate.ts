import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import openapiTS, { astToString } from "openapi-typescript";

const result = spawnSync(
	"cargo",
	[
		"run",
		"--locked",
		"--quiet",
		"-p",
		"citadel-server",
		"--bin",
		"export-openapi",
	],
	{ encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
if (result.status !== 0) process.exit(result.status ?? 1);
const schema = `${JSON.stringify(JSON.parse(result.stdout), null, 2)}\n`;
// The server supplies a default value, so a field with a default stays
// optional for the client that sends it.
const types = astToString(
	await openapiTS(JSON.parse(schema), { defaultNonNullable: false }),
);
const files = {
	"api/openapi.json": schema,
	"src/lib/api/schema.generated.d.ts": types,
};
for (const [path, content] of Object.entries(files)) {
	if (process.argv.includes("--check")) {
		if (readFileSync(path, "utf8") !== content)
			throw new Error(`${path} is stale; run bun api:generate`);
	} else writeFileSync(path, content);
}
