import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { messageOf, SessionClient } from "../src/client";
import { Transcript } from "../src/transcript";

const baseline = new SessionClient(
	"0123456789abcdef",
	"http://127.0.0.1/events/session/0123456789abcdef",
).getSnapshot();
const boilerplate = "<irc>Incoming prompt template. If response expected, reply via write...</irc>";
const cases: Array<{ type: string; details: Record<string, unknown>; content?: string; expected: string[] }> = [
	{
		type: "irc:incoming",
		details: { from: "Fixer", message: '{"risk":"Check output"}', replyTo: "Main", progress: true },
		expected: ["Fixer", "reply to Main", "progress", "JSON message", "Check output"],
	},
	{
		type: "irc:autoreply",
		details: { from: "Planner", to: "Main", body: "Received the update" },
		expected: ["Planner", "autoreply", "to Main", "Received the update"],
	},
	{
		type: "irc:relay",
		details: { from: "Builder", body: "Completed the relay", wakeRelay: true },
		expected: ["Builder", "relay", "wake relay", "Completed the relay"],
	},
	{
		type: "irc:workpool",
		details: { pool: "workers", mode: "claimed", body: { task: "Done" } },
		expected: ["Workpool", "workers", "claimed", "JSON message", "Done"],
	},
	{
		type: "async-result",
		details: { jobs: [{ jobId: "bg_1", type: "bash", label: "Check build", durationMs: 42 }] },
		expected: ["Background job completed", "bg_1", "bash", "Check build", "42 ms"],
	},
	{
		type: "launch-completion",
		details: { daemons: [{ name: "worker", state: "failed", exitCode: 7 }] },
		expected: ["Supervised process", "worker", "failed", "exit 7"],
	},
	{
		type: "lsp-late-diagnostic",
		details: { files: [{ path: "src/a.ts", summary: "1 error", errored: true, messages: ["Missing name"] }] },
		expected: ["LSP diagnostics", "src/a.ts", "1 error", "Missing name"],
	},
	{
		type: "collab-prompt",
		details: { from: "Guest author" },
		content: "Collaborator question",
		expected: ["Guest author", "collaborator", "Collaborator question"],
	},
	{
		type: "skill-prompt",
		details: { name: "review", path: "/skills/review/SKILL.md", args: "Inspect change", lineCount: 12 },
		content: "Loaded skill content",
		expected: ["Skill: review", "12 lines", "Inspect change", "Loaded skill prompt", "Loaded skill content"],
	},
	{
		type: "advisor",
		details: {
			notes: [{ advisor: "Security", severity: "blocker", turnsAgo: 3, note: "Keep verification enabled" }],
		},
		expected: ["Advisor", "Security", "blocker", "3 turns ago", "Keep verification enabled"],
	},
	{
		type: "background-tan-dispatch",
		details: { jobId: "bg_tangent", work: "Check transport" },
		expected: ["Tangent dispatched", "bg_tangent", "Check transport"],
	},
	{
		type: "handoff",
		details: {},
		content: "Outer boilerplate<handoff-context>Only handoff context</handoff-context>Outer footer",
		expected: ["Handed off", "Handoff context", "Only handoff context"],
	},
];

for (const entry of cases)
	test(`renders ${entry.type} as a structured transcript card`, () => {
		const message = messageOf(
			{
				role: "custom",
				customType: entry.type,
				display: true,
				details: entry.details,
				content: entry.content ?? boilerplate,
				timestamp: 1,
			},
			"fixture",
		);
		const html = renderToStaticMarkup(<Transcript snapshot={{ ...baseline, messages: [message] }} host={{}} />);
		expect(html).toContain(`data-custom-type="${entry.type}"`);
		for (const expected of entry.expected) expect(html).toContain(expected);
		expect(html).not.toContain("Incoming prompt template");
		expect(html).not.toContain("If response expected");
		expect(html).not.toContain("Outer boilerplate");
		expect(html).not.toContain("Outer footer");
		expect(html).not.toContain('class="entry-who">system');
	});

test("keeps raw rendering only for unknown custom types and hides nondisplayed messages", () => {
	const unknown = messageOf(
		{ role: "custom", customType: "extension:unknown", display: true, content: "Unknown custom text" },
		"unknown",
	);
	expect(renderToStaticMarkup(<Transcript snapshot={{ ...baseline, messages: [unknown] }} host={{}} />)).toContain(
		"Unknown custom text",
	);
	const hidden = { ...unknown, display: false, content: "Hidden model-only instructions" };
	expect(renderToStaticMarkup(<Transcript snapshot={{ ...baseline, messages: [hidden] }} host={{}} />)).not.toContain(
		"Hidden model-only instructions",
	);
});

test("escapes untrusted structured IRC content instead of creating executable markup", () => {
	const message = messageOf(
		{
			role: "custom",
			customType: "irc:incoming",
			display: true,
			details: { from: '<img onerror="attack">', message: '{"html":"<script>attack()</script>"}' },
			content: boilerplate,
		},
		"untrusted",
	);
	const html = renderToStaticMarkup(<Transcript snapshot={{ ...baseline, messages: [message] }} host={{}} />);
	expect(html).not.toContain("<script>");
	expect(html).not.toContain("<img");
	expect(html).toContain("&lt;script&gt;");
});
