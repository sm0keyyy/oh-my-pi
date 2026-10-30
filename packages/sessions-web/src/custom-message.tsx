import { isRecord } from "@oh-my-pi/web-render";
import { Markdown } from "@oh-my-pi/web-render/Markdown";
import type { ReactNode } from "react";
import { messageText, text, type Message } from "./client";

function Body({ value }: { value: unknown }): ReactNode {
	let parsed = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value);
		} catch {
			parsed = value;
		}
	}
	if (isRecord(parsed) || Array.isArray(parsed))
		return (
			<details className="custom-json">
				<summary>JSON message</summary>
				<pre>{JSON.stringify(parsed, null, 2)}</pre>
			</details>
		);
	return <Markdown text={text(value)} />;
}

export function renderCustomMessage(message: Message): ReactNode | undefined {
	if (message.role !== "custom" && message.role !== "hookMessage") return undefined;
	const kind = text(message.customType);
	const details = isRecord(message.details) ? message.details : {};
	let title: string;
	let body: ReactNode;
	let markers: ReactNode;
	switch (kind) {
		case "irc:incoming":
		case "irc:autoreply":
		case "irc:relay":
		case "irc:workpool": {
			title = text(details.from) || (kind === "irc:workpool" ? "Workpool" : "Agent");
			markers = (
				<>
					<span className="chip">{kind.slice(4)}</span>
					{Boolean(details.to) && <span>to {text(details.to)}</span>}
					{Boolean(details.replyTo) && <span>reply to {text(details.replyTo)}</span>}
					{details.progress === true && <span className="chip">progress</span>}
					{details.broadcast === true && <span className="chip">broadcast</span>}
					{details.wakeRelay === true && <span className="chip">wake relay</span>}
					{Boolean(details.pool) && <span>{text(details.pool)}</span>}
					{Boolean(details.mode) && <span>{text(details.mode)}</span>}
				</>
			);
			body = <Body value={kind === "irc:incoming" ? details.message : details.body} />;
			break;
		}
		case "async-result": {
			title = "Background job completed";
			const jobs = Array.isArray(details.jobs) ? details.jobs.filter(isRecord) : [details];
			body = (
				<ul>
					{jobs.map((job, index) => (
						<li key={index}>
							<code>{text(job.jobId) || "unknown"}</code> {text(job.type)} {text(job.label)}
							{typeof job.durationMs === "number" && <span> · {job.durationMs} ms</span>}
							{isRecord(job.meta) && Boolean(job.meta.artifactError) && <Body value={job.meta.artifactError} />}
						</li>
					))}
				</ul>
			);
			break;
		}
		case "launch-completion": {
			title = "Supervised process";
			const daemons = Array.isArray(details.daemons) ? details.daemons.filter(isRecord) : [];
			body = daemons.length ? (
				<ul>
					{daemons.map((daemon, index) => (
						<li key={index}>
							<strong>{text(daemon.name)}</strong>
							{" · "}
							{daemon.state === "failed" || (typeof daemon.exitCode === "number" && daemon.exitCode !== 0)
								? "failed"
								: "completed"}
							{typeof daemon.exitCode === "number" && <span> · exit {daemon.exitCode}</span>}
						</li>
					))}
				</ul>
			) : (
				<Body value={messageText(message.content)} />
			);
			break;
		}
		case "lsp-late-diagnostic": {
			title = "LSP diagnostics";
			const files = Array.isArray(details.files) ? details.files.filter(isRecord) : [];
			body = (
				<ul>
					{files.map((file, index) => (
						<li key={index}>
							<code>{text(file.path)}</code> {text(file.summary)}
							{file.errored === true && <span className="chip chip-err">error</span>}
							{Array.isArray(file.messages) && (
								<ul>
									{file.messages
										.filter((item): item is string => typeof item === "string")
										.map((item, row) => (
											<li key={row}>{item}</li>
										))}
								</ul>
							)}
						</li>
					))}
				</ul>
			);
			break;
		}
		case "collab-prompt":
			title = text(details.from) || "Guest";
			markers = <span className="chip">collaborator</span>;
			body = <Body value={messageText(message.content)} />;
			break;
		case "skill-prompt":
			title = `Skill: ${text(details.name) || "unknown"}`;
			markers = (
				<>
					{typeof details.lineCount === "number" && <span>{details.lineCount} lines</span>}
					<code>{text(details.path)}</code>
				</>
			);
			body = (
				<>
					<Body value={details.prompt ?? details.args} />
					<details>
						<summary>Loaded skill prompt</summary>
						<Body value={messageText(message.content)} />
					</details>
				</>
			);
			break;
		case "advisor": {
			title = "Advisor";
			const notes = Array.isArray(details.notes) ? details.notes.filter(isRecord) : [];
			body = (
				<ul>
					{notes.map((note, index) => (
						<li key={index}>
							{Boolean(note.advisor) && <strong>{text(note.advisor)} </strong>}
							{Boolean(note.severity) && <span className="chip">{text(note.severity)}</span>}
							{typeof note.turnsAgo === "number" && <span> {note.turnsAgo} turns ago</span>}
							<Body value={note.note} />
						</li>
					))}
				</ul>
			);
			break;
		}
		case "background-tan-dispatch":
			title = "Tangent dispatched";
			markers = <code>{text(details.jobId)}</code>;
			body = <Body value={details.work} />;
			break;
		case "handoff": {
			title = "Handed off";
			const content = messageText(message.content);
			const start = content.indexOf("<handoff-context>");
			const document =
				start < 0 ? content : content.slice(start + "<handoff-context>".length).split("</handoff-context>")[0];
			body = (
				<details>
					<summary>Handoff context</summary>
					<Body value={document?.trim()} />
				</details>
			);
			break;
		}
		default:
			return undefined;
	}
	return (
		<section className="custom-card" data-custom-type={kind} aria-label={title}>
			<header>
				<strong>{title}</strong>
				{markers}
			</header>
			<div className="custom-card-body">{body}</div>
		</section>
	);
}
