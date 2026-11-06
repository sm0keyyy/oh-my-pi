import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

export async function parentSessionId(sessionFile: string | null | undefined): Promise<string | undefined> {
	if (!sessionFile) return undefined;
	const start = path.resolve(sessionFile);
	let current = start;
	for (let depth = 0; depth < 8; depth++) {
		const parent = `${path.dirname(current)}.jsonl`;
		try {
			await fs.stat(parent);
			current = parent;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			break;
		}
	}
	if (current === start) return undefined;
	const handle = await fs.open(current, "r");
	try {
		const buffer = Buffer.alloc(16_384);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		for (const line of buffer.toString("utf8", 0, bytesRead).split("\n")) {
			try {
				const header: unknown = JSON.parse(line);
				if (
					typeof header === "object" &&
					header !== null &&
					"type" in header &&
					header.type === "session" &&
					"id" in header &&
					typeof header.id === "string"
				)
					return header.id;
			} catch {
				/* A partial trailing line cannot be a header. */
			}
		}
	} finally {
		await handle.close();
	}
	return undefined;
}

export async function originSessionId(source: {
	getSessionId(): string | null | undefined;
	getSessionFile(): string | null | undefined;
}): Promise<string | undefined> {
	try {
		return (await parentSessionId(source.getSessionFile())) ?? source.getSessionId() ?? undefined;
	} catch {
		return source.getSessionId() ?? undefined;
	}
}
