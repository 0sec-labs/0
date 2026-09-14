/** @jsxImportSource @opentui/react */
import React, { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { useHarness } from "./harness-context.js";
import { HarnessViewPanel } from "./harness-view.js";
import { useTheme } from "./theme-context.js";
import { useSymbols } from "./symbol-context.js";
import { operatorIcon, operatorTitle } from "./operator-icons.js";
import { fitTuiText } from "./text.js";

/** The dialog title row: glyph plus its label, never a glyph alone. */
function HarnessTitle({ contentWidth }: { contentWidth: number }) {
  const theme = useTheme();
  const symbols = useSymbols();
  return <text fg={theme.PRIMARY} flexShrink={0}>
    {fitTuiText(`${operatorIcon("harness", symbols)} ${operatorTitle("harness")}`, contentWidth)}
  </text>;
}

/**
 * One host-owned control surface; contributed views cannot replace its escape
 * actions.
 *
 * PERMISSION AUTHORITY. The trust grant, its confirmation gate, its wording and
 * its keys are unchanged by the dialog presentation: `t` still toggles, the
 * grant still requires an explicit `y` against the exact canonical workspace
 * root captured when the prompt opened, and nothing is ever widened,
 * pre-selected or auto-granted. The footer only names keys that are actually
 * bound in the current state.
 */
export function HarnessControlsPanel({ contentWidth, onBack }: { contentWidth: number; onBack: () => void }) {
  const harness = useHarness();
  const theme = useTheme();
  const [confirmTrust, setConfirmTrust] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  const [showIdentity, setShowIdentity] = useState(false);
  const [confirmationRoot, setConfirmationRoot] = useState("");
  const snapshot = harness.snapshot;
  const conversation = () => { harness.setShowConversation(true); onBack(); };
  const liveView = () => { harness.setShowConversation(false); onBack(); };
  const toggleTrust = () => {
    if (harness.workspaceTrusted) void harness.setWorkspaceTrusted(false);
    else { setConfirmationRoot(harness.workspaceRoot); setConfirmTrust(true); }
  };
  useKeyboard(key => {
    if (showCatalog) return; // The mounted picker owns input, including text editing.
    if (confirmTrust) {
      if (key.name === "escape" || key.name === "n") setConfirmTrust(false);
      else if (key.name === "y" && confirmationRoot === harness.workspaceRoot) {
        setConfirmTrust(false);
        void harness.setWorkspaceTrusted(true);
      }
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.name === "escape") onBack();
    else if (key.name === "s") conversation();
    else if (key.name === "v") setShowCatalog(true);
    else if (key.name === "t") toggleTrust();
    else if (key.name === "l") setShowIdentity(value => !value);
    else if (key.name === "r" && snapshot?.previousGenerationId) void harness.control({ action: "rollback" });
    else if (key.name === "d" && (snapshot?.generationId || snapshot?.pendingGenerationId)) void harness.control({ action: "disable" });
    else if (key.name === "u" && snapshot?.trustedUi.some(entry => entry.tui) && harness.workspaceTrusted) liveView();
  });
  if (showCatalog) return <HarnessViewPanel contentWidth={contentWidth} onBack={() => setShowCatalog(false)} />;
  if (confirmTrust) return <box flexDirection="column" width="100%">
    <HarnessTitle contentWidth={contentWidth} />
    <text fg={theme.WARNING}>Allow trusted workspace ESM?</text>
    <text fg={theme.TEXT} wrapMode="word">{`Workspace: ${confirmationRoot}`}</text>
    <text fg={theme.TEXT} wrapMode="word">Trusted providers and UI run arbitrary code with your full host privileges, including credentials, network, files and child processes. This grant applies to this canonical workspace, not just one generation. It is separate from self-extension.</text>
    <text fg={theme.WARNING}>y grants trust · n / Esc cancels</text>
  </box>;
  // The footer names only the keys this state actually binds, in the order the
  // controls are listed above it.
  const hints = ["s show conversation"];
  if (snapshot) hints.push("v views/commands/settings");
  if (snapshot?.trustedUi.some(entry => entry.tui) && harness.workspaceTrusted) hints.push("u live view");
  if (snapshot?.previousGenerationId) hints.push("r roll back");
  if (snapshot?.generationId || snapshot?.pendingGenerationId) hints.push("d disable");
  hints.push(`t ${harness.workspaceTrusted ? "revoke" : "grant"} trust`);
  if (snapshot) hints.push("l generation details");
  hints.push("esc back");

  return <box flexDirection="column" width="100%" flexGrow={1} minHeight={0}>
    <HarnessTitle contentWidth={contentWidth} />
    <text fg={theme.TEXT} wrapMode="word">{snapshot ? `${snapshot.label} · ${snapshot.status}` : "No live harness in this chat"}</text>
    {!snapshot ? <text fg={theme.TEXT} wrapMode="word">Enable self-extension in Settings, then use /new-chat. This does not change the current session.</text> : null}
    {harness.busy ? <text fg={theme.MUTED} wrapMode="word">Working. Host changes wait for a safe checkpoint; the turn is not interrupted.</text> : null}
    {harness.error || snapshot?.error ? <text fg={theme.ERROR} wrapMode="word">{harness.error ?? snapshot?.error}</text> : null}
    <text fg={theme.TEXT} wrapMode="word">{`Workspace: ${harness.workspaceRoot}`}</text>
    <text fg={theme.TEXT} wrapMode="word">{`Trusted ESM: ${harness.workspaceTrusted ? "allowed by operator" : "not allowed"}`}</text>
    <text fg={theme.ACCENT} onMouseDown={conversation}>s  Show conversation</text>
    {snapshot ? <text fg={theme.ACCENT} onMouseDown={() => setShowCatalog(true)}>v  Views, commands and settings</text> : null}
    {snapshot?.trustedUi.some(entry => entry.tui) && harness.workspaceTrusted ? <text fg={theme.ACCENT} onMouseDown={liveView}>u  Show live view</text> : null}
    {snapshot?.previousGenerationId ? <text fg={theme.ACCENT} onMouseDown={() => void harness.control({ action: "rollback" })}>r  Roll back</text> : null}
    {snapshot?.generationId || snapshot?.pendingGenerationId ? <text fg={theme.ACCENT} onMouseDown={() => void harness.control({ action: "disable" })}>d  Disable</text> : null}
    <text fg={theme.ACCENT} onMouseDown={toggleTrust}>{`t  ${harness.workspaceTrusted ? "Revoke" : "Grant"} workspace trust`}</text>
    {snapshot ? <text fg={theme.ACCENT} onMouseDown={() => setShowIdentity(value => !value)}>l  Generation details</text> : null}
    {showIdentity && snapshot ? <text fg={theme.TEXT} wrapMode="word">{`Current: ${snapshot.generationId ?? "built-in"}\nPrevious: ${snapshot.previousGenerationId ?? "none"}\nPending: ${snapshot.pendingGenerationId ?? "none"}\nProviders: ${snapshot.providers.map(provider => provider.id).join(", ") || "built-in"}`}</text> : null}
    <text fg={theme.MUTED} wrapMode="word">{hints.join(" · ")}</text>
  </box>;
}
