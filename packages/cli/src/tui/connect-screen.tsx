/** @jsxImportSource @opentui/react */
/**
 * The provider connect / login dialog (`/connect`, alias `/login`).
 *
 * A compact shared picker inside the host's Popup. Standalone navigation is
 * rendered here; onboarding supplies the outer Back/Next row itself.
 *
 * Credential presence is reported as configured, not as verified API access.
 * API keys are masked, persisted owner-only, and read back before completion.
 * OAuth providers keep their actual browser/device flows and cancel on exit.
 *
 * The ChatGPT Codex path runs the official `codex login --device-auth` flow
 * under this OpenTUI pane. It never asks for an API key or pasted OAuth token:
 * Codex owns the browser/device protocol and writes its auth file; completion
 * reloads that file into this process only after a successful device login.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { sleekScrollbar } from "./scrollbar.js";
import { decodePasteBytes, TextAttributes } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";

import { useTheme, type Theme } from "./theme-context.js";
import { useSymbols } from "./symbol-context.js";
import { useDialogSurface, useSurfaceDimensions } from "./dialog-surface.js";
import { operatorIcon, operatorTitle } from "./operator-icons.js";
import { Cells } from "./primitives.js";
import { providerStates } from "./provider-status.js";
import { DialogSelectBody, type DialogItem } from "./dialog-select.js";
import { clampDialogSelection, moveDialogSelection } from "./dialog-select-layout.js";
import { DialogActionButton } from "./dialog-screen-chrome.js";
import {
  loadCredentials,
  saveCredentials,
  type StoredCredentials,
} from "./credential-store.js";
import type { ConnectionRecovery } from "./connection-recovery.js";
import {
  startCodexDeviceAuth,
  type CodexDeviceAuthUpdate,
} from "./codex-device-auth.js";
import {
  startDeviceAuth,
  PROVIDER_DEVICE_AUTH,
  type DeviceAuthSession,
} from "./device-auth.js";
import {
  CONNECT_DIALOG_HOST_ROWS,
  buildConnectRows,
  computeConnectLayout,
  computeConnectTitleLayout,
  connectConnectedCounts,
  connectDetailLines,
  connectDetailTitleLabel,
  connectDetailTitleMeta,
  connectDialogItems,
  connectDisplayRowCount,
  connectFooterHint,
  connectInputMask,
  connectRowForId,
  connectStatusLine,

  isFilterKey,
  pastableChars,
  shellChromeRows,
  wrapCells,
  type ConnectDetailTone,
  type ConnectMode,
  type ConnectProvider,
  type ConnectRow,
} from "./connect-layout.js";

/** How many rows page-up and page-down move. */
const PAGE_STEP = 5;
/** The dialog's own identity, from the shared operator icon/title table. */
const SCREEN_KEY = "connect";

export interface ConnectFrameInput {
  body: React.ReactNode;
  hint: string;
  /** Local Back/Cancel semantics for the onboarding window's sole top control. */
  onBack?: () => void;
  backLabel?: string;
  /** Real provider action for the onboarding window's sole top-right control. */
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
}

export interface ConnectScreenProps {
  /** Wraps the body in the console shell (injected so this file need not import run.tsx). */
  frame: (input: ConnectFrameInput) => React.ReactNode;
  /** Leave the screen — Esc once any filter is cleared. */
  onBack: () => void;
  /** Wizard-only: skip this decision with Ctrl+N when browsing. */
  onSkip?: () => void;
  /** Leave the console entirely — ctrl+c. */
  onExit: () => void;
  /** Provider/authentication failure that opened this screen, if any. */
  recovery?: ConnectionRecovery;
  /** Called after credentials are persisted; caller applies selection to a new chat. */
  onConnected?: (providerId: string) => void;
  /** Environment to read credentials from. Defaults to the real one; injected for tests. */
  env?: Record<string, string | undefined>;
  /**
   * The credential store home dir. Defaults to the real one; injected so a test
   * can point the store at a temp dir without touching the operator's file.
   */
  homeDir?: string;
  /** The onboarding window supplies its own navigation and footer. */
  embedded?: boolean;
}

/** One fitted line of the detail column, with the colour already chosen. */
interface PaneLine {
  text: string;
  fg: string;
  bold?: boolean;
}

function toneColor(theme: Theme, tone: ConnectDetailTone): string {
  switch (tone) {
    case "title":
      return theme.PRIMARY;
    case "accent":
      return theme.ACCENT;
    case "ok":
      return theme.SUCCESS;
    case "warn":
      return theme.WARNING;
    case "muted":
    case "blank":
      return theme.MUTED;
    default:
      return theme.TEXT;
  }
}

function oauthStateTone(theme: Theme, phase: CodexDeviceAuthUpdate["phase"]): string {
  switch (phase) {
    case "failed":
      return theme.ERROR;
    case "connected":
      return theme.SUCCESS;
    case "running":
      return theme.ACCENT;
    default:
      return theme.MUTED;
  }
}

function oauthStateTitle(
  phase: CodexDeviceAuthUpdate["phase"],
  standalone: boolean,
  label: string,
): string {
  switch (phase) {
    case "connected":
      return standalone ? `${label} connected` : "connected";
    case "failed":
      return standalone ? `${label} sign-in failed` : "sign-in failed";
    case "cancelled":
      return standalone ? `${label} sign-in cancelled` : "sign-in cancelled";
    default:
      return standalone ? `${label} sign-in` : "sign-in";
  }
}

function oauthStateMeta(phase: CodexDeviceAuthUpdate["phase"]): string {
  switch (phase) {
    case "running":
      return "sign-in";
    case "connected":
      return "connected";
    case "failed":
      return "failed";
    default:
      return "cancelled";
  }
}

function oauthRecoveryHint(phase: CodexDeviceAuthUpdate["phase"]): string {
  switch (phase) {
    case "running":
      return "Complete the sign-in in your browser. Keep this pane open; Esc cancels.";
    case "failed":
      return "Review the sign-in output, then press Enter to try again or use ↑/↓ to choose another provider.";
    case "connected":
      return "The credential is loaded for this session.";
    default:
      return "Press Enter to try again or use ↑/↓ to choose another provider.";
  }
}


export function ConnectScreen({ frame, onBack, onSkip, onExit, recovery, onConnected, env, homeDir, embedded = false }: ConnectScreenProps) {
  const theme = useTheme();
  const symbols = useSymbols();
  const { width, height } = useSurfaceDimensions();
  const inDialog = useDialogSurface();

  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const filterRef = useRef("");
  const filteringRef = useRef(false);
  const setFilterMode = (next: boolean) => {
    filteringRef.current = next;
    setFiltering(next);
  };

  // The store is component state so a save is reflected immediately: the row's
  // check turns green because the store now holds the value, not because the
  // screen assumed the write succeeded.
  const [stored, setStored] = useState<StoredCredentials>(() => loadCredentials(homeDir));

  // API-key input state. The raw secret lives here and nowhere else, is never
  // rendered (only `connectInputMask` of its LENGTH is), and is dropped the
  // moment the sub-step ends.
  const [inputProviderId, setInputProviderId] = useState<string | undefined>(undefined);
  const [inputValue, setInputValue] = useState("");
  const inputProviderRef = useRef<string | undefined>(undefined);
  const inputValueRef = useRef("");
  const applyInputProviderId = (next: string | undefined) => {
    inputProviderRef.current = next;
    setInputProviderId(next);
  };
  const applyInputValue = (update: React.SetStateAction<string>) => {
    const next = typeof update === "function" ? update(inputValueRef.current) : update;
    inputValueRef.current = next;
    setInputValue(next);
  };
  const [notice, setNotice] = useState<{ message: string; error?: boolean } | undefined>(undefined);
  const [actionFocus, setActionFocus] = useState<"content" | "back" | "primary">("content");
  const actionFocusRef = useRef(actionFocus);
  const focusAction = (next: typeof actionFocus) => {
    actionFocusRef.current = next;
    setActionFocus(next);
  };
  // Both engines expose the same cancel-only session, so one ref serves the
  // Codex subprocess flow and the generic in-process device-code flow alike.
  const oauthSessionRef = useRef<DeviceAuthSession | undefined>(undefined);
  const [oauth, setOauth] = useState<
    (CodexDeviceAuthUpdate & { providerId: string }) | undefined
  >(undefined);
  const oauthRef = useRef<typeof oauth>(undefined);
  const applyOauth = (next: typeof oauth) => {
    oauthRef.current = next;
    setOauth(next);
  };
  const [authEpoch, setAuthEpoch] = useState(0);

  // OAuth completion updates process env, so authEpoch is the explicit redraw
  // boundary for providerStates rather than a hidden file-read side effect.
  const states = useMemo(() => providerStates(env ?? process.env), [env, authEpoch]);
  const storedIds = useMemo(() => new Set(Object.keys(stored)), [stored]);

  const rows = useMemo(
    () => buildConnectRows({ states, stored: storedIds, filter }),
    [states, storedIds, filter],
  );
  // The picker's rows: the same grouped model, projected onto `DialogItem`s.
  // Connectedness on an item is `provider.connected` and nothing else, so the
  // dot and the meta are as verified as the row model is.
  const items = useMemo(
    () => connectDialogItems({
      rows,
      recoveryProviderId: recovery?.providerId,
      // The two lifecycle colours the hand-rolled list used to carry, and no
      // others: connected reads green, a provider awaiting repair reads as an
      // error. Both come off state the row model already verified.
      tones: { connected: theme.SUCCESS, recovering: theme.ERROR },
    }),
    [rows, recovery?.providerId, theme.SUCCESS, theme.ERROR],
  );
  const totalRows = useMemo(() => connectDisplayRowCount(items), [items]);

  const recoveredProviderRef = useRef<string | undefined>(undefined);
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  const highlight = (next: number) => {
    selectedRef.current = next;
    setSelected(next);
  };

  const cursor = clampDialogSelection(items, selected);
  const activeItem: DialogItem | undefined = items[cursor];
  const activeRow: ConnectRow | undefined = connectRowForId(rows, activeItem?.id);
  const activeProvider: ConnectProvider | undefined =
    activeRow?.kind === "provider" ? activeRow.provider : undefined;


  // The wizard supplies an exactly bounded body with no footer; standalone
  // dialogs retain the shared shell's one-line keyboard legend.
  const layout = computeConnectLayout(width, height, totalRows, inDialog || embedded
    ? { chromeRows: embedded ? 0 : CONNECT_DIALOG_HOST_ROWS, chromeColumns: 0, embedded }
    : { chromeRows: shellChromeRows(width), embedded });
  const { panel, contentWidth } = layout;

  const inInput = inputProviderId !== undefined;
  const oauthVisible = oauth?.providerId === activeProvider?.id;
  const inOAuth = oauthVisible && oauth?.phase === "running";
  const mode: ConnectMode = inInput ? "input" : inOAuth ? "oauth" : filtering ? "filter" : "browse";

  useEffect(() => {
    if (cursor !== selected) highlight(cursor);
  }, [cursor, selected]);
  useEffect(() => {
    const providerId = recovery?.providerId;
    if (!providerId || recoveredProviderRef.current === providerId) return;
    const recoveryIndex = items.findIndex((item) => item.id === providerId);
    recoveredProviderRef.current = providerId;
    if (recoveryIndex >= 0) highlight(recoveryIndex);
  }, [recovery?.providerId, items]);

  // Cleanup on unmount: cancel any active auth session.
  useEffect(() => () => {
    oauthSessionRef.current?.cancel();
  }, []);


  const currentRows = () => filterRef.current === filter
    ? rows
    : buildConnectRows({ states, stored: storedIds, filter: filterRef.current });
  const currentItems = (visibleRows = currentRows()) => visibleRows === rows
    ? items
    : connectDialogItems({
      rows: visibleRows,
      recoveryProviderId: recovery?.providerId,
      tones: { connected: theme.SUCCESS, recovering: theme.ERROR },
    });

  const move = (delta: number) => {
    const visible = currentItems();
    if (visible.length === 0) return;
    focusAction("content");
    const dir: 1 | -1 = delta >= 0 ? 1 : -1;
    let next = clampDialogSelection(visible, selectedRef.current);
    for (let step = 0; step < Math.abs(delta); step += 1) next = moveDialogSelection(visible, next, dir);
    highlight(next);
    setNotice(undefined);
  };
  const pickProvider = (index: number) => {
    if (inputProviderRef.current !== undefined || oauthRef.current?.phase === "running") return;
    highlight(index);
    focusAction("content");
    setNotice(undefined);
  };

  const setQuery = (next: string) => {
    focusAction("content");
    filterRef.current = next;
    setFilter(next);
    highlight(0);
  };

  const beginOauth = (provider: ConnectProvider) => {
    oauthSessionRef.current?.cancel();
    applyInputProviderId(undefined);
    applyInputValue("");
    setNotice(undefined);
    applyOauth({
      providerId: provider.id,
      phase: "running",
      lines: [],
      message: `Starting ${provider.label} sign-in…`,
    });
    // Codex owns its CLI device flow; the configured in-process engine owns
    // each other provider's device-code or PKCE browser protocol.
    const handleUpdate = (update: CodexDeviceAuthUpdate) => {
      applyOauth({ ...update, providerId: provider.id });
      if (update.phase === "failed") setNotice({ message: update.message, error: true });
    };
    const handleConnected = () => {
      oauthSessionRef.current = undefined;
      setAuthEpoch((current) => current + 1);
      setStored(loadCredentials(homeDir));
      setNotice({ message: `${provider.label} sign-in complete` });
      onConnected?.(provider.id);
    };
    if (provider.id === "chatgpt-codex") {
      oauthSessionRef.current = startCodexDeviceAuth({
        homeDir,
        onUpdate: handleUpdate,
        onConnected: handleConnected,
      });
      return;
    }
    const config = PROVIDER_DEVICE_AUTH[provider.id];
    if (config === undefined) {
      applyOauth({
        providerId: provider.id,
        phase: "failed",
        lines: [],
        message: `${provider.label} has no device sign-in configured.`,
      });
      setNotice({ message: `${provider.label} has no device sign-in configured.`, error: true });
      return;
    }
    oauthSessionRef.current = startDeviceAuth(config, {
      env: (env ?? process.env) as NodeJS.ProcessEnv,
      homeDir,
      onUpdate: handleUpdate,
      onConnected: handleConnected,
    });
  };

  const beginConnect = (provider: ConnectProvider) => {
    if (provider.auth === "oauth") {
      beginOauth(provider);
      return;
    }
    applyOauth(undefined);
    applyInputProviderId(provider.id);
    applyInputValue("");
    setNotice(undefined);
  };

  const cancelInput = () => {
    applyInputProviderId(undefined);
    applyInputValue("");
  };

  const cancelOauth = () => {
    oauthSessionRef.current?.cancel();
  };

  const commitInput = () => {
    const id = inputProviderRef.current;
    const secret = inputValueRef.current.trim();
    if (!id || !secret) return;
    const next: StoredCredentials = { ...loadCredentials(homeDir), [id]: secret };
    if (!saveCredentials(next, homeDir)) {
      setNotice({ message: "Could not save the key. Check credential-store permissions and try again.", error: true });
      return;
    }
    const reloaded = loadCredentials(homeDir);
    setStored(reloaded);
    if (!reloaded[id]) {
      setNotice({ message: "The key could not be read back from the credential store.", error: true });
      return;
    }
    applyInputProviderId(undefined);
    applyInputValue("");
    focusAction("content");
    const label = states.find((state) => state.id === id)?.label ?? id;
    setNotice({ message: `${label} key saved · API access not checked` });
    onConnected?.(id);
  };

  const activateProvider = (provider: ConnectProvider) => {
    focusAction("content");
    if (provider.connected && recovery?.providerId !== provider.id && onConnected) {
      onConnected(provider.id);
    } else {
      beginConnect(provider);
    }
  };
  const leaveSubstep = () => {
    focusAction("content");
    if (inputProviderRef.current !== undefined) cancelInput();
    else if (oauthRef.current?.phase === "running") cancelOauth();
    else if (filteringRef.current) setFilterMode(false);
    else if (filterRef.current) setQuery("");
    else onBack();
  };
  const activatePrimary = () => {
    if (inputProviderRef.current !== undefined) commitInput();
    else if (oauthRef.current?.phase !== "running" && activeProvider) activateProvider(activeProvider);
  };

  usePaste((event) => {
    event.preventDefault();
    event.stopPropagation();
    if (inputProviderRef.current === undefined) return;
    const chunk = pastableChars(decodePasteBytes(event.bytes));
    if (chunk) applyInputValue((current) => current + chunk);
  });

  useKeyboard((key) => {
    const seq = typeof key.sequence === "string" ? key.sequence : "";

    if (key.ctrl && key.name === "c") {
      onExit();
      return;
    }
    if (key.name === "tab" && !key.ctrl && !key.meta && !key.option) {
      if (embedded) return;
      const targets: (typeof actionFocus)[] = ["content", "back", "primary"];
      const at = targets.indexOf(actionFocusRef.current);
      focusAction(targets[(at + (key.shift ? targets.length - 1 : 1)) % targets.length]!);
      return;
    }
    if (key.name === "return" && actionFocusRef.current !== "content") {
      if (actionFocusRef.current === "back") leaveSubstep();
      else activatePrimary();
      return;
    }
    if (key.name === "escape") {
      leaveSubstep();
      return;
    }

    if (oauthRef.current?.phase === "running") {
      return;
    }

    // ── input sub-step ──
    if (inputProviderRef.current !== undefined) {
      if (key.name === "return") {
        commitInput();
        return;
      }
      if (key.name === "backspace") {
        applyInputValue((current) => current.slice(0, -1));
        return;
      }
      const chunk = pastableChars(seq);
      if (chunk) applyInputValue((current) => current + chunk);
      return;
    }

    if (key.ctrl && key.name === "n" && onSkip && !filteringRef.current && !filterRef.current) {
      onSkip();
      return;
    }
    if (key.ctrl || key.meta || key.option) return;

    // ── movement (browse and filter) ──
    if (key.name === "up") return move(-1);
    if (key.name === "down") return move(1);
    if (key.name === "pageup") return move(-PAGE_STEP);
    if (key.name === "pagedown") return move(PAGE_STEP);
    if (key.name === "return") {
      const visibleRows = currentRows();
      const visible = currentItems(visibleRows);
      const item = visible[clampDialogSelection(visible, selectedRef.current)];
      const row = connectRowForId(visibleRows, item?.id);
      if (row?.kind === "provider") {
        activateProvider(row.provider);
      }
      return;
    }

    // ── filter mode ──
    if (filteringRef.current) {
      if (key.name === "backspace") {
        setQuery(filterRef.current.slice(0, -1));
        return;
      }
      if (isFilterKey(seq)) setQuery(filterRef.current + seq);
      return;
    }

    // ── browse mode ──
    if (key.name === "backspace") {
      if (filterRef.current) setQuery(filterRef.current.slice(0, -1));
      return;
    }
    if (seq === "/") {
      setFilterMode(true);
      setQuery("");
      return;
    }
    if (isFilterKey(seq)) {
      setFilterMode(true);
      setQuery(seq);
    }
  });

  // ── detail column ────────────────────────────────────────────────────────
  //
  // One renderer for every sub-step, so the column always describes exactly
  // the state the screen is in: the provider's facts while browsing, the
  // device sign-in while one is running, the masked key prompt while one is
  // being pasted, and the failure that opened the screen when there is
  // one. Every line is wrapped to the pane's width and the list is clipped to
  // its rows, because OpenTUI paints an overflow through its neighbours.

  const renderDetail = (item: DialogItem, pane: { width: number; height: number }) => {
    if (pane.width <= 0 || pane.height <= 0) return null;
    const row = connectRowForId(rows, item.id);
    const provider = row?.kind === "provider" ? row.provider : undefined;
    const recoveringId = recovery?.providerId;
    const recovering = recoveringId !== undefined
      && recoveringId === provider?.id;
    // A provider being repaired is never described as connected: the
    // credential it holds is the one that just failed.
    const shownRow: ConnectRow | undefined =
      recovering && row?.kind === "provider"
        ? { ...row, provider: { ...row.provider, connected: false, source: undefined, via: undefined } }
        : row;

    const oauthHere = provider !== undefined && oauth?.providerId === provider.id;
    const inputHere = provider !== undefined && inputProviderId === provider.id;

    const headerRows = pane.height >= 4 ? 1 : 0;
    const actionRows = !embedded && layout.navigationRows === 0 && pane.height >= 2 ? 1 : 0;
    const bodyRows = Math.max(0, pane.height - headerRows - actionRows);
    // The body scrolls rather than being clipped away: a provider's setup
    // hint or a Codex transcript that does not fit must
    // still be reachable. A scrollbox reveals its bar in the last column the
    // moment it overflows, so the text is budgeted one cell narrower.
    const width = Math.max(1, pane.width - 1);
    const wrap = (text: string, fg: string, bold?: boolean): PaneLine[] =>
      wrapCells(text, width).map((line) => ({ text: line, fg, bold }));
    const blank = (): PaneLine => ({ text: "", fg: theme.MUTED });

    const lines: PaneLine[] = [];
    let meta: string;
    let metaFg: string;
    let title: string;

    if (oauthHere && oauth && provider) {
      const tone = oauthStateTone(theme, oauth.phase);
      title = provider.label;
      meta = oauthStateMeta(oauth.phase);
      metaFg = tone;
      lines.push(...wrap(oauthStateTitle(oauth.phase, headerRows === 0, provider.label), tone, true), blank());
      lines.push(...wrap(oauth.message, oauth.phase === "failed" ? theme.TEXT : theme.MUTED));
      if (oauth.lines.length > 0) {
        lines.push(blank());
        for (const line of oauth.lines) lines.push(...wrap(line, theme.TEXT));
      }
      lines.push(blank(), ...wrap(oauthRecoveryHint(oauth.phase), theme.MUTED));
    } else if (inputHere && provider) {
      // The secret itself never reaches this pane: only a fixed, length-capped
      // dot run, and only to show that something was pasted.
      title = provider.label;
      meta = "waiting for key";
      metaFg = theme.ACCENT;
      lines.push(...wrap(`Paste your ${provider.label} API key.`, theme.ACCENT, true));
      lines.push(...wrap("Hidden while typing. Saved owner-only on this machine.", theme.MUTED));
    } else {
      const codexRecovery = recovery?.providerId === "chatgpt-codex";
      title = provider?.label ?? connectDetailTitleLabel();
      meta = recovering ? "reconnect" : connectDetailTitleMeta(shownRow);
      metaFg = recovering
        ? theme.ERROR
        : shownRow?.kind === "provider" && shownRow.provider.connected
          ? theme.SUCCESS
          : theme.MUTED;
      if (recovering) {
        const recoveryTitle = codexRecovery ? "ChatGPT Codex needs device sign-in" : recovery?.title;
        const recoveryDetail = codexRecovery
          ? "Use your ChatGPT subscription, not an OpenAI API key."
          : recovery?.detail;
        if (recoveryTitle) lines.push(...wrap(recoveryTitle, theme.ERROR, true));
        if (recoveryDetail) lines.push(...wrap(recoveryDetail, theme.TEXT));
        lines.push(blank());
      }
      const detail = connectDetailLines({ row: shownRow, compact: true }, width);
      // The pane header already names the provider; drop the repeated lead
      // title (and its spacer) when there is a header to carry it.
      let start = 0;
      if (headerRows > 0) {
        while (start < detail.length) {
          const tone = detail[start]?.tone;
          if (tone !== "title" && tone !== "blank") break;
          start += 1;
        }
      }
      for (const line of detail.slice(start)) {
        lines.push({ text: line.text, fg: toneColor(theme, line.tone) });
      }
    }
    if (notice?.error) lines.unshift(...wrap(notice.message, theme.ERROR));

    const header = computeConnectTitleLayout(pane.width, meta.length);
    return (
      <>
        {headerRows > 0 ? (
          <box flexDirection="row" width={header.width} flexShrink={0} minWidth={0}>
            <Cells width={header.titleWidth} fg={theme.PRIMARY} attributes={TextAttributes.BOLD}>
              {title}
            </Cells>
            {header.metaWidth > 0 ? (
              <>
                <Cells width={header.gap}>{""}</Cells>
                <Cells width={header.metaWidth} align="right" fg={metaFg}>
                  {meta}
                </Cells>
              </>
            ) : null}
          </box>
        ) : null}
        {bodyRows > 0 ? (
          <scrollbox
            key={item.id}
            width={pane.width}
            height={bodyRows}
            flexShrink={0}
            scrollX={false}
            verticalScrollbarOptions={sleekScrollbar(theme)}
          >
            <box width={width} flexDirection="column" flexShrink={0} minWidth={0}>
              {inputHere ? (
                <box width={width} height={3} paddingX={1} paddingY={1}
                  backgroundColor={theme.PANEL_ALT} flexShrink={0}>
                  <Cells width={Math.max(1, width - 2)} fg={inputValue ? theme.TEXT : theme.MUTED}>
                    {connectInputMask(inputValue.length) || "Paste or type key"}
                  </Cells>
                </box>
              ) : null}
              {lines.map((line, index) => (
                <Cells key={`detail-${index}`} width={width} fg={line.fg}
                  attributes={line.bold ? TextAttributes.BOLD : undefined}>
                  {line.text}
                </Cells>
              ))}
            </box>
          </scrollbox>
        ) : null}
        {actionRows > 0 ? (
          <box width={pane.width} height={actionRows} flexDirection="row" columnGap={1} flexShrink={0}>
            {!embedded && (inputHere || (oauthHere && oauth?.phase === "running")) ? (
              <DialogActionButton label="Cancel" onPress={leaveSubstep} focused={actionFocus === "back"} />
            ) : null}
            <box flexGrow={1} />
            <DialogActionButton label={primaryLabel} onPress={activatePrimary} variant="primary"
              disabled={primaryDisabled} focused={actionFocus === "primary"} />
          </box>
        ) : null}
      </>
    );
  };

  // ── status line ──────────────────────────────────────────────────────────
  // Never the secret: the input sub-step reports only the masked length.
  const statusText = notice?.error ? notice.message
    : oauthVisible && oauth ? oauth.message
    : notice ? notice.message
    : inInput ? "Enter saves the hidden key · Esc cancels"
    : recovery ? recovery.title || "Provider credentials need attention"
    : connectStatusLine(rows);
  const statusFg = notice?.error || (oauthVisible && oauth?.phase === "failed") ? theme.ERROR
    : oauthVisible && oauth ? oauthStateTone(theme, oauth.phase)
    : inInput ? theme.ACCENT : recovery ? theme.ERROR : theme.MUTED;
  const canContinue = Boolean(onConnected && activeProvider?.connected && recovery?.providerId !== activeProvider.id);
  const primaryLabel = inInput ? "Save" : inOAuth ? "Signing in" : canContinue ? "Continue" : "Connect";
  const primaryDisabled = !activeProvider || inOAuth || (inInput && !inputValue.trim());
  const hint = embedded ? "" : connectFooterHint(mode, filter.length > 0, canContinue);
  const counts = connectConnectedCounts(rows);
  const titleText = `${operatorIcon(SCREEN_KEY, symbols)} ${operatorTitle(SCREEN_KEY)}`;
  const titleMeta = counts.connected > 0 ? `${counts.connected} configured` : "";
  const title = computeConnectTitleLayout(contentWidth, titleMeta.length);

  const body = (
    <box flexDirection="column" width={contentWidth} flexGrow={1} minWidth={0} overflow="hidden">
      {layout.navigationRows > 0 ? (
        <box width={contentWidth} height={layout.navigationRows} flexDirection="row" columnGap={1} flexShrink={0}>
          <DialogActionButton label={inInput || inOAuth ? "Cancel" : "Back"}
            onPress={leaveSubstep} focused={actionFocus === "back"} />
          <box flexGrow={1} />
          <DialogActionButton label={primaryLabel} onPress={activatePrimary} variant="primary"
            disabled={primaryDisabled} focused={actionFocus === "primary"} />
        </box>
      ) : null}
      {layout.titleRows > 0 ? (
        <box flexDirection="row" width={title.width} flexShrink={0} minWidth={0}>
          <Cells width={title.titleWidth} fg={theme.PRIMARY} attributes={TextAttributes.BOLD}>
            {titleText}
          </Cells>
          {title.metaWidth > 0 ? (
            <>
              <Cells width={title.gap}>{""}</Cells>
              <Cells width={title.metaWidth} align="right"
                fg={counts.connected > 0 ? theme.SUCCESS : theme.MUTED}>
                {titleMeta}
              </Cells>
            </>
          ) : null}
        </box>
      ) : null}
      <box width={contentWidth} height={layout.bodyRows} flexDirection="column" flexShrink={0} minWidth={0}>
        {layout.listRows >= 2 && contentWidth > 0 ? (
          <DialogSelectBody
            items={items}
            cursor={cursor}
            panel={panel}
            query={filter}
            placeholder="Search providers"
            gutter
            isCurrent={(item) => item.current === true}
            renderDetail={renderDetail}
            onActivateRow={pickProvider}
            onHoverRow={inInput || inOAuth ? undefined : pickProvider}
            onScroll={inInput || inOAuth ? undefined : move}
            emptyText="no providers match this filter"
          />
        ) : null}
        {layout.stackedRows > 0 && activeItem ? (
          <box width={contentWidth} height={layout.stackedRows}
            flexDirection="column" flexShrink={0} minWidth={0}>
            {renderDetail(activeItem, { width: contentWidth, height: layout.stackedRows })}
          </box>
        ) : null}
      </box>
      {layout.statusRows > 0 ? (
        <Cells width={contentWidth} fg={statusFg}>{statusText}</Cells>
      ) : null}
    </box>
  );

  return <>{frame({
    body,
    hint,
    onBack: leaveSubstep,
    backLabel: inInput || inOAuth ? "Cancel" : "Back",
    onNext: activatePrimary,
    nextLabel: primaryLabel,
    nextDisabled: primaryDisabled,
  })}</>;
}
