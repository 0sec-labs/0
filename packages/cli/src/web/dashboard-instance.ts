import { get } from "node:http";

/** Identify our local UI without starting another gateway or scheduler. */
export function findDashboardInstance(origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(`${origin}/console`, (response) => {
      let html = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        html += chunk;
        if (html.length > 256_000) request.destroy(new Error("Response too large"));
      });
      response.on("end", () => resolve(response.statusCode === 200
        && /<meta\s+name="0-control-token"\s+content="[^"]+"/.test(html)));
      response.on("error", () => resolve(false));
    });
    request.setTimeout(1_000, () => request.destroy(new Error("Dashboard probe timed out")));
    request.on("close", () => resolve(false));
    request.on("error", () => resolve(false));
  });
}
