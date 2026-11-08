import { isRecord } from "@oh-my-pi/web-render";
import { Markdown } from "@oh-my-pi/web-render/Markdown";
import { useEffect, useState, type ReactNode } from "react";
import { records, strings, text, type RecordValue, type SessionClient } from "./client";

export function ThreadView({ client, subagentId }: { client: SessionClient; subagentId: string }): ReactNode {
	const [items, setItems] = useState<RecordValue[] | null>(null);
	const [error, setError] = useState("");
	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			try {
				const result = await client.request({ type: "get_subagent_thread", subagentId });
				if (!isRecord(result.thread) || result.thread.agentId !== subagentId)
					throw new Error("Invalid subagent thread");
				const items = records(result.thread.items);
				if (!cancelled) {
					setItems(items);
					setError("");
				}
			} catch (error) {
				if (!cancelled) setError(String(error));
			}
		};
		void load();
		const timer = setInterval(() => void load(), 5000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [client, subagentId]);
	return (
		<section className="dlg-q" aria-label="Subagent thread">
			{error && <p role="alert">{error}</p>}
			{!items && !error && <p role="status">Loading thread…</p>}
			{items?.length === 0 && <p>No thread items.</p>}
			{items?.map((item, index) => (
				<article key={`${item.entryId ?? item.messageId ?? item.toolCallId ?? item.ts}:${index}`}>
					<b>
						{text(item.kind)}
						{item.from ? ` · ${text(item.from)} → ${text(item.to)}` : ""}
					</b>
					{typeof item.ts === "number" && (
						<time dateTime={new Date(item.ts).toISOString()}> · {new Date(item.ts).toLocaleString()}</time>
					)}
					<Markdown text={item.kind === "ask" ? strings(item.questions).join("\n\n") : text(item.text)} />
					{item.timedOut === true && <p>Answer timed out.</p>}
				</article>
			))}
		</section>
	);
}
