import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import { constants, createGzip } from "node:zlib";

export const HEARTBEAT_MS = 10_000;
const HEARTBEAT = new TextEncoder().encode(":\nevent: heartbeat\ndata:\n\n");
export type StreamCloseReason = "peer_abort" | "cancelled" | "replaced" | "backpressure" | "shutdown" | "idle_timeout";
export const SSE_HEADERS = {
	"content-type": "text/event-stream",
	"cache-control": "no-store, no-transform",
	"x-accel-buffering": "no",
	vary: "Accept-Encoding",
};
interface Entry {
	sequence: number;
	bytes: Uint8Array;
	recipient?: string;
}
interface Subscriber {
	controller: ReadableStreamDefaultController<Uint8Array>;
	recipient?: string;
	close(reason: StreamCloseReason): void;
}

export function acceptsGzip(header: string | null): boolean {
	const encodings = (header ?? "")
		.toLowerCase()
		.split(",")
		.map(part => {
			const [name, ...parameters] = part.trim().split(";");
			const quality = parameters.find(parameter => parameter.trim().startsWith("q="));
			const q = quality === undefined ? 1 : Number(quality.trim().slice(2));
			return { name: name.trim(), q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0 };
		});
	return (
		((encodings.find(encoding => encoding.name === "gzip") ?? encodings.find(encoding => encoding.name === "*"))?.q ??
			0) > 0
	);
}

export class ReplayJournal {
	readonly epoch = randomUUID();
	#sequence = 0;
	#bytes = 0;
	#entries: Entry[] = [];
	#subscribers = new Set<Subscriber>();
	constructor(
		readonly maxEvents = 1024,
		readonly maxBytes = 2 * 1024 * 1024,
		readonly heartbeatMs = HEARTBEAT_MS,
	) {}
	get id(): string {
		return `${this.epoch}:${this.#sequence}`;
	}
	get startId(): string {
		return `${this.epoch}:${(this.#entries[0]?.sequence ?? this.#sequence + 1) - 1}`;
	}
	get bytes(): number {
		return this.#bytes;
	}
	sequence(id: string): number | undefined {
		const [epoch, raw, extra] = id.split(":");
		const sequence = Number(raw);
		return epoch === this.epoch &&
			extra === undefined &&
			/^\d+$/.test(raw ?? "") &&
			Number.isSafeInteger(sequence) &&
			sequence >= 0 &&
			sequence <= this.#sequence
			? sequence
			: undefined;
	}
	canResume(id: string): boolean {
		const sequence = this.sequence(id);
		return sequence !== undefined && sequence >= (this.#entries[0]?.sequence ?? this.#sequence + 1) - 1;
	}
	append(data: string, recipient?: string, retainUnacked = false): boolean {
		const bytes = new TextEncoder().encode(`id: ${this.epoch}:${this.#sequence + 1}\ndata: ${data}\n\n`);
		if (
			bytes.byteLength > this.maxBytes ||
			(retainUnacked && (this.#entries.length >= this.maxEvents || this.#bytes + bytes.byteLength > this.maxBytes))
		)
			return false;
		const entry = { sequence: ++this.#sequence, bytes, recipient };
		this.#entries.push(entry);
		this.#bytes += bytes.byteLength;
		while (this.#entries.length > this.maxEvents || this.#bytes > this.maxBytes)
			this.#bytes -= this.#entries.shift()!.bytes.byteLength;
		for (const subscriber of this.#subscribers) this.#deliver(subscriber, entry);
		return true;
	}
	ack(id: string): void {
		const sequence = this.sequence(id);
		if (sequence === undefined) return;
		while (this.#entries[0] && this.#entries[0].sequence <= sequence)
			this.#bytes -= this.#entries.shift()!.bytes.byteLength;
	}
	#deliver(subscriber: Subscriber, entry: Entry): void {
		if (!this.#subscribers.has(subscriber)) return;
		if ((subscriber.controller.desiredSize ?? 0) < 0) {
			subscriber.close("backpressure");
			return;
		}
		subscriber.controller.enqueue(
			entry.recipient && entry.recipient !== subscriber.recipient
				? new TextEncoder().encode(`id: ${this.epoch}:${entry.sequence}\ndata: {"type":"cursor"}\n\n`)
				: entry.bytes,
		);
	}
	open(
		request: Request,
		recipient?: string,
		onClose = (_reason: StreamCloseReason): void => {},
		from = request.headers.get("last-event-id") ?? "",
	): Response {
		if (recipient)
			for (const subscriber of this.#subscribers)
				if (subscriber.recipient === recipient) {
					subscriber.close("replaced");
				}
		const sequence = from ? this.sequence(from) : this.#sequence;
		let subscriber: Subscriber;
		// A named heartbeat also lets Safari detect a half-open stream after suspension.
		const heartbeat = setInterval(() => {
			// Heartbeats are disposable. Never disconnect a quiet reader because a proxy is draining.
			if ((subscriber.controller.desiredSize ?? 0) > 0) subscriber.controller.enqueue(HEARTBEAT);
		}, this.heartbeatMs);
		heartbeat.unref();
		const cleanup = (reason: StreamCloseReason): void => {
			clearInterval(heartbeat);
			if (!this.#subscribers.delete(subscriber)) return;
			request.signal.removeEventListener("abort", abort);
			onClose(reason);
		};
		const abort = (): void => {
			subscriber.close("peer_abort");
		};
		const body = new ReadableStream<Uint8Array>(
			{
				start: controller => {
					subscriber = {
						controller,
						recipient,
						close(reason) {
							controller.close();
							cleanup(reason);
						},
					};
					this.#subscribers.add(subscriber);
					request.signal.addEventListener("abort", abort, { once: true });
					controller.enqueue(new TextEncoder().encode("retry: 1000\n\n"));
					if (sequence !== undefined)
						for (const entry of this.#entries) if (entry.sequence > sequence) this.#deliver(subscriber, entry);
					if (request.signal.aborted) subscriber.close("peer_abort");
				},
				cancel: () => cleanup("cancelled"),
			},
			new ByteLengthQueuingStrategy({ highWaterMark: this.maxBytes }),
		);
		if (acceptsGzip(request.headers.get("accept-encoding"))) {
			// Node's adapter and the browser type lib declare different versions of the same Web stream API.
			const gzip = Duplex.toWeb(createGzip({ flush: constants.Z_SYNC_FLUSH })) as unknown as ReadableWritablePair<
				Uint8Array,
				Uint8Array
			>;
			return new Response(body.pipeThrough(gzip), { headers: { ...SSE_HEADERS, "content-encoding": "gzip" } });
		}
		return new Response(body, { headers: SSE_HEADERS });
	}
	close(reason: StreamCloseReason = "shutdown"): void {
		for (const subscriber of this.#subscribers) subscriber.close(reason);
	}
}
