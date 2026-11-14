import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = path.resolve("public");

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/file") {
    const name = url.searchParams.get("name");
    const data = fs.readFileSync(path.join(ROOT, name), "utf8");
    res.end(data);
    return;
  }
  if (url.pathname === "/log") {
    const branch = url.searchParams.get("branch");
    const out = execSync("git log --oneline " + branch).toString();
    res.end(out);
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(8080);
