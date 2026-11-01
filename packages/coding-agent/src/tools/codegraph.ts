import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { formatOutputNotice, type OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { OutputSink } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { $which, logger, ptree } from "@oh-my-pi/pi-utils";
import codegraphDescription from "../prompts/tools/codegraph.md" with { type: "text" };
import type { ToolSession } from ".";
import { resolveOutputMaxColumns, resolveOutputSinkArtifactMaxBytes, resolveOutputSinkHeadBytes } from "./output-meta";
import { cfgCodegraphEnabled, cfgCodegraphPath, cfgCodegraphTimeout, cfgToolsArtifactSpillThreshold } from "./settings";
import { ToolAbortError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const codegraphSchema = type({
	op: "'explore' | 'node' | 'search' | 'callers' | 'callees' | 'impact' | 'files'",
	"query?": type("string").describe("Concept, symbol, or file name. Required except for files and node."),
	"file?": type("string").describe("node only: file to read, or file that disambiguates a symbol"),
	"offset?": type("number.integer > 0").describe("node file mode: first line, 1-based"),
	"limit?": type("number.integer > 0").describe("node file mode: maximum lines"),
	"maxFiles?": type("number.integer > 0").describe("explore only: maximum files with source"),
});

export class CodegraphTool implements AgentTool<typeof codegraphSchema, { meta?: OutputMeta }> {
	readonly name = "codegraph";
	readonly label = "Codegraph";
	readonly approval = "read";
	readonly summary = "Query code structure, source, call paths, and blast radius";
	readonly description = codegraphDescription;
	readonly parameters = codegraphSchema;
	readonly strict = true;

	constructor(
		private readonly session: ToolSession,
		private readonly executable: string,
		private readonly root: string,
	) {}

	static async createIf(session: ToolSession): Promise<CodegraphTool | null> {
		if (!cfgCodegraphEnabled.get(session.settings)) return null;
		const info = vcs.gitInfo(session.cwd);
		const candidate = info ? path.dirname(info.commonDir) : session.cwd;
		if (!(await Bun.file(path.join(candidate, ".codegraph", "codegraph.db")).exists())) return null;
		const root = await fs.realpath(candidate);
		const executable = $which(cfgCodegraphPath.get(session.settings), { cwd: session.cwd });
		if (!executable) {
			logger.warn("Codegraph unavailable: CLI missing from PATH or codegraph.path.");
			return null;
		}
		return new CodegraphTool(session, executable, root);
	}

	async execute(
		_toolCallId: string,
		params: typeof codegraphSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<{ meta?: OutputMeta }>> {
		throwIfAborted(signal);
		const query = params.query?.trim();
		if (!query && params.op !== "files" && params.op !== "node") {
			throw new ToolError(`${params.op} requires a non-empty query.`);
		}
		if (
			params.op !== "node" &&
			(params.file !== undefined || params.offset !== undefined || params.limit !== undefined)
		) {
			throw new ToolError("file, offset, and limit require op=node.");
		}
		if (params.maxFiles !== undefined && params.op !== "explore") {
			throw new ToolError("maxFiles requires op=explore.");
		}
		const args = [this.executable, params.op === "search" ? "query" : params.op, "-p", this.root];
		if (params.maxFiles !== undefined) args.push("--max-files", String(params.maxFiles));
		if (params.file !== undefined) args.push("--file", params.file);
		if (params.offset !== undefined) args.push("--offset", String(params.offset));
		if (params.limit !== undefined) args.push("--limit", String(params.limit));
		// End option parsing so a query cannot become a CLI flag.
		if (query) args.push("--", query);
		const artifact = await this.session.allocateOutputArtifact?.("codegraph");
		const sink = new OutputSink({
			artifactPath: artifact?.path,
			artifactId: artifact?.id,
			spillThreshold: cfgToolsArtifactSpillThreshold.get(this.session.settings) * 1024,
			headBytes: resolveOutputSinkHeadBytes(this.session.settings),
			artifactMaxBytes: resolveOutputSinkArtifactMaxBytes(this.session.settings),
			maxColumns: resolveOutputMaxColumns(this.session.settings),
		});
		const timeout = cfgCodegraphTimeout.get(this.session.settings);
		const timeoutSignal = AbortSignal.timeout(Math.max(1, timeout * 1000));
		const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		try {
			using child = ptree.spawn(args, { cwd: this.session.cwd, signal: combined, detached: true });
			const decoder = new TextDecoder();
			const [output, exit] = await Promise.allSettled([
				child.stdout.pipeTo(
					new WritableStream<Uint8Array>({
						write: chunk => {
							sink.push(decoder.decode(chunk, { stream: true }));
						},
					}),
					{ signal: combined },
				),
				child.exited,
			]);
			const status = await child.wait({ allowNonZero: true, allowAbort: true });
			sink.push(decoder.decode());
			const summary = await sink.dump();
			const result = toolResult()
				.text(summary.output)
				.truncationFromSummary(summary, { direction: "middle" })
				.done();
			const text = summary.output + formatOutputNotice(result.details?.meta);
			if (signal?.aborted) throw new ToolAbortError();
			if (timeoutSignal.aborted) throw new ToolError(`Codegraph timed out after ${timeout}s.\n${text}`);
			if (exit.status === "rejected") throw exit.reason;
			if (exit.value !== 0)
				throw new ToolError(`Codegraph exited with code ${exit.value}:\n${status.stderr}\n${text}`);
			if (output.status === "rejected") throw output.reason;
			return result;
		} catch (error) {
			await sink.dump();
			if (error instanceof ToolError || error instanceof ToolAbortError) throw error;
			throw new ToolError(`Codegraph failed: ${error instanceof Error ? error.message : String(error)}`, {
				cause: error,
			});
		}
	}
}
