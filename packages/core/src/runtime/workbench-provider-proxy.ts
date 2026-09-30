import { isAdmittedSmolvmWorkbench } from "./smolvm-broker.js";

/** Non-secret local transport metadata, valid only inside an admitted guest. */
export function resolveWorkbenchProviderProxy(env: Readonly<NodeJS.ProcessEnv>): { url: string; model: string } | undefined {
  const raw = env.ZERO_WORKBENCH_PROVIDER_PROXY;
  if (!raw) return undefined;
  if (!isAdmittedSmolvmWorkbench()) throw new Error("Provider proxy requires authenticated SmolVM workbench admission");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Invalid guest provider proxy address"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/provider/request" ||
    url.username || url.password || url.search || url.hash) throw new Error("Provider proxy must be the fixed guest loopback route");
  const model = env.ZERO_WORKBENCH_PROVIDER_MODEL;
  if (!model || !/^[A-Za-z0-9._-]{1,128}$/.test(model)) throw new Error("Missing exact workbench provider model");
  return { url: url.href, model };
}
