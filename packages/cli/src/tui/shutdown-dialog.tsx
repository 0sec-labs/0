/** @jsxImportSource @opentui/react */
import React, { useEffect, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "./theme-context.js";
import { useSettings } from "./settings-store.js";
import { spinnerGlyph, UI_ANIMATION_INTERVAL_MS } from "./animations.js";
import { Popup } from "./popup.js";

/**
 * A centered modal shown while the app tears down on quit. It replaces a single
 * muted line at the top of the screen that was easy to miss and read as lag: a
 * raised, backdrop-dimmed popup (matching the other dialogs) makes it obvious
 * the session is closing, and — because a wedged resource can still make
 * cleanup take a couple of seconds — offers an explicit, one-press "force quit
 * now" so the operator is never left wondering whether it hung.
 */
export function ShutdownDialog({ auditCount, onForceQuit }: {
  auditCount: number;
  onForceQuit: () => void;
}) {
  const theme = useTheme();
  const terminal = useTerminalDimensions();
  const { reduceMotion } = useSettings();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (reduceMotion) return;
    const timer = setInterval(() => setFrame((v) => v + 1), UI_ANIMATION_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [reduceMotion]);

  // Keys are otherwise gated during shutdown; this hook is scoped to the dialog
  // so only the force-quit affordance is live. Ctrl+C / Enter / q all bail.
  useKeyboard((key) => {
    if (key.name === "return" || key.name === "q" || (key.ctrl && key.name === "c")) {
      key.preventDefault?.();
      onForceQuit();
    }
  });

  const spinner = reduceMotion ? "◐" : spinnerGlyph(frame, { reduceMotion });
  const panelWidth = Math.max(24, Math.min(56, terminal.width - 4));
  const detail = auditCount > 0
    ? `Closing ${auditCount} audit${auditCount === 1 ? "" : "s"} and releasing resources.`
    : "Releasing resources.";

  return (
    <Popup variant="centered" width={panelWidth} height="auto" dismissOnBackdrop={false} zIndex={200}>
      <box flexDirection="row">
        <text fg={theme.PRIMARY}>{spinner} </text>
        <text fg={theme.TEXT} attributes={TextAttributes.BOLD}>Stopping audits…</text>
      </box>
      <text fg={theme.MUTED}>{detail}</text>
      <box height={1} />
      <box flexDirection="row" justifyContent="center"
        onMouseDown={(event) => { event.stopPropagation?.(); onForceQuit(); }}>
        <text fg={theme.ACCENT} attributes={TextAttributes.BOLD}>[ Force quit now ]</text>
        <text fg={theme.MUTED}>  ·  Ctrl+C</text>
      </box>
    </Popup>
  );
}
