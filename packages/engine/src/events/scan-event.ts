export type ScanEventType =
  | "stage:start"
  | "stage:end"
  | "attack:start"
  | "attack:end"
  | "finding"
  | "verify:result"
  | "thinking"
  | "usage"
  | "error"
  | "user:injected";

export interface ScanEvent {
  type: ScanEventType;
  stage?: string;
  message: string;
  data?: unknown;
  /** Bounded-plan attempt ownership, including concurrent progress. */
  runIndex?: number;
}

export type ScanListener = (event: ScanEvent) => void;
