import { useSyncExternalStore } from "react";
import { STORAGE_KEYS, storage } from "./storage";

/** A local, browser-only profile: a display name and an avatar colour. No server, no email. */
export const AVATAR_COLOURS = [
  { id: "neutral", label: "Neutral", className: "bg-secondary text-foreground" },
  { id: "accent", label: "Accent", className: "bg-primary text-primary-foreground" },
  { id: "green", label: "Green", className: "bg-success text-background" },
  { id: "amber", label: "Amber", className: "bg-warning text-warning-foreground" },
  { id: "red", label: "Red", className: "bg-destructive text-background" },
] as const;
export type AvatarColour = (typeof AVATAR_COLOURS)[number]["id"];
export type LocalProfile = { displayName: string; colour: AvatarColour };

export const DEFAULT_LOCAL_NAME = "Local";
export const MAX_NAME_LENGTH = 40;
export const DEFAULT_PROFILE: LocalProfile = { displayName: "", colour: "neutral" };

export const isAvatarColour = (value: unknown): value is AvatarColour => AVATAR_COLOURS.some(colour => colour.id === value);
export const avatarClassName = (colour: AvatarColour): string => AVATAR_COLOURS.find(entry => entry.id === colour)!.className;

/** Read-tolerant: unknown or malformed fields fall back to defaults. */
export function normalizeProfile(value: unknown): LocalProfile {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const name = typeof input["displayName"] === "string" ? input["displayName"].replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH) : "";
  return { displayName: name, colour: isAvatarColour(input["colour"]) ? input["colour"] : DEFAULT_PROFILE.colour };
}

/** The name shown in menus: the saved one, otherwise the machine default. */
export const effectiveName = (profile: LocalProfile, fallback = DEFAULT_LOCAL_NAME): string => profile.displayName || fallback;

/** Up to two initials from the first and last word; "?" when nothing usable remains. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]!][0] ?? "";
  const last = words.length > 1 ? [...words[words.length - 1]!][0] ?? "" : "";
  return (first + last).toUpperCase() || "?";
}

let current: LocalProfile | undefined;
const listeners = new Set<() => void>();
const read = () => normalizeProfile(storage.readJson<unknown>(STORAGE_KEYS.profile, {}));
export function getLocalProfile(): LocalProfile { return current ??= read(); }
export function setLocalProfile(update: (profile: LocalProfile) => LocalProfile): void {
  current = normalizeProfile(update(getLocalProfile()));
  storage.writeJson(STORAGE_KEYS.profile, current);
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEYS.profile) { current = undefined; listener(); } };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); if (typeof window !== "undefined") window.removeEventListener("storage", onStorage); };
}
export const useLocalProfile = () => useSyncExternalStore(subscribe, getLocalProfile, () => DEFAULT_PROFILE);
