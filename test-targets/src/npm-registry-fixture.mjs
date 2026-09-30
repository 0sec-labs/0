import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const archive = readFileSync(process.env.NPM_FIXTURE_ARCHIVE);
const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
const server = createServer((request, response) => {
  if (request.url === "/is-odd-3.0.1.tgz") {
    response.end(archive);
    return;
  }
  const version = {
    name: "is-odd", version: "3.0.1", main: "index.js",
    dist: { tarball: `http://127.0.0.1:${server.address().port}/is-odd-3.0.1.tgz`, integrity },
  };
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ name: "is-odd", "dist-tags": { latest: "3.0.1" }, versions: { "3.0.1": version } }));
});
server.listen(0, "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}`));
