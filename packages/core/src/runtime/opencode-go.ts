/** Match the actual Go destination, not a provider label or lookalike origin. */
export function isOpenCodeGoEndpoint(destination: URL): boolean {
  return destination.origin === "https://opencode.ai" && !destination.username && !destination.password &&
    /^\/(?:inference\/go\/(?:openai\/v1|anthropic\/v1|google\/v1beta)|zen\/go\/v1)(?:\/|$)/.test(destination.pathname);
}

/** Published Go limits when its /models response omits context metadata.
 * https://models.opencode.ai/providers/opencode-go/ (checked 2026-11-10).
 * Exact IDs only: similarly named Zen/free routes can have smaller windows.
 */
const GO_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "deepseek-v4.1-flash": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
  "glm-5.2": 1_000_000,
  "glm-5.3": 1_000_000,
};

export function publishedOpenCodeGoContext(destination: URL, model: string): number | undefined {
  return isOpenCodeGoEndpoint(destination) && Object.hasOwn(GO_CONTEXT_WINDOWS, model)
    ? GO_CONTEXT_WINDOWS[model] : undefined;
}
