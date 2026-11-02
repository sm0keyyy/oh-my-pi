import { isRecord, ToolView, type ToolRenderHost, type ToolResultLike } from "@oh-my-pi/web-render";
import { Markdown } from "@oh-my-pi/web-render/Markdown";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { messageText, text, type Message, type Snapshot } from "./client";
import { renderCustomMessage } from "./custom-message";
import { ScrollFollow } from "./scroll-follow";

export function Transcript({ snapshot, host }: { snapshot: Snapshot; host: ToolRenderHost }): ReactNode {
	const scroll = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const follower = useRef(new ScrollFollow());
	const touchY = useRef<number | undefined>(undefined);
	const [following, setFollowing] = useState(true);
	const detach = () => {
		follower.current.detach();
		setFollowing(false);
	};
	useLayoutEffect(() => {
		if (scroll.current) follower.current.follow(scroll.current);
	}, [snapshot.messages, snapshot.tools]);
	useLayoutEffect(() => {
		const node = scroll.current;
		const transcript = content.current;
		if (!node || !transcript) return;
		let height = transcript.getBoundingClientRect().height;
		const observer = new ResizeObserver(entries => {
			if (entries.some(entry => entry.target === node)) follower.current.track(node);
			const next = transcript.getBoundingClientRect().height;
			if (next !== height) follower.current.follow(node);
			height = next;
		});
		observer.observe(transcript);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);
	const results = new Map<string, Message>();
	for (const message of snapshot.messages)
		if (message.role === "toolResult") results.set(text(message.toolCallId), message);
	return (
		<div className="transcript-pane">
			<div
				className="scroll"
				ref={scroll}
				onWheel={event => {
					if (event.deltaY < 0) detach();
				}}
				onTouchStart={event => {
					touchY.current = event.touches[0]?.clientY;
				}}
				onTouchMove={event => {
					const next = event.touches[0]?.clientY;
					if (next !== undefined && touchY.current !== undefined && next > touchY.current) detach();
					touchY.current = next;
				}}
				onTouchEnd={() => {
					touchY.current = undefined;
				}}
				onKeyDown={event => {
					if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) detach();
				}}
				tabIndex={0}
				role="region"
				aria-label="Transcript"
				onScroll={event => {
					follower.current.track(event.currentTarget);
					setFollowing(follower.current.isFollowing);
				}}
			>
				<div className="transcript" ref={content}>
					{snapshot.messages.length === 0 && (
						<p className="empty">
							{snapshot.phase === "connected"
								? "No messages yet. Send a message to omp."
								: "The transcript will appear after the Mac connects."}
						</p>
					)}
					{snapshot.messages
						.filter(
							message =>
								message.role !== "toolResult" &&
								!((message.role === "custom" || message.role === "hookMessage") && message.display === false),
						)
						.map(message => {
							const custom = renderCustomMessage(message);
							return (
								<article
									className={`entry ${message.role === "user" ? "entry-user" : "entry-assistant"}`}
									key={message.key}
									data-message-key={message.key}
								>
									<div className="entry-who">
										{custom !== undefined
											? text(message.customType).startsWith("irc:")
												? "IRC"
												: "notice"
											: message.role === "user"
												? "you"
												: message.role === "assistant"
													? "omp"
													: message.role === "compactionSummary"
														? "compacted"
														: "system"}
									</div>
									<div className="entry-body">
										{custom !== undefined
											? custom
											: Array.isArray(message.content)
												? message.content.filter(isRecord).map((block, index) => {
														if (block.type === "thinking")
															return (
																<details className="think" key={index}>
																	<summary>Thinking</summary>
																	<p>{text(block.thinking)}</p>
																</details>
															);
														if (block.type === "text")
															return <Markdown key={index} text={text(block.text)} />;
														if (
															block.type === "image" &&
															/^(image\/(png|jpeg|webp|gif))$/.test(text(block.mimeType)) &&
															typeof block.data === "string"
														)
															return (
																<img
																	key={index}
																	alt="Message attachment"
																	src={`data:${block.mimeType};base64,${block.data}`}
																/>
															);
														if (block.type === "toolCall") {
															const result = results.get(text(block.id));
															const active = snapshot.tools[text(block.id)];
															const rawResult =
																result ??
																(isRecord(active?.result)
																	? active.result
																	: isRecord(active?.partialResult)
																		? active.partialResult
																		: undefined);
															const toolResult: ToolResultLike | undefined =
																rawResult && Array.isArray(rawResult.content)
																	? {
																			content: rawResult.content
																				.filter(isRecord)
																				.map(value => ({ ...value, type: text(value.type) })),
																			details: rawResult.details,
																			isError: rawResult.isError === true,
																		}
																	: undefined;
															return (
																<ToolView
																	key={text(block.id)}
																	name={text(block.name)}
																	args={block.arguments}
																	result={toolResult}
																	running={
																		!result &&
																		active?.type !== "tool_execution_end" &&
																		snapshot.state.isStreaming === true
																	}
																	partial={active ? messageText(active.partialResult) : undefined}
																	host={host}
																/>
															);
														}
														return null;
													})
												: message.role !== "bashExecution" && <Markdown text={messageText(message)} />}
										{message.role === "bashExecution" && (
											<ToolView
												name="bash"
												args={{ command: message.command }}
												result={{
													content: [{ type: "text", text: messageText(message) }],
													details: { exitCode: message.exitCode },
													isError: message.exitCode !== 0,
												}}
												defaultOpen
											/>
										)}
										{message.stopReason === "aborted" && (
											<span className="chip chip-err">stopped by you</span>
										)}
										{Boolean(message.errorMessage) && (
											<p role="alert" className="composer-note err">
												{text(message.errorMessage)}
											</p>
										)}
									</div>
								</article>
							);
						})}
				</div>
			</div>
			{!following && (
				<button
					className="btn jump-latest"
					type="button"
					onClick={() => {
						if (scroll.current) follower.current.jump(scroll.current);
						setFollowing(true);
					}}
				>
					Jump to latest
				</button>
			)}
		</div>
	);
}
