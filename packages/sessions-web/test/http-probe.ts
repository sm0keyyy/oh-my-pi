export interface ProbeFrame extends Record<string, unknown> {
	type: string;
	id?: string;
	command?: string;
	success?: boolean;
	error?: string;
	data?: Record<string, unknown>;
}
interface HttpProbe {
	source: EventSource;
	request(command: Record<string, unknown>): Promise<ProbeFrame>;
}
declare global {
	interface Window {
		httpProbes: Record<string, HttpProbe>;
	}
}

export async function installHttpProbe(name: string): Promise<void> {
	window.httpProbes ??= {};
	window.httpProbes[name]?.source.close();
	const instanceId = location.pathname.split("/").at(-1);
	const client = crypto.randomUUID();
	const source = new EventSource(`${location.origin}/events/session/${instanceId}?client=${client}`);
	const ready = Promise.withResolvers<void>();
	const pending = new Map<string, { resolve(frame: ProbeFrame): void; reject(error: Error): void; timer: number }>();
	let sequence = 0;
	let epoch = "";
	let queue = Promise.resolve();
	source.onmessage = event => {
		epoch = event.lastEventId.split(":")[0] ?? "";
		const frame: unknown = JSON.parse(event.data);
		if (!frame || typeof frame !== "object" || !("type" in frame) || typeof frame.type !== "string")
			throw new Error("Invalid probe frame");
		if (frame.type === "ready") ready.resolve();
		if (frame.type === "response" && "id" in frame && typeof frame.id === "string") {
			const result = pending.get(frame.id);
			if (result) {
				clearTimeout(result.timer);
				pending.delete(frame.id);
				result.resolve({ ...frame, type: frame.type, id: frame.id });
			}
		}
	};
	window.httpProbes[name] = {
		source,
		request(command) {
			const id = crypto.randomUUID();
			const number = ++sequence;
			const result = Promise.withResolvers<ProbeFrame>();
			const timer = window.setTimeout(() => {
				pending.delete(id);
				result.reject(new Error("Probe timeout"));
			}, 120_000);
			pending.set(id, { ...result, timer });
			queue = queue
				.then(async () => {
					const response = await fetch(`/api/session/${instanceId}`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							"idempotency-key": `${client}:${number}`,
							"x-omp-epoch": epoch,
						},
						body: JSON.stringify({ client, sequence: number, line: JSON.stringify({ ...command, id }) }),
					});
					if (!response.ok) throw new Error(`Probe POST: ${response.status}`);
				})
				.catch(error => {
					clearTimeout(timer);
					pending.delete(id);
					result.reject(error);
				});
			return result.promise;
		},
	};
	await ready.promise;
}
