import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { findDashboardInstance } from "./dashboard-instance.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
async function serve(body: string, status = 200) {
  const server = createServer((_request, response) => { response.writeHead(status); response.end(body); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}
it("recognizes the existing dashboard", async () => {
  expect(await findDashboardInstance(await serve('<meta name="0-control-token" content="test-token">'))).toBe(true);
});
it("does not reuse an unrelated server or error response", async () => {
  expect(await findDashboardInstance(await serve("Other application"))).toBe(false);
  expect(await findDashboardInstance(await serve('<meta name="0-control-token" content="test-token">', 500))).toBe(false);
});
it("handles a closed port", async () => {
  const origin = await serve("");
  await new Promise<void>(resolve => servers.pop()!.close(() => resolve()));
  expect(await findDashboardInstance(origin)).toBe(false);
});
