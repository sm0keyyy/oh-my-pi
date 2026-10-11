import { isRecord, shortenPath, type ToolRenderHost } from "@oh-my-pi/web-render";
import { useEffect, useState, type ReactNode } from "react";
import type { RpcCommand, TodoStatus } from "./commands";
import {
	messageOf,
	number,
	records,
	strings,
	text,
	type Message,
	type RecordValue,
	type SessionClient,
	type Snapshot,
} from "./client";
import { Modal } from "./dialogs";
import { Transcript } from "./transcript";

export function Rail({
	client,
	snapshot,
	onModel,
	onThinking,
	onRefresh,
	host,
	selectedAgentId,
	onAgentClose,
}: {
	client: SessionClient;
	snapshot: Snapshot;
	onModel(): void;
	onThinking(): void;
	onRefresh(): Promise<void>;
	host: ToolRenderHost;
	selectedAgentId: string | null;
	onAgentClose(): void;
}): ReactNode {
	const [error, setError] = useState("");
	const [result, setResult] = useState<{ title: string; value: unknown } | null>(null);
	const [agent, setAgent] = useState<RecordValue | null>(null);
	const [agentMessages, setAgentMessages] = useState<Message[]>([]);
	const [steer, setSteer] = useState("");
	const [phases, setPhases] = useState<RecordValue[] | null>(null);
	const [branches, setBranches] = useState<RecordValue[] | null>(null);
	const [pending, setPending] = useState(false);
	const [tree, setTree] = useState<RecordValue | null>(null);
	useEffect(() => {
		if (selectedAgentId) setAgent({ id: selectedAgentId });
	}, [selectedAgentId]);
	useEffect(() => {
		if (!agent) return;
		let cancelled = false;
		const load = async () => {
			try {
				const result = await client.request({ type: "get_subagent_messages", subagentId: text(agent.id) });
				if (!cancelled)
					setAgentMessages(records(result.messages).map((message, i) => messageOf(message, `agent-${i}`)));
			} catch (error) {
				if (!cancelled) setError(String(error));
			}
		};
		void load();
		const timer = setInterval(() => void load(), 2000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [agent, client]);
	const state = snapshot.state;
	const model = isRecord(state.model) ? state.model : {};
	const context = isRecord(state.contextUsage) ? state.contextUsage : {};
	const rpc = isRecord(state.rpcSession) ? state.rpcSession : {};
	const todos = records(state.todoPhases ?? []);
	const tasks = todos.flatMap(phase => records(phase.tasks));
	const transcript = [...agentMessages];
	for (const message of snapshot.agentMessages[text(agent?.id)] ?? []) {
		const index = transcript.findIndex(previous => previous.key === message.key);
		if (index < 0) transcript.push(message);
		else if (!transcript[index]?.stopReason) transcript[index] = message;
	}
	const active = Math.max(0, Math.floor((Date.now() - number(rpc.startedAt)) / 60000));
	const run = async (command: RpcCommand, show?: string): Promise<RecordValue> => {
		setPending(true);
		setError("");
		try {
			const value = await client.request(command, 600_000);
			if (show) setResult({ title: show, value });
			await onRefresh();
			return value;
		} catch (error) {
			setError(String(error));
			throw error;
		} finally {
			setPending(false);
		}
	};
	const act = (command: RpcCommand, show?: string) => {
		void run(command, show).catch(() => {
			/* The rail retains the error. */
		});
	};
	const inputAction = (
		event: React.FormEvent<HTMLFormElement>,
		make: (value: string) => RpcCommand,
		field = "value",
	) => {
		event.preventDefault();
		const value = String(new FormData(event.currentTarget).get(field) ?? "").trim();
		act(make(value));
	};
	return (
		<aside className="rail" aria-label="Side panel">
			<details className="rail-sec" open>
				<summary>
					Todos{" "}
					<span className="n">
						{tasks.filter(task => task.status === "completed").length} of {tasks.length} done
					</span>
				</summary>
				<div className="rail-body">
					{todos.map((phase, index) => (
						<div key={`${phase.name}-${index}`}>
							<b>{text(phase.name)}</b>
							<ul className="todo">
								{records(phase.tasks).map((task, i) => (
									<li
										className={
											task.status === "completed"
												? "st-done"
												: task.status === "in_progress"
													? "st-doing"
													: ""
										}
										key={`${task.content}-${i}`}
									>
										<span className="box" aria-hidden="true" />
										<span>
											{text(task.content)}
											{task.status === "blocked" && <small> · blocked: {text(task.blocker)}</small>}
										</span>
									</li>
								))}
							</ul>
						</div>
					))}
					{tasks.length === 0 && <p>No todos.</p>}
					<button
						className="btn"
						type="button"
						disabled={snapshot.phase !== "connected"}
						onClick={() => setPhases(structuredClone(todos))}
					>
						Edit todos
					</button>
				</div>
			</details>
			<details className="rail-sec" open>
				<summary>
					Agents <span className="n">{snapshot.agents.length}</span>
				</summary>
				<div className="rail-body">
					{snapshot.agents.length === 0 && <p>No subagents.</p>}
					{snapshot.agents.map(agent => (
						<div className="agent" key={text(agent.id)}>
							<span className={`dot ${agent.status === "running" ? "dot-live" : ""}`} />
							<div>
								<b>{text(agent.id)}</b> · {text(agent.agent)}
								<div className="mono">
									{text(agent.status)} · {text(agent.description)}
								</div>
							</div>
							<div className="agent-act">
								<button
									className="btn"
									type="button"
									onClick={() => {
										setAgent(agent);
										setAgentMessages([]);
									}}
								>
									Steer
								</button>
								<button
									className="btn"
									type="button"
									onClick={() => {
										setAgent(agent);
										void client
											.request({ type: "get_subagent_messages", subagentId: text(agent.id) })
											.then(result =>
												setAgentMessages(
													records(result.messages).map((message, i) => messageOf(message, `agent-${i}`)),
												),
											)
											.catch(error => setError(String(error)));
									}}
								>
									Messages
								</button>
								<button
									className="btn btn-stop"
									type="button"
									onClick={() => act({ type: "cancel_subagent", subagentId: text(agent.id) })}
								>
									Cancel
								</button>
							</div>
						</div>
					))}
				</div>
			</details>
			<details className="rail-sec" open>
				<summary>Status</summary>
				<div className="rail-body">
					<dl className="kv">
						<dt>model</dt>
						<dd>
							<button className="btn mono" type="button" onClick={onModel}>
								{text(model.id) || "none"} ▾
							</button>
						</dd>
						<dt>thinking</dt>
						<dd>
							<button className="btn" type="button" onClick={onThinking}>
								{text(state.thinkingLevel) || "off"} ▾
							</button>
						</dd>
						<dt>context</dt>
						<dd>
							{context.percent !== undefined ? `${Math.round(number(context.percent))}%` : "not available"}{" "}
							{number(context.tokens)} / {number(context.contextWindow)}
						</dd>
						<dt>tokens</dt>
						<dd>
							{isRecord(snapshot.stats.tokens)
								? `${number(snapshot.stats.tokens.input)} in · ${number(snapshot.stats.tokens.output)} out`
								: "not available"}
						</dd>
						<dt>cost</dt>
						<dd>${number(snapshot.stats.cost).toFixed(4)}</dd>
						<dt>rate</dt>
						<dd>
							{state.tokensPerSecond === null
								? "not available"
								: `${number(state.tokensPerSecond).toFixed(1)} tok/s`}
						</dd>
						<dt>path</dt>
						<dd className="mono">{shortenPath(text(rpc.cwd))}</dd>
						<dt>time</dt>
						<dd>{active} m active</dd>
						<dt>session</dt>
						<dd className="mono">{text(state.sessionId)}</dd>
						<dt>host</dt>
						<dd>Mac · pid {number(rpc.pid)}</dd>
						<dt>git, quota</dt>
						<dd>terminal only</dd>
						{Object.entries(snapshot.statuses).map(([key, value]) => (
							<div key={key}>
								<dt>{key}</dt>
								<dd>{value}</dd>
							</div>
						))}
					</dl>
					{Object.entries(snapshot.widgets).map(([key, lines]) => (
						<div key={key}>
							<b>{key}</b>
							<pre>{lines.join("\n")}</pre>
						</div>
					))}
					{error && (
						<p role="alert" className="composer-note err">
							{error}
						</p>
					)}
					<fieldset disabled={pending || snapshot.phase !== "connected"}>
						<legend>Session controls</legend>
						<div className="actions">
							<button
								className="btn"
								type="button"
								onClick={() => act({ type: "set_fast_mode", enabled: !state.fastModeEnabled })}
								aria-pressed={state.fastModeEnabled === true}
							>
								Fast {state.fastModeEnabled ? "on" : "off"}
							</button>
							<button
								className="btn"
								type="button"
								onClick={() => act({ type: "set_auto_compaction", enabled: !state.autoCompactionEnabled })}
								aria-pressed={state.autoCompactionEnabled === true}
							>
								Auto compact {state.autoCompactionEnabled ? "on" : "off"}
							</button>
							<button className="btn" type="button" onClick={() => act({ type: "cycle_model" })}>
								Cycle model
							</button>
							<button className="btn" type="button" onClick={() => act({ type: "cycle_thinking_level" })}>
								Cycle thinking
							</button>
						</div>
						{(
							[
								["Steering mode", "set_steering_mode", state.steeringMode, ["all", "one-at-a-time"]],
								["Follow-up mode", "set_follow_up_mode", state.followUpMode, ["all", "one-at-a-time"]],
								["Interrupt mode", "set_interrupt_mode", state.interruptMode, ["immediate", "wait"]],
							] as const
						).map(([label, type, value, options]) => (
							<label className="field" key={type}>
								{label}
								<select
									value={text(value)}
									onChange={event => {
										const mode = event.target.value;
										if (type === "set_interrupt_mode")
											act({ type, mode: mode === "wait" ? "wait" : "immediate" });
										else act({ type, mode: mode === "all" ? "all" : "one-at-a-time" });
									}}
								>
									{options.map(option => (
										<option key={option}>{option}</option>
									))}
								</select>
							</label>
						))}
						<label className="field">
							Cache warming
							<select
								defaultValue=""
								onChange={event => {
									const mode = event.target.value;
									if (mode === "off" || mode === "streaming" || mode === "idle")
										act({ type: "set_cache_warming", mode });
								}}
							>
								<option value="" disabled>
									Set mode
								</option>
								<option>off</option>
								<option>streaming</option>
								<option>idle</option>
							</select>
						</label>
						<div className="actions">
							<button
								type="button"
								className="btn"
								onClick={() => act({ type: "set_auto_retry", enabled: true })}
							>
								Enable retry
							</button>
							<button
								type="button"
								className="btn"
								onClick={() => act({ type: "set_auto_retry", enabled: false })}
							>
								Disable retry
							</button>
							<button type="button" className="btn btn-stop" onClick={() => act({ type: "abort_retry" })}>
								Stop retry
							</button>
						</div>
						<details>
							<summary>Context and export</summary>
							<form
								onSubmit={event =>
									inputAction(event, value => ({ type: "compact", customInstructions: value }))
								}
							>
								<label className="field">
									Compaction instructions
									<input name="value" />
								</label>
								<button className="btn" type="submit">
									Compact
								</button>
							</form>
							<form
								onSubmit={event =>
									inputAction(event, value => ({ type: "handoff", customInstructions: value }))
								}
							>
								<label className="field">
									Handoff instructions
									<input name="value" />
								</label>
								<button className="btn" type="submit">
									Handoff
								</button>
							</form>
							<button
								className="btn"
								type="button"
								onClick={() => act({ type: "export_html" }, "Export path on the Mac")}
							>
								Export HTML
							</button>
							<button
								className="btn"
								type="button"
								onClick={() => act({ type: "get_session_stats" }, "Session stats")}
							>
								Session stats
							</button>
							<button
								className="btn"
								type="button"
								onClick={() => act({ type: "get_last_assistant_text" }, "Last assistant text")}
							>
								Last assistant text
							</button>
							<button
								className="btn"
								type="button"
								onClick={() => act({ type: "get_messages_page", limit: 50 }, "Messages page")}
							>
								Messages page
							</button>
						</details>
						<details>
							<summary>Session</summary>
							<form onSubmit={event => inputAction(event, value => ({ type: "set_session_name", name: value }))}>
								<label className="field">
									Session name
									<input name="value" defaultValue={text(state.sessionName)} required />
								</label>
								<button className="btn" type="submit">
									Rename
								</button>
							</form>
							<button className="btn" type="button" onClick={() => act({ type: "new_session" })}>
								New session in this TUI
							</button>
							<form
								onSubmit={event => inputAction(event, value => ({ type: "open_session", sessionDir: value }))}
							>
								<label className="field">
									Directory on the Mac
									<input name="value" required />
								</label>
								<button className="btn" type="submit">
									Open directory
								</button>
							</form>
							<form
								onSubmit={event =>
									inputAction(event, value => ({ type: "switch_session", sessionPath: value }))
								}
							>
								<label className="field">
									Session path on the Mac
									<input name="value" required />
								</label>
								<button className="btn" type="submit">
									Switch session
								</button>
							</form>
							<button
								className="btn"
								type="button"
								onClick={() => {
									void run({ type: "get_branch_messages" })
										.then(result => setBranches(records(result.messages)))
										.catch(() => {
											/* The rail retains the error. */
										});
								}}
							>
								Branch messages
							</button>
							<button className="btn" type="button" onClick={() => act({ type: "fork" })}>
								Fork current session
							</button>
							<button
								className="btn"
								type="button"
								onClick={() => act({ type: "get_entries" }, "Session entries")}
							>
								Session entries
							</button>
							<button
								className="btn"
								type="button"
								onClick={() => {
									void run({ type: "get_tree" })
										.then(setTree)
										.catch(() => {
											/* The rail retains the error. */
										});
								}}
							>
								Tree snapshot
							</button>
						</details>
						<details>
							<summary>Goal</summary>
							<form
								onSubmit={event => {
									event.preventDefault();
									const data = new FormData(event.currentTarget);
									act({
										type: "goal",
										op: "create",
										objective: String(data.get("objective")),
										token_budget: Number(data.get("budget")),
									});
								}}
							>
								<label className="field">
									Objective
									<input name="objective" required />
								</label>
								<label className="field">
									Token budget
									<input name="budget" type="number" min="1" defaultValue="20000" required />
								</label>
								<button type="submit" className="btn">
									Create goal
								</button>
							</form>
							<div className="actions">
								{(["get", "pause", "resume", "drop"] as const).map(op => (
									<button
										className="btn"
										type="button"
										key={op}
										onClick={() => act({ type: "goal", op }, "Goal")}
									>
										{op}
									</button>
								))}
							</div>
						</details>
					</fieldset>
				</div>
			</details>
			{agent && (
				<Modal
					title={`Agent ${text(agent.id)}`}
					onClose={() => {
						setAgent(null);
						onAgentClose();
					}}
				>
					<div className="dlg-q">
						<form
							onSubmit={event => {
								event.preventDefault();
								act({ type: "steer_subagent", subagentId: text(agent.id), message: steer });
								setSteer("");
							}}
						>
							<label className="field">
								Steer agent
								<textarea value={steer} onChange={event => setSteer(event.target.value)} required />
							</label>
							<button type="submit" className="btn btn-primary">
								Send steer
							</button>
						</form>
						<button
							type="button"
							className="btn"
							onClick={() => {
								void client
									.request({ type: "get_subagent_messages", subagentId: text(agent.id) })
									.then(result =>
										setAgentMessages(
											records(result.messages).map((message, i) => messageOf(message, `agent-${i}`)),
										),
									)
									.catch(error => setError(String(error)));
							}}
						>
							Refresh agent messages
						</button>
					</div>
					<Transcript snapshot={{ ...snapshot, messages: transcript, tools: {} }} host={host} />
				</Modal>
			)}
			{phases && (
				<Modal title="Edit todos" onClose={() => setPhases(null)}>
					<form
						className="dlg-q"
						onSubmit={event => {
							event.preventDefault();
							const next = phases.map(phase => ({
								name: text(phase.name),
								tasks: records(phase.tasks).map(task => ({
									content: text(task.content),
									status:
										(["pending", "in_progress", "completed", "abandoned", "blocked"] as TodoStatus[]).find(
											status => status === task.status,
										) ?? "pending",
									blocker: typeof task.blocker === "string" ? task.blocker : undefined,
									details: typeof task.details === "string" ? task.details : undefined,
									notes: task.notes === undefined ? undefined : strings(task.notes),
								})),
							}));
							void run({ type: "set_todos", phases: next })
								.then(() => setPhases(null))
								.catch(() => {
									/* The rail retains the error. */
								});
						}}
					>
						{phases.map((phase, index) => (
							<fieldset key={index}>
								<legend>{text(phase.name)}</legend>
								{records(phase.tasks).map((task, i) => (
									<label className="field" key={i}>
										<span>{text(task.content)}</span>
										<select
											value={text(task.status)}
											onChange={event =>
												setPhases(
													phases.map((phase, j) =>
														j === index
															? {
																	...phase,
																	tasks: records(phase.tasks).map((task, k) =>
																		k === i ? { ...task, status: event.target.value } : task,
																	),
																}
															: phase,
													),
												)
											}
										>
											<option value="pending">pending</option>
											<option value="in_progress">in progress</option>
											<option value="completed">completed</option>
											<option value="blocked">blocked</option>
											<option value="abandoned">abandoned</option>
										</select>
									</label>
								))}
							</fieldset>
						))}
						<label className="field">
							Add task
							<input name="task" />
						</label>
						<button
							className="btn"
							type="button"
							onClick={event => {
								const form = event.currentTarget.form;
								const value = String(form ? (new FormData(form).get("task") ?? "") : "").trim();
								if (value)
									setPhases([...phases, { name: "Tasks", tasks: [{ content: value, status: "pending" }] }]);
							}}
						>
							Add task
						</button>
						<button className="btn btn-primary" type="submit">
							Save todos
						</button>
					</form>
				</Modal>
			)}
			{branches && (
				<Modal title="Branch messages" onClose={() => setBranches(null)}>
					<ul className="dlg-q">
						{branches.map(branch => (
							<li key={text(branch.entryId)}>
								<p>{text(branch.text)}</p>
								<button
									className="btn"
									type="button"
									onClick={() => {
										void run({ type: "branch", entryId: text(branch.entryId) })
											.then(() => setBranches(null))
											.catch(() => {
												/* The rail retains the error. */
											});
									}}
								>
									Branch here
								</button>
								<button
									className="btn"
									type="button"
									onClick={() => {
										void run({ type: "fork", entryId: text(branch.entryId) })
											.then(() => setBranches(null))
											.catch(() => {
												/* The rail retains the error. */
											});
									}}
								>
									Fork here
								</button>
							</li>
						))}
					</ul>
				</Modal>
			)}
			{tree && (
				<Modal title="Tree snapshot" onClose={() => setTree(null)}>
					<pre className="dlg-q result-view">{JSON.stringify(tree, null, 2)}</pre>
					<p className="dlg-q">The interactive tree selector is terminal only.</p>
				</Modal>
			)}
			{result && (
				<Modal title={result.title} onClose={() => setResult(null)}>
					<pre className="dlg-q result-view">
						{typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2)}
					</pre>
				</Modal>
			)}
		</aside>
	);
}
