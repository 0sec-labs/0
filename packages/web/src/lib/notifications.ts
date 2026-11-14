import { useSyncExternalStore } from "react";
import { NOTIFICATION_EVENTS, type NotificationEvent } from "@/console/notification-transitions";
import { STORAGE_KEYS, storage } from "./storage";

/** Browser-only notifications: the Web Notification API plus a synthesized chime. Nothing leaves this browser. */
export type NotificationPrefs = { enabled: boolean; sound: boolean; onlyWhenHidden: boolean; events: Record<NotificationEvent, boolean> };

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: false, sound: true, onlyWhenHidden: true,
  events: { "mission-finished": true, "mission-approval": true, "mission-question": true, "scan-finished": true, "fix-ready": true },
};

/** Read-tolerant: unknown or malformed fields fall back to defaults. */
export function normalizePrefs(value: unknown): NotificationPrefs {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const events = input.events && typeof input.events === "object" ? input.events as Record<string, unknown> : {};
  const bool = (raw: unknown, fallback: boolean) => typeof raw === "boolean" ? raw : fallback;
  return {
    enabled: bool(input.enabled, DEFAULT_NOTIFICATION_PREFS.enabled),
    sound: bool(input.sound, DEFAULT_NOTIFICATION_PREFS.sound),
    onlyWhenHidden: bool(input.onlyWhenHidden, DEFAULT_NOTIFICATION_PREFS.onlyWhenHidden),
    events: Object.fromEntries(NOTIFICATION_EVENTS.map(event => [event.id, bool(events[event.id], DEFAULT_NOTIFICATION_PREFS.events[event.id])])) as Record<NotificationEvent, boolean>,
  };
}

export type NotificationPermissionState = "granted" | "denied" | "default" | "unsupported";

/** Pure delivery rule. Permission is checked by the caller's environment; here it is an input. */
export function shouldDeliver(prefs: NotificationPrefs, event: NotificationEvent, context: { hidden: boolean; permission: NotificationPermissionState }): boolean {
  if (!prefs.enabled || !prefs.events[event] || context.permission !== "granted") return false;
  return !prefs.onlyWhenHidden || context.hidden;
}

let current: NotificationPrefs | undefined;
const listeners = new Set<() => void>();
const read = () => normalizePrefs(storage.readJson<unknown>(STORAGE_KEYS.notificationPrefs, {}));
export function getNotificationPrefs(): NotificationPrefs { return current ??= read(); }
export function setNotificationPrefs(update: (prefs: NotificationPrefs) => NotificationPrefs): void {
  current = normalizePrefs(update(getNotificationPrefs()));
  storage.writeJson(STORAGE_KEYS.notificationPrefs, current);
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEYS.notificationPrefs) { current = undefined; listener(); } };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); if (typeof window !== "undefined") window.removeEventListener("storage", onStorage); };
}
export const useNotificationPrefs = () => useSyncExternalStore(subscribe, getNotificationPrefs, () => DEFAULT_NOTIFICATION_PREFS);

export function notificationPermission(): NotificationPermissionState {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}
/** Must be called from a user gesture. */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof Notification === "undefined") return "unsupported";
  try { await Notification.requestPermission(); } catch { /* older browsers throw; the state below is authoritative */ }
  return notificationPermission();
}

let audio: AudioContext | undefined;
/** Two soft sine tones, synthesized: no remote or bundled asset. Silent when audio is blocked. */
export function playChime(): void {
  try {
    const Ctor = typeof window === "undefined" ? undefined : window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audio ??= new Ctor();
    void audio.resume().catch(() => {});
    const start = audio.currentTime;
    [660, 880].forEach((frequency, index) => {
      const osc = audio!.createOscillator(); const gain = audio!.createGain();
      const at = start + index * 0.14;
      osc.type = "sine"; osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      osc.connect(gain).connect(audio!.destination);
      osc.start(at); osc.stop(at + 0.32);
    });
  } catch { /* audio is best-effort */ }
}

/** Show one notification. Text is the event title plus the mission title only; never transcript or finding content. */
export function showNotification(options: { title: string; body?: string; tag?: string; sound?: boolean; onClick?: () => void }): boolean {
  if (notificationPermission() !== "granted") return false;
  try {
    const notification = new Notification(options.title, { body: options.body, tag: options.tag });
    notification.onclick = () => { try { window.focus(); } catch { /* ignore */ } notification.close(); options.onClick?.(); };
  } catch { return false; }
  if (options.sound) playChime();
  return true;
}
