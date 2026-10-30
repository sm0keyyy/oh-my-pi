import { readSseEvents } from "@oh-my-pi/pi-utils/stream";

export class Peer {
	readonly opened = Promise.withResolvers<Response>();
	readonly closed = Promise.withResolvers<void>();
	readonly messages: string[] = [];
	readonly ids: string[] = [];
	readonly waiters: Array<{ resolve(value: string): void; reject(error: unknown): void }> = [];
	readonly controller = new AbortController();
	readonly client: string;
	readonly headers: Record<string, string>;
	lastId = "";
	sequence = 0;
	constructor(
		readonly url: string,
		headers: Record<string, string> = {},
		cursor = "",
		client: string = crypto.randomUUID(),
	) {
		this.client = client;
		this.headers = headers;
		const target = new URL(url);
		if (!target.pathname.endsWith("/bridge")) target.searchParams.set("client", client);
		void this.read(target, cursor);
	}
	async read(target: URL, cursor: string): Promise<void> {
		try {
			const response = await fetch(target, {
				headers: { ...this.headers, ...(cursor ? { "last-event-id": cursor } : {}) },
				signal: this.controller.signal,
			});
			if (!response.ok || !response.body) throw new Error(`Stream rejected: ${response.status}`);
			this.opened.resolve(response);
			for await (const event of readSseEvents(response.body, this.controller.signal)) {
				if (!event.data) continue;
				this.lastId = event.id ?? "";
				this.ids.push(this.lastId);
				const waiter = this.waiters.shift();
				if (waiter) waiter.resolve(event.data);
				else this.messages.push(event.data);
			}
		} catch (cause) {
			if (!this.controller.signal.aborted) {
				this.opened.reject(cause);
				for (const waiter of this.waiters.splice(0)) waiter.reject(cause);
			}
		} finally {
			this.closed.resolve();
		}
	}
	next(): Promise<string> {
		if (this.messages.length) return Promise.resolve(this.messages.shift()!);
		const pending = Promise.withResolvers<string>();
		this.waiters.push(pending);
		return pending.promise;
	}
	close(): void {
		this.controller.abort();
	}
	async send(line: string, sequence = ++this.sequence): Promise<Response> {
		const target = new URL(this.url);
		target.pathname = target.pathname.replace("/events/session/", "/api/session/");
		return fetch(target, {
			method: "POST",
			headers: {
				...this.headers,
				"content-type": "application/json",
				"idempotency-key": `${this.client}:${sequence}`,
				"x-omp-epoch": this.lastId.split(":")[0]!,
			},
			body: JSON.stringify({ client: this.client, sequence, line }),
		});
	}
}
