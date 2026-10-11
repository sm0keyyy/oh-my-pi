import { Paperclip, PanelsTopLeft } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ImageContent } from "./commands";
import { messageText, text, TERMINAL_COMMANDS, type SessionClient, type Snapshot } from "./client";

interface Attachment {
	name: string;
	image: ImageContent;
}
export function Composer({
	client,
	snapshot,
	onPanels,
	onAction,
}: {
	client: SessionClient;
	snapshot: Snapshot;
	onPanels(): void;
	onAction(): Promise<void>;
}): ReactNode {
	const [draft, setDraft] = useState("");
	const [images, setImages] = useState<Attachment[]>([]);
	const [mode, setMode] = useState<"steer" | "follow_up">("steer");
	const [sending, setSending] = useState(false);
	const [bashBusy, setBashBusy] = useState(false);
	const [error, setError] = useState("");
	const [ghost, setGhost] = useState("");
	const [selected, setSelected] = useState(0);
	const [paletteClosed, setPaletteClosed] = useState(false);
	const input = useRef<HTMLTextAreaElement>(null);
	const attached = useRef<HTMLInputElement>(null);
	const generation = useRef(0);
	const current = useRef(draft);
	current.current = draft;
	const streaming = snapshot.state.isStreaming === true;
	const locked = snapshot.phase !== "connected" || snapshot.dialogs.length > 0 || sending;
	const prefix = /^\/([^\s]*)$/.exec(draft)?.[1];
	const options =
		prefix !== undefined && !paletteClosed
			? snapshot.commands.filter(command => text(command.name).startsWith(prefix))
			: [];
	const terminal = draft.startsWith("/") && TERMINAL_COMMANDS.includes(draft.trim().split(/\s+/)[0].slice(1));
	useEffect(() => {
		setSelected(0);
		setPaletteClosed(false);
	}, [draft]);
	useEffect(() => {
		if (snapshot.editorText) setDraft(snapshot.editorText.text);
	}, [snapshot.editorText]);
	useEffect(() => {
		setGhost("");
		const token = ++generation.current;
		if (!draft || draft.startsWith("/") || locked) return;
		const cursor = input.current?.selectionStart ?? draft.length;
		const timer = setTimeout(() => {
			void client
				.request({ type: "predict_word", text: draft, cursor }, 10_000)
				.then(result => {
					if (generation.current === token && current.current === draft) setGhost(text(result.suffix));
				})
				.catch(() => {
					if (generation.current === token) setGhost("");
				});
		}, 350);
		return () => clearTimeout(timer);
	}, [draft, client, locked]);
	const feedback = (accepted: boolean) => {
		const cursor = input.current?.selectionStart ?? draft.length;
		void client
			.request({ type: "predict_word_feedback", text: draft, cursor, suggestion: ghost, accepted }, 10_000)
			.catch(error => setError(String(error)));
		if (accepted) {
			setDraft(draft.slice(0, cursor) + ghost + draft.slice(cursor));
			requestAnimationFrame(() => input.current?.setSelectionRange(cursor + ghost.length, cursor + ghost.length));
		}
		setGhost("");
	};
	const attach = async (files: File[]): Promise<void> => {
		try {
			const next: Attachment[] = [];
			for (const file of files) {
				if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type))
					throw new Error("Attach a PNG, JPEG, WebP, or GIF image.");
				if (file.size > 700_000)
					throw new Error("This image exceeds the RPC frame limit. Use an image smaller than 700 KB.");
				const reader = new FileReader();
				const loaded = Promise.withResolvers<string>();
				reader.onload = () =>
					typeof reader.result === "string"
						? loaded.resolve(reader.result)
						: loaded.reject(new Error("Cannot read image"));
				reader.onerror = () => loaded.reject(reader.error ?? new Error("Cannot read image"));
				reader.readAsDataURL(file);
				const data = (await loaded.promise).split(",")[1];
				if (!data) throw new Error("Cannot read image");
				next.push({ name: file.name, image: { type: "image", mimeType: file.type, data } });
			}
			setImages(previous => [...previous, ...next]);
			setError("");
		} catch (error) {
			setError(String(error));
		}
	};
	const send = async (): Promise<void> => {
		if (locked || (!draft.trim() && images.length === 0)) return;
		if (terminal) {
			setError("This command is terminal only. Run it in the TUI on the Mac.");
			return;
		}
		setSending(true);
		setError("");
		const message = draft;
		try {
			if (message.startsWith("!")) {
				setBashBusy(true);
				setSending(false);
				const result = await client.request({ type: "bash", command: message.slice(1) }, 600_000);
				if (result.exitCode !== 0)
					setError(`Bash exited with code ${result.exitCode}. ${messageText(result.output)}`);
			} else
				await client.request({
					type: streaming ? mode : "prompt",
					message,
					images: images.map(attachment => attachment.image),
				});
			if (current.current === message) {
				setDraft("");
				setImages([]);
				setGhost("");
			}
			await onAction();
		} catch (error) {
			setError(String(error));
		} finally {
			setSending(false);
			setBashBusy(false);
			input.current?.focus();
		}
	};
	return (
		<div className="composer">
			{options.length > 0 && (
				<div className="pal" id="command-palette">
					<div className="pal-head">commands · ↑↓ move · Enter choose</div>
					<ul role="listbox" aria-label="Commands">
						{options.map((command, index) => {
							const name = text(command.name);
							const only = TERMINAL_COMMANDS.includes(name);
							return (
								<li
									key={name}
									role="option"
									aria-selected={index === selected}
									aria-disabled={only}
									id={`command-${index}`}
								>
									<button
										type="button"
										aria-disabled={only}
										onClick={() => {
											if (only) {
												setError(`/${name} is terminal only. Run it on the Mac.`);
												return;
											}
											setDraft(`/${name} `);
											input.current?.focus();
										}}
									>
										<span className="cmd">/{name}</span>{" "}
										<span className="desc">{text(command.description)}</span>{" "}
										<span className="tag">{only ? "terminal only" : text(command.source)}</span>
									</button>
								</li>
							);
						})}
					</ul>
				</div>
			)}
			<div className={`composer-box ${locked ? "is-disabled" : ""}`}>
				{images.length > 0 && (
					<div className="composer-attach">
						{images.map((attachment, index) => (
							<span className="attach" key={`${attachment.name}-${index}`}>
								{attachment.name}
								<button
									className="x"
									type="button"
									aria-label={`Remove ${attachment.name}`}
									onClick={() => setImages(images.filter((_, i) => i !== index))}
								>
									×
								</button>
							</span>
						))}
					</div>
				)}
				<label className="vh" htmlFor="message">
					Message
				</label>
				<textarea
					id="message"
					ref={input}
					rows={2}
					value={draft}
					disabled={locked || bashBusy}
					aria-describedby={error ? "send-error" : undefined}
					aria-invalid={Boolean(error)}
					aria-controls={options.length > 0 ? "command-palette" : undefined}
					aria-activedescendant={options.length > 0 ? `command-${selected}` : undefined}
					onChange={event => setDraft(event.target.value)}
					onPaste={event => {
						const files = Array.from(event.clipboardData.files);
						if (files.length) void attach(files);
					}}
					placeholder={
						snapshot.dialogs.length
							? "Answer the question above to continue"
							: locked
								? "Reconnecting…"
								: streaming
									? "Steer the running turn, or queue a follow-up"
									: "Message omp"
					}
					onKeyDown={event => {
						if (options.length && ["ArrowUp", "ArrowDown"].includes(event.key)) {
							event.preventDefault();
							setSelected((selected + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
							return;
						}
						if (event.key === "Escape") {
							setPaletteClosed(true);
							if (ghost) feedback(false);
							return;
						}
						if (event.key === "Tab" && ghost) {
							event.preventDefault();
							feedback(true);
							return;
						}
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							if (options.length) {
								const name = text(options[selected]?.name);
								if (TERMINAL_COMMANDS.includes(name)) setError(`/${name} is terminal only. Run it on the Mac.`);
								else setDraft(`/${name} `);
							} else void send();
						}
					}}
				/>
				{ghost && (
					<div className="ghost" aria-label="Word prediction">
						{ghost} <span className="kbd">Tab</span>
					</div>
				)}
				{error && (
					<div className="composer-note err" id="send-error" role="alert">
						{error} Your text is kept.
					</div>
				)}
				<div className="composer-bar">
					<button
						className="btn btn-icon"
						type="button"
						aria-label="Attach image"
						disabled={locked}
						onClick={() => attached.current?.click()}
					>
						<Paperclip size={16} />
					</button>
					<input
						type="file"
						ref={attached}
						hidden
						multiple
						accept="image/png,image/jpeg,image/webp,image/gif"
						onChange={event => {
							void attach(Array.from(event.target.files ?? []));
							event.target.value = "";
						}}
					/>
					<span className="hint">/ for commands · Shift Enter newline</span>
					<span className="grow" />
					{streaming && (
						<div className="seg" aria-label="Send while streaming">
							<button type="button" aria-pressed={mode === "steer"} onClick={() => setMode("steer")}>
								Steer
							</button>
							<button type="button" aria-pressed={mode === "follow_up"} onClick={() => setMode("follow_up")}>
								Queue
							</button>
						</div>
					)}
					<button type="button" className="btn btn-icon phone-only" aria-label="Panels" onClick={onPanels}>
						<PanelsTopLeft size={16} />
					</button>
					{(streaming || bashBusy || snapshot.state.isCompacting === true) && (
						<button
							type="button"
							className="btn btn-stop"
							disabled={snapshot.phase !== "connected"}
							onClick={() => {
								void client
									.request({ type: bashBusy ? "abort_bash" : "abort" })
									.then(onAction)
									.catch(error => setError(String(error)));
							}}
						>
							Stop
						</button>
					)}
					<button
						className="btn btn-primary"
						type="button"
						disabled={locked || bashBusy || (!draft.trim() && images.length === 0) || terminal}
						aria-busy={sending}
						onClick={() => void send()}
					>
						{sending ? "Sending…" : "Send"}
					</button>
				</div>
			</div>
		</div>
	);
}
