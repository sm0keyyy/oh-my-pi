import { isRecord } from "@oh-my-pi/web-render";
import * as path from "node:path";
import { ts } from "ts-morph";

const root = path.resolve(import.meta.dir, "../../..");
const definitions: Array<[string, string[]]> = [
	["packages/catalog/src/effort.ts", ["Effort"]],
	["packages/agent/src/thinking.ts", ["ThinkingLevel"]],
	["packages/ai/src/types.ts", ["ProviderFileReference", "ImageContent"]],
	["packages/coding-agent/src/modes/rpc/wire/rpc-wire.generated.ts", ["TodoStatus", "TodoItem", "TodoPhase"]],
	["packages/coding-agent/src/session/cache-warmer.ts", ["CacheWarmingMode"]],
	["packages/coding-agent/src/modes/rpc/rpc-goal.ts", ["RpcGoalOp"]],
	[
		"packages/coding-agent/src/modes/rpc/rpc-types.ts",
		["RpcMessageUpdates", "RpcSubagentSubscriptionLevel", "RpcCommand", "RpcExtensionUIResponse"],
	],
];
const printer = ts.createPrinter({ removeComments: true });
let output = "// Generated from the TUI input contracts by scripts/command-contract.ts.\n";
const commandNames: string[] = [];
for (const [file, names] of definitions) {
	const source = ts.createSourceFile(file, await Bun.file(path.join(root, file)).text(), ts.ScriptTarget.Latest, true);
	for (const statement of source.statements) {
		const name =
			ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isEnumDeclaration(statement)
				? statement.name.text
				: ts.isVariableStatement(statement) && ts.isIdentifier(statement.declarationList.declarations[0]?.name)
					? statement.declarationList.declarations[0].name.text
					: "";
		if (!names.includes(name)) continue;
		if (ts.isTypeAliasDeclaration(statement) && name === "RpcCommand" && ts.isUnionTypeNode(statement.type)) {
			const types = statement.type.types.filter(
				node =>
					!node.getText(source).includes('type: "set_host_tools"') &&
					!node.getText(source).includes('type: "set_host_uri_schemes"'),
			);
			for (const node of types) {
				if (!ts.isTypeLiteralNode(node)) throw new Error("Expected a literal RPC command type");
				const discriminator = node.members.find(
					member => ts.isPropertySignature(member) && member.name.getText(source) === "type",
				);
				if (
					!discriminator ||
					!ts.isPropertySignature(discriminator) ||
					!discriminator.type ||
					!ts.isLiteralTypeNode(discriminator.type) ||
					!ts.isStringLiteral(discriminator.type.literal)
				)
					throw new Error("Expected an RPC command discriminator");
				commandNames.push(discriminator.type.literal.text);
			}
			output +=
				printer.printNode(
					ts.EmitHint.Unspecified,
					ts.factory.updateTypeAliasDeclaration(
						statement,
						statement.modifiers,
						statement.name,
						statement.typeParameters,
						ts.factory.createUnionTypeNode(types),
					),
					source,
				) + "\n";
		} else output += printer.printNode(ts.EmitHint.Unspecified, statement, source) + "\n";
	}
}
const terminalCommands: Array<{ name: string; description: string; source: string }> = [];
for (const basename of ["modes", "collaboration", "session", "lifecycle", "marketplace", "skills", "control"]) {
	const file = path.join(root, `packages/coding-agent/src/slash-commands/builtin-${basename}.ts`);
	const source = ts.createSourceFile(file, await Bun.file(file).text(), ts.ScriptTarget.Latest, true);
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (!declaration.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) continue;
			for (const node of declaration.initializer.elements) {
				if (!ts.isObjectLiteralExpression(node)) continue;
				const properties = node.properties;
				if (
					!properties.some(property => property.name?.getText(source) === "handleTui") ||
					properties.some(property => property.name?.getText(source) === "handle")
				)
					continue;
				const name = properties.find(property => property.name?.getText(source) === "name");
				const description = properties.find(property => property.name?.getText(source) === "description");
				if (!name || !description || !ts.isPropertyAssignment(name) || !ts.isStringLiteralLike(name.initializer))
					throw new Error(`Missing terminal command metadata: ${file}`);
				let label: string;
				if (ts.isPropertyAssignment(description) && ts.isStringLiteralLike(description.initializer))
					label = description.initializer.text;
				else if (ts.isGetAccessorDeclaration(description)) {
					const returned = description.body?.statements.find(ts.isReturnStatement)?.expression;
					if (!returned || !ts.isTemplateExpression(returned))
						throw new Error(`Unsupported terminal description: ${file}`);
					// Getter descriptions carry terminal key hints; the first sentence is static.
					label = returned.head.text.split(". ")[0] ?? returned.head.text;
				} else throw new Error(`Unsupported terminal description: ${file}`);
				terminalCommands.push({ name: name.initializer.text, description: label, source: "builtin" });
			}
		}
	}
}
output += `export const terminalCommands = ${JSON.stringify(terminalCommands, null, 2)} as const;\n`;
const filename = path.join(root, "packages/sessions-web/src/commands.ts");
const formatted = Bun.spawnSync(
	[process.execPath, path.join(root, "node_modules/.bin/oxfmt"), "--stdin-filepath", filename],
	{ cwd: root, stdin: Buffer.from(output), stdout: "pipe", stderr: "pipe", timeout: 10000 },
);
if (formatted.exitCode !== 0) throw new Error(`Browser contract formatting failed: ${formatted.stderr.toString()}`);
output = formatted.stdout.toString();
if (process.argv.includes("--check")) {
	const current = ts.createSourceFile(filename, await Bun.file(filename).text(), ts.ScriptTarget.Latest, true);
	const expected = ts.createSourceFile(filename, output, ts.ScriptTarget.Latest, true);
	const shape = (node: ts.Node): unknown => {
		if (ts.isParenthesizedTypeNode(node) || ts.isParenthesizedExpression(node))
			return shape(ts.isParenthesizedTypeNode(node) ? node.type : node.expression);
		if (
			(ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
			node.parent &&
			(ts.isPropertyAssignment(node.parent) || ts.isPropertySignature(node.parent)) &&
			node.parent.name === node
		)
			return ["property_name", node.text];
		const children: unknown[] = [];
		ts.forEachChild(node, child => {
			children.push(shape(child));
		});
		return [
			node.kind,
			ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ? node.text : null,
			children,
		];
	};
	const actualShape = JSON.stringify(shape(current));
	const expectedShape = JSON.stringify(shape(expected));
	if (actualShape !== expectedShape) {
		let index = 0;
		while (actualShape[index] === expectedShape[index]) index++;
		throw new Error(
			`Browser RPC input contracts drifted at ${index}: ${actualShape.slice(index - 80, index + 160)} != ${expectedShape.slice(index - 80, index + 160)}. Run bun scripts/command-contract.ts.`,
		);
	}
	const checklist: unknown = await Bun.file(path.join(root, "packages/sessions-web/evidence/checklist.json")).json();
	if (!isRecord(checklist) || !Array.isArray(checklist.rows) || !checklist.rows.every(isRecord))
		throw new Error("Invalid D2 command checklist");
	const covered = checklist.rows.map(row => row.command);
	const missing = commandNames.filter(name => !covered.includes(name));
	const extra = covered.filter(name => typeof name !== "string" || !commandNames.includes(name));
	if (
		checklist.allowed !== commandNames.length ||
		covered.length !== commandNames.length ||
		new Set(covered).size !== covered.length ||
		missing.length ||
		extra.length
	)
		throw new Error(
			`D2 command checklist drifted: ${JSON.stringify({ expected: commandNames.length, missing, extra })}`,
		);
} else await Bun.write(filename, output);
