import { isRecord, shortenPath, type ToolRenderHost } from "@oh-my-pi/web-render";
import { Moon, PanelsTopLeft, Sun } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { messageOf, number, records, SessionClient, sortSessions, strings, text, type RecordValue } from "./client";
import { Composer } from "./composer";
import { Modal, OperatorDialog } from "./dialogs";
import { Rail } from "./rail";
import { Transcript } from "./transcript";

function ThemeButton(): ReactNode {
	const [light, setLight] = useState(document.documentElement.dataset.theme === "light");
	return (
		<button
			className="btn btn-icon"
			type="button"
			aria-label="Switch theme"
			onClick={() => {
				const next = !light;
				setLight(next);
				document.documentElement.dataset.theme = next ? "light" : "dark";
			}}
		>
			{light ? <Moon size={16} /> : <Sun size={16} />}
		</button>
	);
}
export function App(): ReactNode {
	const match = /^\/session\/([a-f0-9]{16})$/.exec(location.pathname);
	useEffect(() => {
		const viewport = window.visualViewport;
		if (!viewport) return;
		const update = () => {
			document.documentElement.style.setProperty("--viewport-height", `${viewport.height}px`);
			window.scrollTo(0, 0);
		};
		update();
		viewport.addEventListener("resize", update);
		viewport.addEventListener("scroll", update);
		return () => {
			viewport.removeEventListener("resize", update);
			viewport.removeEventListener("scroll", update);
		};
	}, []);
	return match ? <Session instanceId={match[1]} /> : <Lobby />;
}
function Lobby(): ReactNode {
	const [sessions, setSessions] = useState<RecordValue[] | null>(null);
	const [error, setError] = useState("");
	const [refresh, setRefresh] = useState(0);
	useEffect(() => {
		const controller = new AbortController();
		let busy = false;
		const load = async () => {
			if (busy) return;
			busy = true;
			try {
				const response = await fetch("/api/sessions", {
					credentials: "same-origin",
					cache: "no-store",
					signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
				});
				if (!response.ok)
					throw new Error(
						response.status === 403
							? "Access denied. Sign in through Cloudflare Access, then reload."
							: `Session discovery failed (${response.status}).`,
					);
				const body: unknown = await response.json();
				if (!isRecord(body)) throw new Error("Invalid sessions response");
				const rows = sortSessions(body.sessions);
				if (!controller.signal.aborted) {
					setSessions(rows);
					setError("");
				}
			} catch (error) {
				if (!controller.signal.aborted) setError(String(error));
			} finally {
				busy = false;
			}
		};
		void load();
		const timer = setInterval(() => void load(), 2000);
		return () => {
			controller.abort();
			clearInterval(timer);
		};
	}, [refresh]);
	const waiting = sessions?.filter(session => session.inputRequired) ?? [];
	const recent = sessions?.filter(session => !session.inputRequired) ?? [];
	return (
		<>
			<header className="top">
				<a className="brand" href="/">
					<span className="brand-mark" aria-hidden="true" />
					omp <span className="brand-slash">/</span>
					<span className="brand-app">sessions</span>
				</a>
				<span className="top-spacer" />
				<span className={`chip ${error ? "chip-err" : sessions?.length ? "chip-live" : ""}`}>
					<span className={`dot ${error ? "dot-err" : sessions?.length ? "dot-live" : ""}`} />
					{error ? "discovery offline" : sessions?.length ? "Mac online" : "session discovery"}
				</span>
				<ThemeButton />
			</header>
			<main className="lobby-main">
				<div className="lobby-head">
					<h1>Live sessions</h1>
					<span className="count">
						{sessions === null ? "Loading…" : `${sessions.length} open · ${waiting.length} waiting on you`}
					</span>
				</div>
				{error && (
					<div className="banner banner-err" role="alert">
						{error} Rows may be stale.
						<button className="btn" type="button" onClick={() => setRefresh(refresh + 1)}>
							Retry
						</button>
					</div>
				)}
				{sessions === null && !error && (
					<ul className="rows" aria-busy="true">
						<li className="row">Loading live sessions…</li>
					</ul>
				)}
				{sessions?.length === 0 && (
					<div className="empty">
						<b>No live sessions</b>Open omp in a terminal on the Mac. This list updates by itself.
					</div>
				)}
				{[
					["Waiting on you", waiting],
					["Recent activity", recent],
				].map(([label, group]) => {
					const rows = group as RecordValue[];
					return (
						rows.length > 0 && (
							<section
								className={`group ${label === "Waiting on you" ? "group-waiting" : ""}`}
								key={String(label)}
							>
								<h2 className="group-label">
									{String(label)} <span className="n">{rows.length}</span>
								</h2>
								<ul className="rows">
									{rows.map(session => {
										const path = text(session.cwd);
										const model = isRecord(session.model) ? session.model : {};
										const href = `/session/${session.instanceId}`;
										return (
											<li
												className="row"
												key={text(session.instanceId)}
												data-instance-id={text(session.instanceId)}
											>
												<div className="row-name">
													<a href={href}>
														{text(session.sessionName) || path.split("/").at(-1) || "session"}
													</a>
													<span
														className={`chip ${session.inputRequired ? "chip-warn" : session.busy ? "chip-live" : ""}`}
													>
														<span
															className={`dot ${session.inputRequired ? "dot-warn" : session.busy ? "dot-live" : ""}`}
														/>
														{session.inputRequired
															? "waiting on you"
															: session.busy
																? "streaming"
																: "idle"}
													</span>
												</div>
												<div className="row-path mono" title={path}>
													{shortenPath(path)}
												</div>
												{session.inputRequired === true && text(session.questionText) && (
													<div className="row-ask">{text(session.questionText)}</div>
												)}
												<div className="row-meta">
													<span className="chip mono">{text(model.id) || "no model"}</span>
													<time dateTime={new Date(number(session.lastActivity)).toISOString()}>
														Last activity {new Date(number(session.lastActivity)).toLocaleTimeString()}
													</time>
												</div>
												<div className="row-act">
													<a className={`btn ${session.inputRequired ? "btn-primary" : ""}`} href={href}>
														{session.inputRequired ? "Answer" : "Open"}
													</a>
												</div>
											</li>
										);
									})}
								</ul>
							</section>
						)
					);
				})}
			</main>
		</>
	);
}
function Session({ instanceId }: { instanceId: string }): ReactNode {
	const client = useMemo(() => new SessionClient(instanceId), [instanceId]);
	const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
	const [railOpen, setRailOpen] = useState(true);
	const [phoneOpen, setPhoneOpen] = useState(false);
	const [picker, setPicker] = useState<"model" | "thinking" | null>(null);
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [error, setError] = useState("");
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		client.connect();
		const timer = setInterval(() => setNow(Date.now()), 10_000);
		return () => {
			clearInterval(timer);
			client.close();
		};
	}, [client]);
	const state = snapshot.state;
	const rpc = isRecord(state.rpcSession) ? state.rpcSession : {};
	const model = isRecord(state.model) ? state.model : {};
	const context = isRecord(state.contextUsage) ? state.contextUsage : {};
	const queue = isRecord(state.queuedMessages) ? state.queuedMessages : { steering: [], followUp: [] };
	const queued = [
		...strings(queue.steering).map(message => ({ message, queue: "steering" as const })),
		...strings(queue.followUp).map(message => ({ message, queue: "followUp" as const })),
	];
	const active = number(rpc.startedAt) ? Math.max(0, Math.floor((now - number(rpc.startedAt)) / 60000)) : 0;
	const ctx = context.percent !== undefined ? `${Math.round(number(context.percent))}%` : "unknown";
	const title = text(state.sessionName) || text(rpc.cwd).split("/").at(-1) || "Session";
	useEffect(() => {
		document.title = `${title} · omp / sessions`;
	}, [title]);
	const synchronize = async () => {
		await client.refresh();
		if (!client.getSnapshot().state.isStreaming) {
			const result = await client.request({ type: "get_messages" });
			client.replaceMessages(records(result.messages).map((message, i) => messageOf(message, `snapshot-${i}`)));
		}
	};
	const host: ToolRenderHost = {
		hasAgent: id => snapshot.agents.some(agent => agent.id === id),
		openAgent: id => {
			setSelectedAgentId(id);
			if (window.matchMedia("(max-width: 899px)").matches) setPhoneOpen(true);
			else setRailOpen(true);
		},
	};
	const rail = (agentId: string | null) => (
		<Rail
			client={client}
			snapshot={snapshot}
			onModel={() => {
				setFilter("");
				setPicker("model");
			}}
			onThinking={() => setPicker("thinking")}
			onRefresh={synchronize}
			host={host}
			selectedAgentId={agentId}
			onAgentClose={() => setSelectedAgentId(null)}
		/>
	);
	return (
		<div className="app">
			<header className="top">
				<a className="btn btn-icon" href="/" aria-label="Back to sessions">
					‹
				</a>
				<div className="top-title">
					<b>{title}</b>
					<span className="mono" title={text(rpc.cwd)}>
						{shortenPath(text(rpc.cwd))}
					</span>
				</div>
				<span className={`chip ${snapshot.dialogs.length ? "chip-warn" : state.isStreaming ? "chip-live" : ""}`}>
					<span className={`dot ${snapshot.dialogs.length ? "dot-warn" : state.isStreaming ? "dot-live" : ""}`} />
					{snapshot.dialogs.length ? "waiting on you" : state.isStreaming ? "streaming" : "idle"}
				</span>
				<span className="top-spacer" />
				<button
					className="btn mono desktop-only"
					type="button"
					onClick={() => {
						setFilter("");
						setPicker("model");
					}}
				>
					{text(model.id) || "Model"} ▾
				</button>
				<button className="btn mono desktop-only" type="button" onClick={() => setPicker("thinking")}>
					think {text(state.thinkingLevel) || "off"} ▾
				</button>
				<button
					className="btn btn-icon desktop-only"
					type="button"
					aria-label="Side panel"
					aria-expanded={railOpen}
					onClick={() => setRailOpen(!railOpen)}
				>
					<PanelsTopLeft size={16} />
				</button>
				<ThemeButton />
			</header>
			{snapshot.phase !== "connected" && (
				<div className="banner banner-err" role="status">
					{snapshot.phase === "gone"
						? "The Mac closed this session."
						: snapshot.phase === "rebuilding"
							? "Rebuilding the view from the TUI…"
							: "Reconnecting to the Mac…"}
					{snapshot.phase === "gone" ? (
						<a className="btn" href="/">
							Back to sessions
						</a>
					) : (
						<button type="button" className="btn" onClick={client.connect}>
							Retry now
						</button>
					)}
				</div>
			)}
			{(error || snapshot.error) && (
				<div className="banner banner-err" role="alert">
					{error || snapshot.error}
				</div>
			)}
			<div className="body">
				<main className="main">
					<Transcript snapshot={snapshot} host={host} />
					{snapshot.notices.length > 0 && (
						<details className="queue">
							<summary>Notices · {snapshot.notices.length}</summary>
							<ol>
								{snapshot.notices.map((notice, index) => (
									<li key={index} role="status">
										{notice}
									</li>
								))}
							</ol>
						</details>
					)}
					{queued.length > 0 && (
						<details className="queue" open>
							<summary>
								<b>{queued.length} queued messages</b>
								<span className="q-text">run at the next boundary</span>
							</summary>
							<ol>
								{queued.map((item, index) => (
									<li key={`${item.queue}:${item.message}:${index}`}>
										<span className="q-kind">{item.queue === "steering" ? "steer" : index + 1}</span>
										<span className="q-text" title={item.message}>
											{item.message}
										</span>
										{item.queue === "followUp" && (
											<button
												className="btn"
												type="button"
												aria-label={`Promote ${item.message}`}
												onClick={() => {
													void client
														.request({ type: "promote_queued_message", message: item.message })
														.then(synchronize)
														.catch(error => setError(String(error)));
												}}
											>
												↑
											</button>
										)}
										<button
											className="btn"
											type="button"
											aria-label={`Remove ${item.message}`}
											onClick={() => {
												void client
													.request({
														type: "remove_queued_message",
														message: item.message,
														queue: item.queue,
													})
													.then(synchronize)
													.catch(error => setError(String(error)));
											}}
										>
											×
										</button>
									</li>
								))}
							</ol>
						</details>
					)}
					{snapshot.dialogs.map(frame => (
						<OperatorDialog key={text(frame.id)} frame={frame} client={client} />
					))}
					<footer className="foot">
						<Composer
							client={client}
							snapshot={snapshot}
							onPanels={() => setPhoneOpen(true)}
							onAction={synchronize}
						/>
						<div className="status desktop-status" role="status" aria-label="Status line">
							<span className="hot">{text(model.id)}</span>
							<span>think {text(state.thinkingLevel)}</span>
							<span>ctx {ctx}</span>
							<span>${number(snapshot.stats.cost).toFixed(4)}</span>
							<span>{snapshot.agents.length} agents</span>
							<span>{queued.length} queued</span>
							<span>{active} m active</span>
						</div>
						<div className="status phone-status" role="status" aria-label="Phone status strip">
							<span>ctx {ctx}</span>
							<span>
								{snapshot.dialogs.length} waiting · {queued.length} queued
							</span>
							<span>{active} m active</span>
						</div>
					</footer>
				</main>
				<div className="desktop-only" hidden={!railOpen}>
					{rail(phoneOpen ? null : selectedAgentId)}
				</div>
			</div>
			{phoneOpen && (
				<Modal
					title="Panels"
					onClose={() => {
						setPhoneOpen(false);
						setSelectedAgentId(null);
					}}
				>
					{rail(selectedAgentId)}
				</Modal>
			)}
			{picker && (
				<Modal title={picker === "model" ? "Model" : "Thinking"} onClose={() => setPicker(null)}>
					<div className="dlg-q">
						{picker === "model" && (
							<label className="field">
								Filter models
								<input autoFocus value={filter} onChange={event => setFilter(event.target.value)} />
							</label>
						)}
						<ul className="opts">
							{picker === "model"
								? snapshot.models
										.filter(model =>
											`${model.provider}/${model.id}`.toLowerCase().includes(filter.toLowerCase()),
										)
										.map(available => (
											<li key={`${available.provider}/${available.id}`}>
												<button
													className="btn"
													type="button"
													aria-pressed={model.id === available.id && model.provider === available.provider}
													onClick={() => {
														void client
															.request({
																type: "set_model",
																provider: text(available.provider),
																modelId: text(available.id),
															})
															.then(synchronize)
															.then(() => setPicker(null))
															.catch(error => setError(String(error)));
													}}
												>
													{text(available.provider)}/{text(available.id)}
													{model.id === available.id && model.provider === available.provider
														? " · current"
														: ""}
												</button>
											</li>
										))
								: snapshot.levels.map(level => (
										<li key={level}>
											<button
												className="btn"
												type="button"
												aria-pressed={state.thinkingLevel === level}
												onClick={() => {
													if (
														!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)
													) {
														setError(`Unsupported thinking level: ${level}`);
														return;
													}
													void client
														.setThinking(level)
														.then(synchronize)
														.then(() => setPicker(null))
														.catch(error => setError(String(error)));
												}}
											>
												{level}
												{state.thinkingLevel === level ? " · current" : ""}
											</button>
										</li>
									))}
						</ul>
					</div>
				</Modal>
			)}
		</div>
	);
}
