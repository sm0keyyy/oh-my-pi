import { isRecord, type ToolResultLike } from "@oh-my-pi/web-render";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { records, text, type RecordValue, type SessionClient } from "./client";

export function RunbookCard({
	name,
	result,
	entries,
	client,
}: {
	name: string;
	result?: ToolResultLike;
	entries: readonly RecordValue[];
	client?: SessionClient;
}): ReactNode {
	const [pending, setPending] = useState(false);
	const [status, setStatus] = useState("");
	const [job, setJob] = useState<{ runbookId: string; entryId: string } | null>(null);
	useEffect(() => {
		if (!job) return;
		const latest = entries.findLast(
			entry =>
				entry.type === "custom" &&
				entry.customType === "runbook-run" &&
				isRecord(entry.data) &&
				entry.data.runbookId === job.runbookId,
		);
		if (latest && text(latest.id) !== job.entryId) setJob(null);
	}, [entries, job]);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	let details = result?.details;
	if (isRecord(details) && isRecord(details.xdev) && details.xdev.tool === "runbook") details = details.xdev.inner;
	else if (name !== "runbook") return null;
	if (
		result?.isError ||
		!isRecord(details) ||
		typeof details.runbookId !== "string" ||
		!/^[a-zA-Z0-9-]{1,128}$/.test(details.runbookId) ||
		typeof details.title !== "string" ||
		!Array.isArray(details.steps) ||
		details.steps.length < 1 ||
		details.steps.length > 20 ||
		!details.steps.every(
			step =>
				isRecord(step) &&
				typeof step.title === "string" &&
				typeof step.command === "string" &&
				(step.host === "mac" || step.host === "unraid"),
		)
	)
		return null;
	const id = details.runbookId;
	const steps = records(details.steps);
	const runs = new Map<number, RecordValue>();
	let lastRunEntryId = "";
	for (const entry of entries) {
		if (
			entry.type !== "custom" ||
			entry.customType !== "runbook-run" ||
			!isRecord(entry.data) ||
			entry.data.runbookId !== id ||
			!Array.isArray(entry.data.steps)
		)
			continue;
		lastRunEntryId = text(entry.id);
		for (const run of entry.data.steps) {
			if (
				isRecord(run) &&
				typeof run.n === "number" &&
				Number.isInteger(run.n) &&
				run.n >= 1 &&
				run.n <= steps.length &&
				Number.isInteger(run.exitCode) &&
				typeof run.tail === "string" &&
				run.host === steps[run.n - 1]?.host
			)
				runs.set(run.n, run);
		}
	}
	const run = async (step: number | "all") => {
		if (!client) return;
		setPending(true);
		setStatus("");
		try {
			const outcome = await client.request({ type: "run_runbook_step", runbookId: id, step });
			if (mounted.current) {
				setStatus(
					outcome.ok === true ? `Started job ${text(outcome.jobId)}` : `Run refused: ${text(outcome.reason)}`,
				);
				if (outcome.ok === true) setJob({ runbookId: id, entryId: lastRunEntryId });
			}
			await client.refresh();
		} catch (error) {
			if (mounted.current) setStatus(String(error));
		} finally {
			if (mounted.current) setPending(false);
		}
	};
	return (
		<section className="runbook-card" aria-label={`Runbook ${details.title}`}>
			<strong>{details.title}</strong>
			<ol>
				{steps.map((step, index) => {
					const n = index + 1;
					const result = runs.get(n);
					return (
						<li key={n}>
							<b>{text(step.title)}</b> · {text(step.host)}
							{step.interactive === true ? " · interactive" : ""}
							<pre>{text(step.command)}</pre>
							<p>{result ? `Exit ${result.exitCode}` : "Not run"}</p>
							{result && <pre>{text(result.tail).split(/\r?\n/).slice(-20).join("\n")}</pre>}
							<button
								type="button"
								className="btn"
								disabled={pending || job !== null || !client || client.getSnapshot().phase !== "connected"}
								onClick={() => void run(n)}
							>
								Run step {n}
							</button>
						</li>
					);
				})}
			</ol>
			<button
				type="button"
				className="btn"
				disabled={pending || job !== null || !client || client.getSnapshot().phase !== "connected"}
				onClick={() => void run("all")}
			>
				Run all
			</button>
			{status && <p role="status">{status}</p>}
		</section>
	);
}
