import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { NOTIFICATION_EVENTS } from "@/console/notification-transitions";
import { notificationPermission, requestNotificationPermission, setNotificationPrefs, showNotification, useNotificationPrefs, type NotificationPermissionState } from "@/lib/notifications";
import { SettingsRow, SettingsSection } from "./settings-section";

const PERMISSION_TEXT: Record<NotificationPermissionState, string> = {
  granted: "Allowed in this browser.",
  denied: "Blocked in browser settings.",
  default: "Not asked yet.",
  unsupported: "Not supported here.",
};

/** Browser-only notifications. Nothing is sent to a server; they fire while this app is open in a tab. */
export function NotificationsSettings() {
  const prefs = useNotificationPrefs();
  const [permission, setPermission] = useState(notificationPermission);
  const [tested, setTested] = useState<"sent" | "failed" | null>(null);
  const granted = permission === "granted";
  return <div className="flex flex-col gap-10">
    <SettingsSection id="settings-notifications" title="Browser notifications">
      <SettingsRow id="setting-notifications-enabled" label="Notify me">
        <Switch aria-label="Notify me" checked={granted && prefs.enabled} disabled={!granted} onCheckedChange={enabled => setNotificationPrefs(current => ({ ...current, enabled }))} />
      </SettingsRow>
      <SettingsRow id="setting-notifications-permission" label="Browser permission" description={PERMISSION_TEXT[permission]}>
        {permission === "default" && <Button variant="accent" size="sm" onClick={() => { void requestNotificationPermission().then(state => { setPermission(state); if (state === "granted") setNotificationPrefs(current => ({ ...current, enabled: true })); }); }}>Enable browser notifications</Button>}
      </SettingsRow>
      <SettingsRow id="setting-notifications-hidden" label="Only when this tab is hidden">
        <Switch aria-label="Only when this tab is hidden" checked={granted && prefs.onlyWhenHidden} disabled={!granted} onCheckedChange={onlyWhenHidden => setNotificationPrefs(current => ({ ...current, onlyWhenHidden }))} />
      </SettingsRow>
      <SettingsRow id="setting-notifications-sound" label="Play a sound">
        <Switch aria-label="Play a sound" checked={granted && prefs.sound} disabled={!granted} onCheckedChange={sound => setNotificationPrefs(current => ({ ...current, sound }))} />
      </SettingsRow>
      <SettingsRow id="setting-notifications-test" label="Send a test notification" description={tested === "sent" ? "Sent." : tested === "failed" ? "Could not send." : undefined}>
        <Button variant="outline" size="sm" disabled={!granted} onClick={() => setTested(showNotification({ title: "Test notification", body: "Notifications are working.", tag: "0-test", sound: prefs.sound }) ? "sent" : "failed")}>Send test</Button>
      </SettingsRow>
    </SettingsSection>
    <SettingsSection id="settings-notifications-events" title="Notify me when">
      {NOTIFICATION_EVENTS.map(event => <SettingsRow key={event.id} id={`setting-notifications-${event.id}`} label={event.label}>
        <Switch aria-label={event.label} checked={granted && prefs.enabled && prefs.events[event.id]} disabled={!granted || !prefs.enabled} onCheckedChange={on => setNotificationPrefs(current => ({ ...current, events: { ...current.events, [event.id]: on } }))} />
      </SettingsRow>)}
    </SettingsSection>
  </div>;
}
