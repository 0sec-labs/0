import { createHash } from "node:crypto";
type CloudSinkConfig = { sinkUrl: string; scanId: string; token?: string; orgId?: string };
function getCloudSinkConfig(): CloudSinkConfig | null {
  if (process.env["ZERO_FEATURE_CLOUD_SINK"] === "0") return null;
  const sinkUrl = process.env["ZERO_CLOUD_SINK"]?.trim();
  const scanId = process.env["ZERO_CLOUD_SCAN_ID"]?.trim();
  if (!sinkUrl || !scanId) return null;
  return { sinkUrl, scanId, token: process.env["ZERO_CLOUD_TOKEN"]?.trim() || undefined,
    orgId: process.env["ZERO_CLOUD_ORG_ID"]?.trim() || undefined };
}

/** Upload full PNG bytes, never the truncated model-facing preview. */
export async function retainBrowserScreenshot(base64: string, signal?: AbortSignal, sourceUrl?: string, caption = "Browser observation"): Promise<{ sha256: string; reference: string } | null> {
  const config = getCloudSinkConfig();
  if (!config) return null;
  if (base64.length > 2_800_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error("Invalid screenshot size or encoding");
  const body = Buffer.from(base64, "base64");
  if (body.length > 2 * 1024 * 1024 || !body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("Invalid PNG screenshot");
  let url: string | null = null;
  try { const parsed = new URL(sourceUrl ?? ""); if (["http:", "https:"].includes(parsed.protocol)) { parsed.username = ""; parsed.password = ""; parsed.search = ""; parsed.hash = ""; url = parsed.href.slice(0,1024); } } catch { /* No target URL was recorded. */ }
  const metadata = encodeURIComponent(JSON.stringify({ caption: caption.slice(0,200), url }));
  const sha256 = createHash("sha256").update(body).digest("hex");
  const response = await fetch(`${config.sinkUrl.replace(/\/$/, "")}/scans/${encodeURIComponent(config.scanId)}/artifacts`, {
    method: "POST", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    headers: { "content-type": "image/png", "content-length": String(body.length), "x-0-artifact-sha256": sha256, "x-0-browser-evidence": metadata,
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {}), ...(config.orgId ? { "X-0-Org-Id": config.orgId } : {}) },
    body,
  });
  if (!response.ok) throw new Error("Screenshot retention unavailable");
  const text = await response.text();
  if (text.length > 16384) throw new Error("Invalid screenshot receipt");
  const receipt = JSON.parse(text).artifact;
  const expected = `0-scan-artifact/v1/${config.scanId}/${sha256}`;
  if (receipt?.sha256 !== sha256 || receipt?.reference !== expected || receipt?.media_type !== "image/png" || receipt?.size_bytes !== body.length) throw new Error("Invalid screenshot receipt");
  return { sha256, reference: expected };
}
