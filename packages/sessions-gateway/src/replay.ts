import { randomUUID } from "node:crypto";

export const SSE_HEADERS = {
	"content-type": "text/event-stream",
	"cache-control": "no-cache, no-transform",
	"x-accel-buffering": "no",
};
interface Entry {
	sequence: number;
	bytes: Uint8Array;
	recipient?: string;
}
interface Subscriber {
	controller: ReadableStreamDefaultController<Uint8Array>;
	recipient?: string;
	close(): void;
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
			subscriber.controller.close();
			subscriber.close();
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
		onClose = (): void => {},
		from = request.headers.get("last-event-id") ?? "",
	): Response {
		if (recipient)
			for (const subscriber of this.#subscribers)
				if (subscriber.recipient === recipient) {
					subscriber.controller.close();
					subscriber.close();
				}
		const sequence = from ? this.sequence(from) : this.#sequence;
		let subscriber: Subscriber;
		const cleanup = (): void => {
			if (!this.#subscribers.delete(subscriber)) return;
			request.signal.removeEventListener("abort", abort);
			onClose();
		};
		const abort = (): void => {
			subscriber.controller.close();
			cleanup();
		};
		const body = new ReadableStream<Uint8Array>(
			{
				start: controller => {
					subscriber = { controller, recipient, close: cleanup };
					this.#subscribers.add(subscriber);
					request.signal.addEventListener("abort", abort, { once: true });
					controller.enqueue(new TextEncoder().encode("retry: 250\n\n"));
					if (sequence !== undefined)
						for (const entry of this.#entries) if (entry.sequence > sequence) this.#deliver(subscriber, entry);
				},
				cancel: cleanup,
			},
			new ByteLengthQueuingStrategy({ highWaterMark: this.maxBytes }),
		);
		return new Response(body, { headers: SSE_HEADERS });
	}
	close(): void {
		for (const subscriber of this.#subscribers) {
			subscriber.controller.close();
			subscriber.close();
		}
	}
}
