import { isRecord, ToolView, type ToolRenderHost, type ToolResultLike } from "@oh-my-pi/web-render";
import { Markdown } from "@oh-my-pi/web-render/Markdown";
import { forwardRef, useCallback, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { messageText, text, type Message, type Snapshot, type SessionClient } from "./client";
import { renderCustomMessage } from "./custom-message";
import { ScrollFollow } from "./scroll-follow";

const TranscriptList = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { context?: TranscriptContext }>(
	({ context: _context, ...props }, ref) => (
		<div {...props} ref={ref} className="transcript transcript-virtual" />
	),
);

interface TranscriptContext {
	history: Snapshot["history"];
	loadOlder(): void;
}

// Paging controls must not change an item's measured height when older rows are prepended.
function TranscriptHeader({ context }: { context: TranscriptContext }): ReactNode {
	if (!context.history?.olderCursor) return null;
	return (
		<div className="transcript transcript-virtual">
			<button className="btn" type="button" disabled={context.history.loading} onClick={context.loadOlder}>
				{context.history.loading ? "Loading older messages…" : "Load older messages"}
			</button>
		</div>
	);
}

export function Transcript({
	snapshot,
	host,
	client,
}: {
	snapshot: Snapshot;
	host: ToolRenderHost;
	client?: SessionClient;
}): ReactNode {
	const virtuoso = useRef<VirtuosoHandle>(null);
	const follower = useRef(new ScrollFollow());
	const touchY = useRef<number | undefined>(undefined);
	const [following, setFollowing] = useState(true);
	const [scroller, setScroller] = useState<HTMLElement | null>(null);
	const scrollerRef = useCallback((node: HTMLElement | Window | null) => {
		setScroller(node instanceof HTMLElement ? node : null);
	}, []);
	useLayoutEffect(() => {
		if (!scroller) return;
		const track = () => {
			follower.current.track(scroller);
			setFollowing(follower.current.isFollowing);
		};
		track();
		scroller.addEventListener("scroll", track);
		return () => scroller.removeEventListener("scroll", track);
	}, [scroller]);
	const detach = () => {
		follower.current.detach();
		setFollowing(false);
	};
	useLayoutEffect(() => {
		if (follower.current.isFollowing) virtuoso.current?.autoscrollToBottom();
	}, [snapshot.messages, snapshot.tools]);
	const messages = snapshot.messages.filter(
		message =>
			message.role !== "toolResult" &&
			!((message.role === "custom" || message.role === "hookMessage") && message.display === false),
	);
	const position = useRef({ keys: [] as string[], first: 1_000_000_000 });
	const prepended = messages.findIndex(message => message.key === position.current.keys[0]);
	const removed = position.current.keys.indexOf(messages[0]?.key);
	const firstItemIndex =
		prepended >= 0
			? position.current.first - prepended
			: removed >= 0
				? position.current.first + removed
				: 1_000_000_000;
	position.current = { keys: messages.map(message => message.key), first: firstItemIndex };
	const loadOlder = () => {
		if (!follower.current.isFollowing) void client?.loadOlder();
	};
	const results = new Map<string, Message>();
	for (const message of snapshot.messages)
		if (message.role === "toolResult") results.set(text(message.toolCallId), message);
	const renderMessage = (message: Message): ReactNode => {
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
									if (block.type === "text") return <Markdown key={index} text={text(block.text)} />;
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
					{message.stopReason === "aborted" && <span className="chip chip-err">stopped by you</span>}
					{Boolean(message.errorMessage) && (
						<p role="alert" className="composer-note err">
							{text(message.errorMessage)}
						</p>
					)}
				</div>
			</article>
		);
	};
	return (
		<div
			className="transcript-pane"
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
		>
			{messages.length ? (
				<Virtuoso
					className="scroll"
					ref={virtuoso}
					scrollerRef={scrollerRef}
					role="region"
					aria-label="Transcript"
					tabIndex={0}
					data={messages}
					firstItemIndex={firstItemIndex}
					initialTopMostItemIndex={{ index: "LAST", align: "end" }}
					computeItemKey={(_index, message) => message.key}
					components={{ List: TranscriptList, Header: TranscriptHeader }}
					context={{
						history: snapshot.history,
						loadOlder: () => {
							detach();
							void client?.loadOlder();
						},
					}}
					alignToBottom
					initialItemCount={1}
					followOutput={() => (follower.current.isFollowing ? "auto" : false)}
					startReached={loadOlder}
					atTopThreshold={200}
					atTopStateChange={atTop => {
						if (atTop) loadOlder();
					}}
					atBottomStateChange={atBottom => {
						follower.current.atBottomStateChange(atBottom);
						if (atBottom) {
							setFollowing(true);
							client?.resumeLive();
						}
					}}
					itemContent={(_index, message) => <div className="virtual-entry">{renderMessage(message)}</div>}
				/>
			) : (
				<p className="empty" role="region" aria-label="Transcript">
					{snapshot.phase === "connected"
						? "No messages yet. Send a message to omp."
						: "The transcript will appear after the Mac connects."}
				</p>
			)}
			{(!following || snapshot.history?.newer) && (
				<button
					className="btn jump-latest"
					type="button"
					onClick={() => {
						if (snapshot.history?.newer) void client?.loadLatest();
						follower.current.isFollowing = true;
						virtuoso.current?.scrollToIndex({ index: "LAST", align: "end" });
						setFollowing(true);
					}}
				>
					Jump to latest
				</button>
			)}
		</div>
	);
}
