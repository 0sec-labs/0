/** Plain words for a computer's row: where it runs and what state it is in. Pure. */
const OS: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows", windows: "Windows" };
export const osLabel = (os: string | undefined): string | null => os ? OS[os.toLowerCase()] ?? os : null;

export function computerLine(input: { local: boolean; os?: string; status: string }): string {
  const status = input.status === "connected" ? "Connected" : input.status === "connecting" ? "Connecting…" : "Disconnected";
  return [input.local ? "This computer" : null, osLabel(input.os), status].filter(Boolean).join(" · ");
}
