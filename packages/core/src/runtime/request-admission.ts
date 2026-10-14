/** Explicit hosted transport limits. Token windows are a separate contract. */
export interface RequestAdmission {
  maxBodyBytes: number;
  maxSerializedInputBytes: number | null;
  baseBytes: number;
  perMessageBytes: number;
  perToolBytes: number;
}
export const LOCAL_ADMISSION_LIMIT = "LOCAL_REQUEST_ADMISSION_LIMIT:";
export function parseRequestAdmission(catalog: unknown, model: string): RequestAdmission {
  const data = (catalog as { data?: unknown })?.data;
  const row = Array.isArray(data) ? data.find(r => r?.id === model) : undefined;
  const c = row?.request_admission;
  const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
  if (!c || c.schema !== "0-inference-request-admission-v1" ||
      c.counting !== "utf8_json_body_plus_framing" || !integer(c.max_body_bytes) || c.max_body_bytes < 1 ||
      !(c.max_serialized_input_bytes === null || (integer(c.max_serialized_input_bytes) && c.max_serialized_input_bytes > 0)) ||
      !integer(c.framing?.base_bytes) || !integer(c.framing?.per_message_bytes) || !integer(c.framing?.per_tool_bytes)) {
    throw new Error("Gateway request admission contract is missing or invalid; no inference request sent");
  }
  return { maxBodyBytes: c.max_body_bytes, maxSerializedInputBytes: c.max_serialized_input_bytes,
    baseBytes: c.framing.base_bytes, perMessageBytes: c.framing.per_message_bytes, perToolBytes: c.framing.per_tool_bytes };
}
export function assertRequestAdmission(body: string, contract: RequestAdmission): void {
  const value = JSON.parse(body);
  const messages = value.messages ?? value.input;
  const bytes = Buffer.byteLength(body, "utf8");
  const inputBytes = bytes + contract.baseBytes + contract.perMessageBytes * (Array.isArray(messages) ? messages.length : 1) +
    contract.perToolBytes * (Array.isArray(value.tools) ? value.tools.length : 0);
  if (bytes > contract.maxBodyBytes || (contract.maxSerializedInputBytes !== null && inputBytes > contract.maxSerializedInputBytes)) {
    throw new Error(`${LOCAL_ADMISSION_LIMIT} body=${bytes}, input=${inputBytes}; exceeds gateway byte limit before dispatch`);
  }
}
export function isLocalAdmissionLimit(error?: string): boolean { return error?.startsWith(LOCAL_ADMISSION_LIMIT) === true; }
