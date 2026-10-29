import ts from "typescript";

export const commandsByAdapter: Record<string, readonly string[]> = {
	"src/lib/services/library/tauri.ts": [
		"clbCmdCreateAuthors",
		"clbQueryBooks",
		"clbQuerySearchBooks",
		"clbCmdEnsureCoverThumbnails",
		"clbQueryListCoverThumbnails",
		"clbCmdWarmCoverThumbnails",
		"clbQueryGetBook",
		"clbQueryListAllAuthors",
		"clbQueryListSeries",
		"clbQueryListTags",
		"clbQueryListPublishers",
		"clbCmdUpdateBook",
		"clbCmdUpdateAuthor",
		"clbCmdDeleteAuthor",
		"clbCmdDeleteBooks",
		"clbCmdUpsertBookIdentifier",
		"clbCmdDeleteBookIdentifier",
		"clbQueryIsFileImportable",
		"clbQueryImportableFileMetadata",
		"clbCmdCreateBook",
		"clbQueryListAllFiletypes",
		"clbQueryListCustomColumns",
		"clbQueryGetCustomValuesForBook",
		"clbCmdSetCustomValue",
		"clbCmdAddBookGenres",
		"clbCmdSetBookCoverFromUrl",
	],
	"src/lib/services/library-catalog/tauri.ts": [
		"initClient",
		"clbCmdCreateLibrary",
		"clbQueryIsPathValidLibrary",
		"clbQueryDetectCalibreLibrary",
		"clbQueryDefaultNewLibraryPath",
		"clbQueryLibraryStats",
		"clbQueryPathSyncStatus",
		"clbQueryLibraries",
		"clbCmdRegisterLibrary",
		"clbCmdRenameLibrary",
		"clbCmdImportLegacyLibraries",
	],
	"src/lib/services/metadata/tauri.ts": [
		"clbQueryMetadataSearch",
		"clbQueryMetadataByIsbn",
		"clbCmdTestMetadataProvider",
	],
	"src/lib/services/opds/tauri.ts": [
		"clbQueryOpdsStatus",
		"clbCmdStartOpds",
		"clbCmdStopOpds",
		"clbCmdReconfigureOpds",
		"clbQueryOpdsCredentialStatus",
		"clbQueryOpdsCredentialSecret",
		"clbCmdConfigureOpdsCredentials",
		"clbCmdGenerateOpdsCredentials",
		"clbCmdClearOpdsCredentials",
	],
	"src/lib/platform/window/tauri.ts": ["clbCmdOpenSettings"],
	"src/lib/platform/recovery/tauri.ts": [
		"clbQueryDatabaseProblem",
		"clbQueryDatabaseRestored",
		"clbCmdRecoverDatabase",
	],
	"src/lib/platform/updates/tauri.ts": [
		"clbQuerySoftwareUpdate",
		"clbCmdCheckForUpdates",
		"clbCmdUpdateLater",
		"clbCmdUpdateNow",
		"clbCmdOpenSoftwareUpdate",
	],
};

/** Generated tauri-specta events, owned like commands. */
export const eventsByAdapter: Record<string, readonly string[]> = {
	"src/lib/services/library-catalog/tauri.ts": ["librariesChanged"],
	"src/lib/platform/updates/tauri.ts": [
		"softwareUpdateChanged",
		"showSoftwareUpdate",
	],
};

function resolve(file: string, specifier: string): string {
	const resolved = specifier.startsWith("@/")
		? `src/${specifier.slice(2)}`
		: specifier.startsWith("$lib/")
			? `src/lib/${specifier.slice(5)}`
			: specifier.startsWith(".")
				? new URL(specifier, `https://modules.invalid/${file}`).pathname.slice(
						1,
					)
				: specifier;
	return resolved.replace(/\.[cm]?[jt]sx?$/, "");
}

/** Inspect imports structurally so aliases, mixed type imports and re-exports cannot bypass the boundary. */
export function checkServiceBoundaries(file: string, text: string): string[] {
	if (file === "src/bindings.ts" || /\.(test|stories)\.[jt]sx?$/.test(file))
		return [];
	const source = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	);
	const errors: string[] = [];
	const commandAliases = new Set<string>();
	const eventAliases = new Set<string>();
	const allowed = commandsByAdapter[file];
	const allowedEvents = eventsByAdapter[file];
	const nativeAdapter =
		file.startsWith("src/lib/platform/") &&
		(file.endsWith("/tauri.ts") || file.endsWith("/runtime.ts"));
	const diagnostic = (node: ts.Node, message: string) => {
		const { line } = source.getLineAndCharacterOfPosition(
			node.getStart(source),
		);
		errors.push(`${file}:${line + 1}: ${message}`);
	};
	const module = (node: ts.Node, specifier: string, typeOnly: boolean) => {
		if (typeOnly) return;
		const resolved = resolve(file, specifier);
		if (resolved === "src/bindings" && !allowed)
			diagnostic(
				node,
				"Runtime bindings belong in an owning service adapter; import contract types with import type.",
			);
		if (specifier.startsWith("@tauri-apps/") && !nativeAdapter)
			diagnostic(node, "Native runtime APIs belong in Platform adapters.");
		if (
			!file.startsWith("src/lib/services/") &&
			!file.startsWith("src/lib/platform/") &&
			(resolved.includes("/_internal/") ||
				/src\/lib\/(services|platform)\/.*\/tauri$/.test(resolved))
		) {
			diagnostic(
				node,
				"Consume the public service interface, not its transport adapter.",
			);
		}
	};
	const visit = (node: ts.Node) => {
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const clause = node.importClause;
			const named = clause?.namedBindings;
			const typeOnly = Boolean(
				clause?.isTypeOnly ||
					(named &&
						ts.isNamedImports(named) &&
						named.elements.length > 0 &&
						named.elements.every((x) => x.isTypeOnly)),
			);
			module(node, node.moduleSpecifier.text, typeOnly);
			if (
				!typeOnly &&
				resolve(file, node.moduleSpecifier.text) === "src/bindings"
			) {
				if (named && ts.isNamedImports(named)) {
					for (const item of named.elements) {
						const imported = item.propertyName?.text ?? item.name.text;
						if (imported === "commands") commandAliases.add(item.name.text);
						else if (imported === "events" && allowedEvents)
							eventAliases.add(item.name.text);
						else if (!item.isTypeOnly)
							diagnostic(
								item,
								"Only commands (and owned events) may be imported at runtime from generated bindings.",
							);
					}
				} else
					diagnostic(
						node,
						"Use an explicit commands import in an owning adapter.",
					);
			}
		}
		if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const typeOnly =
				node.isTypeOnly ||
				Boolean(
					node.exportClause &&
						ts.isNamedExports(node.exportClause) &&
						node.exportClause.elements.every((x) => x.isTypeOnly),
				);
			module(node, node.moduleSpecifier.text, typeOnly);
			if (
				!typeOnly &&
				/\/tauri$/.test(resolve(file, node.moduleSpecifier.text))
			) {
				diagnostic(
					node,
					"Keep transport adapters private; expose a service interface or factory.",
				);
			}
		}
		if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference)
		) {
			const specifier = node.moduleReference.expression;
			if (specifier && ts.isStringLiteral(specifier))
				module(node, specifier.text, node.isTypeOnly);
		}
		if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) &&
					node.expression.text === "require"))
		) {
			const specifier = node.arguments[0];
			if (specifier && ts.isStringLiteral(specifier)) {
				module(node, specifier.text, false);
				if (resolve(file, specifier.text) === "src/bindings")
					diagnostic(
						node,
						"Use an explicit commands import in an owning adapter.",
					);
			}
		}
		if (
			ts.isPropertyAccessExpression(node) &&
			ts.isIdentifier(node.expression) &&
			commandAliases.has(node.expression.text) &&
			!allowed?.includes(node.name.text)
		) {
			diagnostic(
				node,
				`Command ${node.name.text} belongs to a different service boundary.`,
			);
		}
		if (
			ts.isPropertyAccessExpression(node) &&
			ts.isIdentifier(node.expression) &&
			eventAliases.has(node.expression.text) &&
			!allowedEvents?.includes(node.name.text)
		) {
			diagnostic(
				node,
				`Event ${node.name.text} belongs to a different service boundary.`,
			);
		}
		if (
			ts.isElementAccessExpression(node) &&
			ts.isIdentifier(node.expression) &&
			(commandAliases.has(node.expression.text) ||
				eventAliases.has(node.expression.text))
		) {
			const key = node.argumentExpression;
			if (!ts.isStringLiteral(key) || !allowed?.includes(key.text))
				diagnostic(
					node,
					"Command access must name an operation owned by this adapter.",
				);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return errors;
}
