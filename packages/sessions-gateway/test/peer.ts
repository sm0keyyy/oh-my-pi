export class Peer {
	readonly ws: WebSocket;
	readonly opened = Promise.withResolvers<void>();
	readonly closed = Promise.withResolvers<CloseEvent>();
	readonly messages: string[] = [];
	readonly waiters: Array<(message: string) => void> = [];
	constructor(url: string, headers: Record<string, string> = {}) {
		this.ws = new WebSocket(url, { headers });
		this.ws.onopen = () => this.opened.resolve();
		this.ws.onerror = () => this.opened.reject(new Error("WebSocket connection failed"));
		this.ws.onclose = event => this.closed.resolve(event);
		this.ws.onmessage = event => {
			if (typeof event.data !== "string") throw new Error("Expected a text frame");
			const waiter = this.waiters.shift();
			if (waiter) waiter(event.data);
			else this.messages.push(event.data);
		};
	}
	async next(): Promise<string> {
		if (this.messages.length) return this.messages.shift()!;
		const next = Promise.withResolvers<string>();
		this.waiters.push(next.resolve);
		return next.promise;
	}
}
