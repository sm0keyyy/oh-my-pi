import { afterEach, expect, it } from "bun:test";
import { generateRoomKey, importRoomKey } from "../../src/collab/crypto";
import { CollabSocket } from "../../src/collab/relay-client";

const savedId = process.env.CF_ACCESS_CLIENT_ID;
const savedSecret = process.env.CF_ACCESS_CLIENT_SECRET;
let server: Bun.Server<undefined> | undefined;
const sockets: CollabSocket[] = [];

afterEach(() => {
	for (const socket of sockets.splice(0)) socket.close();
	server?.stop(true);
	server = undefined;
	if (savedId === undefined) delete process.env.CF_ACCESS_CLIENT_ID;
	else process.env.CF_ACCESS_CLIENT_ID = savedId;
	if (savedSecret === undefined) delete process.env.CF_ACCESS_CLIENT_SECRET;
	else process.env.CF_ACCESS_CLIENT_SECRET = savedSecret;
});

for (const role of ["host", "guest"] as const) {
	for (const configured of ["both", "id-only", "secret-only", "neither"] as const) {
		it(`sends Access headers for ${role} only with both credentials (${configured})`, async () => {
			const clientId = crypto.randomUUID();
			const clientSecret = crypto.randomUUID();
			delete process.env.CF_ACCESS_CLIENT_ID;
			delete process.env.CF_ACCESS_CLIENT_SECRET;
			if (configured === "both" || configured === "id-only") process.env.CF_ACCESS_CLIENT_ID = clientId;
			if (configured === "both" || configured === "secret-only") process.env.CF_ACCESS_CLIENT_SECRET = clientSecret;
			const request = Promise.withResolvers<Request>();
			server = Bun.serve<undefined>({
				hostname: "127.0.0.1",
				port: 0,
				fetch(req, srv) {
					request.resolve(req);
					if (srv.upgrade(req)) return;
					return new Response(null, { status: 426 });
				},
				websocket: { message() {} },
			});
			const socket = new CollabSocket({
				wsUrl: `ws://127.0.0.1:${server.port}/r/AccessRoom_123`, role, key: await importRoomKey(generateRoomKey()),
			});
			sockets.push(socket);
			socket.connect();
			const observed = await request.promise;
			expect(new URL(observed.url).searchParams.get("role")).toBe(role);
			expect(observed.headers.get("CF-Access-Client-Id")).toBe(configured === "both" ? clientId : null);
			expect(observed.headers.get("CF-Access-Client-Secret")).toBe(configured === "both" ? clientSecret : null);
		});
	}
}
