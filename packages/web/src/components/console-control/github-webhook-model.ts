export type WebhookResult = "received" | "ignored" | "rejected";
export interface WebhookDelivery { at: string; result: WebhookResult; event?: string; reason?: string }
export interface GitHubWebhookStatus {
  serverMode: boolean;
  configured?: boolean;
  payloadUrl?: string;
  contentType?: string;
  events?: string[];
  lastDeliveryAt?: string;
  lastResult?: WebhookResult;
  lastReason?: string;
  graceUntil?: string;
  deliveries?: WebhookDelivery[];
}

/** The card exists only for a server-mode engine; an older engine answers 404 and shows nothing too. */
export const webhookVisible = (status: GitHubWebhookStatus | undefined): status is GitHubWebhookStatus & { serverMode: true } => status?.serverMode === true;

const REASONS: Record<string, string> = {
  invalid_signature: "wrong signature", signature_missing_or_malformed: "no valid signature", body_too_large: "body too large", content_type: "wrong content type",
  rate_limited_source: "too many requests", rate_limited_global: "too many requests", duplicate_delivery: "already seen", event_not_allowed: "event not used",
  action_not_allowed: "action not used", no_matching_trigger: "no matching trigger", pull_request_not_open: "pull request not open", payload_shape: "unexpected payload",
  delivery_id: "no delivery id", malformed_json: "not JSON", body_timeout: "timed out", body_read: "unreadable body", content_length: "bad length",
};
/** Plain words for the audit reason; `received` carries "action:count" which is shown as the action. */
export function deliveryReason(delivery: WebhookDelivery): string {
  if (!delivery.reason) return "";
  if (delivery.result === "received") return delivery.reason.split(":")[0]!.replaceAll("_", " ");
  return REASONS[delivery.reason] ?? delivery.reason.replaceAll("_", " ");
}
export function deliveryLine(delivery: WebhookDelivery): string {
  return [delivery.result, delivery.event?.replaceAll("_", " "), deliveryReason(delivery)].filter(Boolean).join(" · ");
}
export function statusLine(status: GitHubWebhookStatus, ageText: (iso: string) => string): string {
  if (!status.lastDeliveryAt) return "No deliveries yet. Polling still works.";
  return `Last delivery ${ageText(status.lastDeliveryAt)}: ${status.lastResult ?? "unknown"}${status.lastReason ? ` (${deliveryReason({ at: status.lastDeliveryAt, result: status.lastResult ?? "ignored", reason: status.lastReason })})` : ""}`;
}
