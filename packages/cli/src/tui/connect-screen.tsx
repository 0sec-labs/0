/** @jsxImportSource @opentui/react */
/**
 * The provider connect / login dialog (`/connect`, alias `/login`).
 *
 * `/providers` reports which vendors this machine can already reach; this
 * screen is the write side, letting the operator connect one without leaving
 * the console. It is a pop-up: the host wraps it in `DialogSurface`, and
 * `useSurfaceDimensions` reports that panel's inner box, so every row and cell
 * budget here is measured against the dialog. The body is the console's one
 * shared picker (`DialogSelectBody` in inline `bodyRows` mode) — providers
 * grouped by how you connect them, searchable, with the highlighted one's
 * detail in the column beside the list — plus a title row and a status line.
 * The footer of bindings is the HOST's single row, drawn from the `hint` this
 * screen returns through `frame`, so it is not drawn twice. The detail column
 * scrolls rather than clipping: every provider fact the full-screen version
 * could show is still reachable.
 *
 * Three properties are load-bearing and survive the redesign unchanged:
 *
 * 1. **A credential leaves this screen only through the credential store.** The
 *    input sub-step writes the pasted secret with `saveCredentials`, which
 *    persists it owner-only to `~/.0sec/credentials.json`. Nothing is sent
 *    anywhere else.
 *
 * 2. **The raw secret is never rendered.** The input sub-step echoes
 *    `connectInputMask` — a fixed dot run capped at eight cells — and nothing
 *    else. The secret lives in one piece of component state, is never put on a
 *    `DialogItem`, in the detail pane, in the status line or in a log, and is
 *    dropped the moment the sub-step ends.
 *
 * 3. **The green check is verified, never optimistic.** A provider reads as
 *    connected — the gutter dot, the `connected` meta and the detail pane's
 *    header — only when `providerStates` finds an env credential or the store
 *    on disk holds one. There is no sticky "connecting…" state; the check
 *    appears after a save because the store now holds the value, not because
 *    the screen assumed the save worked. A provider being repaired after a
 *    failure reads as NOT connected until it is reconnected.
 *
 * The ChatGPT Codex path runs the official `codex login --device-auth` flow
 * under this OpenTUI pane. It never asks for an API key or pasted OAuth token:
 * Codex owns the browser/device protocol and writes its auth file; completion
 * reloads that file into this process only after a successful device login.
 *
 * The 0sec Cloud path runs the hosted browser login flow via
 * `hostedBrowserLoginFlow` from commands/auth.ts. Like Codex, it never asks
 * for an API key: it opens the operator's browser, polls for session
 * completion, and persists credentials to ~/.0sec/cloud.env. An AbortSignal
 * drives cancellation on Escape or unmount, preventing late state updates.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
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
import {
  loadCredentials,
  saveCredentials,
  type StoredCredentials,
} from "./credential-store.js";
import type { ConnectionRecovery } from "./connection-recovery.js";
import {
  startCodexDeviceAuth,
  type CodexDeviceAuthSession,
  type CodexDeviceAuthUpdate,
} from "./codex-device-auth.js";
import {
  startHostedDeviceAuth,
  readHostedConnection,
  type HostedDeviceAuthUpdate,
} from "./hosted-device-auth.js";
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
/** The picker id the cloud sign-in row commits with. */
const CLOUD_ID = "hosted";

export interface ConnectFrameInput {
  body: React.ReactNode;
  hint: string;
}

export interface ConnectScreenProps {
  /** Wraps the body in the console shell (injected so this file need not import run.tsx). */
  frame: (input: ConnectFrameInput) => React.ReactNode;
  /** Leave the screen — Esc once any filter is cleared. */
  onBack: () => void;
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
): string {
  switch (phase) {
    case "connected":
      return standalone ? "ChatGPT Codex connected" : "connected";
    case "failed":
      return standalone ? "ChatGPT Codex sign-in failed" : "sign-in failed";
    case "cancelled":
      return standalone ? "ChatGPT Codex sign-in cancelled" : "sign-in cancelled";
    default:
      return standalone ? "ChatGPT Codex device sign-in" : "device sign-in";
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
      return "Review the Codex output, then press Enter to try again or use ↑/↓ to choose another provider.";
    case "connected":
      return "The subscription credential is loaded for this session.";
    default:
      return "Press Enter to try again or use ↑/↓ to choose another provider.";
  }
}

/**
 * The tone for the cloud/hosted sign-in detail pane, based on its phase.
 */
function hostedStateTone(theme: Theme, phase: HostedDeviceAuthUpdate["phase"]): string {
  switch (phase) {
    case "cancelled":
    case "timeout":
    case "opener-failed":
    case "failed":
      return theme.WARNING;
    case "ready":
      return theme.SUCCESS;
    case "opening":
    case "polling":
      return theme.ACCENT;
  }
}

/**
 * The title for the cloud sign-in state.
 */
function hostedStateTitle(phase: HostedDeviceAuthUpdate["phase"]): string {
  if (phase === "failed") return "0sec Cloud sign-in unavailable";
  switch (phase) {
    case "ready":
      return "Signed in to 0sec Cloud";
    case "cancelled":
      return "0sec Cloud sign-in cancelled";
    case "timeout":
      return "0sec Cloud sign-in timed out";
    case "opener-failed":
      return "Open this URL to sign in";
    default:
      return "Signing in to 0sec Cloud";
  }
}

/**
 * The right-aligned meta for the cloud sign-in state pane header.
 */
function hostedStateMeta(phase: HostedDeviceAuthUpdate["phase"]): string {
  switch (phase) {
    case "ready":
      return "signed in";
    case "cancelled":
      return "cancelled";
    case "timeout":
    case "opener-failed":
    case "failed":
      return "failed";
    default:
      return "signing in";
  }
}

/**
 * Hint text shown after each cloud sign-in phase.
 */
function hostedRecoveryHint(phase: HostedDeviceAuthUpdate["phase"]): string {
  switch (phase) {
    case "opening":
    case "polling":
      return "Complete the sign-in in your browser. Keep this pane open; Esc cancels.";
    case "opener-failed":
      return "Your browser could not be opened automatically. Visit the URL above to sign in. Esc cancels.";
    case "ready":
      return "Login saved. Model access and credits are checked when used.";
    case "cancelled":
      return "Press Enter to try again or use ↑/↓ to choose another provider.";
    case "timeout":
      return "Try again or use your own provider.";
    case "failed":
      return "Use your own API key or provider subscription, or try Cloud sign-in again.";
  }
}

export function ConnectScreen({ frame, onBack, onExit, recovery, onConnected, env, homeDir }: ConnectScreenProps) {
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
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const oauthSessionRef = useRef<CodexDeviceAuthSession | undefined>(undefined);
  const hostedSessionRef = useRef<{ cancel(): void } | undefined>(undefined);
  const [oauth, setOauth] = useState<
    (CodexDeviceAuthUpdate & { providerId: string }) | undefined
  >(undefined);
  const [hosted, setHosted] = useState<
    (HostedDeviceAuthUpdate & { providerId: string }) | undefined
  >(undefined);
  const oauthRef = useRef<typeof oauth>(undefined);
  const hostedRef = useRef<typeof hosted>(undefined);
  const applyOauth = (next: typeof oauth) => {
    oauthRef.current = next;
    setOauth(next);
  };
  const applyHosted = (next: typeof hosted) => {
    hostedRef.current = next;
    setHosted(next);
  };
  const [authEpoch, setAuthEpoch] = useState(0);

  const cloudState = useMemo(() => readHostedConnection(env ?? process.env, homeDir), [env, authEpoch, homeDir]);
  const cloudConnected = cloudState.configured && recovery?.providerId !== "hosted";

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
      cloudConnected,
      recoveryProviderId: recovery?.providerId,
      // The two lifecycle colours the hand-rolled list used to carry, and no
      // others: connected reads green, a provider awaiting repair reads as an
      // error. Both come off state the row model already verified.
      tones: { connected: theme.SUCCESS, recovering: theme.ERROR },
    }),
    [rows, cloudConnected, recovery?.providerId, theme.SUCCESS, theme.ERROR],
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
  const isCloudRow = activeRow?.kind === "cloud";


  // Inside a dialog the surface IS the panel's inner box — the shell renders
  // with `dialogContent`, so it has no header and no padding — and the only
  // row the host still spends is its single footer, drawn from the `hint`
  // this screen returns. Outside a dialog the legacy shell chrome applies.
  const layout = computeConnectLayout(width, height, totalRows, inDialog
    ? { chromeRows: CONNECT_DIALOG_HOST_ROWS, chromeColumns: 0 }
    : { chromeRows: shellChromeRows(width) });
  const { panel, contentWidth } = layout;

  const inInput = inputProviderId !== undefined;
  const oauthVisible = oauth?.providerId === activeProvider?.id;
  const inOAuth = oauthVisible && oauth?.phase === "running";
  const hostedVisible = hosted?.providerId === "hosted" && isCloudRow;
  const inHosted = hostedVisible && ["opening", "polling", "opener-failed"].includes(hosted?.phase ?? "");
  const mode: ConnectMode = inInput ? "input" : inOAuth ? "oauth" : inHosted ? "hosted" : filtering ? "filter" : "browse";

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
    hostedSessionRef.current?.cancel();
  }, []);

  const currentRows = () => filterRef.current === filter
    ? rows
    : buildConnectRows({ states, stored: storedIds, filter: filterRef.current });
  const currentItems = (visibleRows = currentRows()) => visibleRows === rows
    ? items
    : connectDialogItems({
      rows: visibleRows,
      cloudConnected,
      recoveryProviderId: recovery?.providerId,
      tones: { connected: theme.SUCCESS, recovering: theme.ERROR },
    });

  const move = (delta: number) => {
    const visible = currentItems();
    if (visible.length === 0) return;
    const dir: 1 | -1 = delta >= 0 ? 1 : -1;
    let next = clampDialogSelection(visible, selectedRef.current);
    for (let step = 0; step < Math.abs(delta); step += 1) next = moveDialogSelection(visible, next, dir);
    highlight(next);
    setNotice(undefined);
  };

  const setQuery = (next: string) => {
    filterRef.current = next;
    setFilter(next);
    highlight(0);
  };

  const beginOauth = (provider: ConnectProvider) => {
    hostedSessionRef.current?.cancel();
    oauthSessionRef.current?.cancel();
    applyInputProviderId(undefined);
    applyInputValue("");
    applyHosted(undefined);
    setNotice(undefined);
    applyOauth({
      providerId: provider.id,
      phase: "running",
      lines: [],
      message: "Starting ChatGPT Codex device sign-in…",
    });
    oauthSessionRef.current = startCodexDeviceAuth({
      homeDir,
      onUpdate: (update) => {
        applyOauth({ ...update, providerId: provider.id });
        if (update.phase === "failed") setNotice(update.message);
      },
      onConnected: () => {
        oauthSessionRef.current = undefined;
        setAuthEpoch((current) => current + 1);
        setStored(loadCredentials(homeDir));
        setNotice(`connected ${provider.label} through device OAuth`);
        onConnected?.(provider.id);
      },
    });
  };

  const beginHosted = () => {
    hostedSessionRef.current?.cancel();
    oauthSessionRef.current?.cancel();
    applyInputProviderId(undefined);
    applyInputValue("");
    applyOauth(undefined);
    setNotice(undefined);
    applyHosted({
      providerId: "hosted",
      phase: "opening",
      message: "Starting 0sec Cloud sign-in…",
    });
    hostedSessionRef.current = startHostedDeviceAuth({
      homeDir,
      host: (env ?? process.env)["0SEC_CLOUD_HOST"] ?? cloudState.host,
      onUpdate: (update) => {
        applyHosted({ ...update, providerId: "hosted" });
        if (["cancelled", "timeout", "failed"].includes(update.phase)) {
          setNotice(update.message);
        }
      },
      onConnected: () => {
        hostedSessionRef.current = undefined;
        setAuthEpoch((current) => current + 1);
        setNotice("signed in to 0sec Cloud");
        onConnected?.("hosted");
      },
    });
  };

  const beginConnect = (provider: ConnectProvider) => {
    if (provider.auth === "oauth") {
      beginOauth(provider);
      return;
    }
    applyHosted(undefined);
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

  const cancelHosted = () => {
    hostedSessionRef.current?.cancel();
    hostedSessionRef.current = undefined;
    applyHosted(undefined);
    onBack();
  };

  const commitInput = () => {
    const id = inputProviderRef.current;
    const secret = inputValueRef.current.trim();
    applyInputProviderId(undefined);
    applyInputValue("");
    if (!id) return;
    if (secret.length === 0) {
      setNotice("nothing pasted; provider unchanged");
      return;
    }
    const next: StoredCredentials = { ...loadCredentials(homeDir), [id]: secret };
    const ok = saveCredentials(next, homeDir);
    if (!ok) {
      setNotice("could not write credentials (is HOME writable?)");
      return;
    }
    const reloaded = loadCredentials(homeDir);
    setStored(reloaded);
    const label = states.find((state) => state.id === id)?.label ?? id;
    setNotice(reloaded[id] ? `connected ${label}` : `${label} not stored`);
    if (reloaded[id]) onConnected?.(id);
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

    if (oauthRef.current?.phase === "running") {
      if (key.name === "escape") cancelOauth();
      return;
    }

    const hostedPhase = hostedRef.current?.phase;
    if (hostedPhase === "opening" || hostedPhase === "polling" || hostedPhase === "opener-failed") {
      if (key.name === "escape") cancelHosted();
      return;
    }

    // ── input sub-step ──
    if (inputProviderRef.current !== undefined) {
      if (key.name === "escape") {
        cancelInput();
        return;
      }
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
      if (row?.kind === "cloud") {
        beginHosted();
        return;
      }
      if (row?.kind === "provider") beginConnect(row.provider);
      return;
    }

    // ── filter mode ──
    if (filteringRef.current) {
      if (key.name === "escape") {
        setFilterMode(false);
        return;
      }
      if (key.name === "backspace") {
        setQuery(filterRef.current.slice(0, -1));
        return;
      }
      if (isFilterKey(seq)) setQuery(filterRef.current + seq);
      return;
    }

    // ── browse mode ──
    if (key.name === "escape") {
      if (filterRef.current) {
        setQuery("");
        return;
      }
      onBack();
      return;
    }
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
  // device/browser sign-in while one is running, the masked key prompt while
  // one is being pasted, and the failure that opened the screen when there is
  // one. Every line is wrapped to the pane's width and the list is clipped to
  // its rows, because OpenTUI paints an overflow through its neighbours.

  const renderDetail = (item: DialogItem, pane: { width: number; height: number }) => {
    if (pane.width <= 0 || pane.height <= 0) return null;
    const row = connectRowForId(rows, item.id);
    const isCloud = row?.kind === "cloud";
    const provider = row?.kind === "provider" ? row.provider : undefined;
    const recoveringId = recovery?.providerId;
    const recovering = recoveringId !== undefined
      && recoveringId === (isCloud ? CLOUD_ID : provider?.id);
    // A provider being repaired is never described as connected: the
    // credential it holds is the one that just failed.
    const shownRow: ConnectRow | undefined =
      recovering && row?.kind === "provider"
        ? { ...row, provider: { ...row.provider, connected: false, source: undefined, via: undefined } }
        : row;

    const hostedHere = isCloud && hosted?.providerId === CLOUD_ID;
    const oauthHere = provider !== undefined && oauth?.providerId === provider.id;
    const inputHere = provider !== undefined && inputProviderId === provider.id;

    const headerRows = pane.height >= 4 ? 1 : 0;
    const bodyRows = Math.max(0, pane.height - headerRows);
    // The body scrolls rather than being clipped away: a provider's setup
    // hint, a Codex transcript or an account note that does not fit must
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

    if (hostedHere && hosted) {
      const tone = hostedStateTone(theme, hosted.phase);
      title = "0sec Cloud";
      meta = hostedStateMeta(hosted.phase);
      metaFg = tone;
      lines.push(...wrap(hostedStateTitle(hosted.phase), tone, true), blank());
      lines.push(...wrap(hosted.message, hosted.phase === "ready" ? theme.MUTED : theme.TEXT));
      if (hosted.loginUrl) lines.push(blank(), ...wrap(hosted.loginUrl, theme.ACCENT));
      lines.push(blank(), ...wrap(hostedRecoveryHint(hosted.phase), theme.MUTED));
    } else if (oauthHere && oauth && provider) {
      const tone = oauthStateTone(theme, oauth.phase);
      title = provider.label;
      meta = oauthStateMeta(oauth.phase);
      metaFg = tone;
      lines.push(...wrap(oauthStateTitle(oauth.phase, headerRows === 0), tone, true), blank());
      lines.push(...wrap(oauth.message, oauth.phase === "failed" ? theme.TEXT : theme.MUTED));
      if (oauth.lines.length > 0) {
        lines.push(blank(), ...wrap("CODEX", theme.MUTED));
        for (const line of oauth.lines) lines.push(...wrap(line, theme.TEXT));
      }
      lines.push(blank(), ...wrap(oauthRecoveryHint(oauth.phase), theme.MUTED));
    } else if (inputHere && provider) {
      // The secret itself never reaches this pane: only a fixed, length-capped
      // dot run, and only to show that something was pasted.
      title = provider.label;
      meta = "waiting for key";
      metaFg = theme.ACCENT;
      lines.push(...wrap(`Paste the ${provider.label} API key`, theme.ACCENT, true), blank());
      const mask = connectInputMask(inputValue.length);
      lines.push(...wrap(mask.length > 0 ? mask : "nothing pasted yet", mask.length > 0 ? theme.TEXT : theme.MUTED));
      lines.push(blank());
      lines.push(...wrap("The key is written owner-only to the credential store on this machine and is never displayed.", theme.MUTED));
      if (provider.envVars.length > 0) {
        lines.push(...wrap(`Exported to the runtime as ${provider.envVars[0]}`, theme.MUTED));
      }
      lines.push(blank(), ...wrap("enter save · esc cancel", theme.MUTED));
    } else {
      const codexRecovery = recovery?.providerId === "chatgpt-codex";
      title = isCloud ? "0sec Cloud" : provider?.label ?? connectDetailTitleLabel();
      meta = recovering ? "reconnect" : connectDetailTitleMeta(shownRow, cloudConnected);
      metaFg = recovering
        ? theme.ERROR
        : (shownRow?.kind === "provider" && shownRow.provider.connected) || (isCloud && cloudConnected)
          ? theme.SUCCESS
          : theme.MUTED;
      if (recovering) {
        const recoveryTitle = codexRecovery ? "ChatGPT Codex needs device sign-in" : recovery?.title;
        const recoveryDetail = codexRecovery
          ? "Sign in with your ChatGPT subscription. This is separate from an OpenAI API key and does not require a 0sec account."
          : recovery?.detail;
        if (recoveryTitle) lines.push(...wrap(recoveryTitle, theme.ERROR, true));
        if (recoveryDetail) lines.push(blank(), ...wrap(recoveryDetail, theme.TEXT));
        lines.push(blank(), ...wrap(
          `Press Enter to start ${codexRecovery ? "ChatGPT Codex device OAuth" : `reconnect ${provider?.label ?? "the selected provider"}`}. Esc returns to chat.`,
          theme.ACCENT,
        ));
        lines.push(blank());
      }
      const detail = connectDetailLines(
        { row: shownRow, compact: bodyRows < 12, cloudConnected },
        width,
      );
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
            verticalScrollbarOptions={{
              trackOptions: {
                backgroundColor: theme.PANEL,
                foregroundColor: theme.MUTED,
              },
              arrowOptions: {
                foregroundColor: theme.MUTED,
                backgroundColor: theme.PANEL,
              },
            }}
          >
            <box width={width} flexDirection="column" flexShrink={0} minWidth={0}>
              {lines.map((line, index) => (
                <Cells key={`detail-${index}`} width={width} fg={line.fg}
                  attributes={line.bold ? TextAttributes.BOLD : undefined}>
                  {line.text}
                </Cells>
              ))}
            </box>
          </scrollbox>
        ) : null}
      </>
    );
  };

  // ── status line ──────────────────────────────────────────────────────────
  // Never the secret: the input sub-step reports only the masked length.
  const statusText = inHosted
    ? hosted?.message ?? "signing in to 0sec Cloud..."
    : hostedVisible && hosted
      ? hosted.phase === "ready" ? "Cloud login saved; access and credits checked when used" : hosted.message
      : oauthVisible && oauth
        ? oauth.message
        : recovery
          ? recovery.providerId === "chatgpt-codex"
            ? "ChatGPT Codex needs device sign-in"
            : recovery.title || "provider needs to reconnect"
          : inInput
            ? `paste API key for ${activeProvider?.label ?? inputProviderId}: ${connectInputMask(inputValue.length)}`
            : notice
              ? notice
              : isCloudRow && cloudState.warning
                ? cloudState.warning
                : connectStatusLine(rows);
  const statusFg = inHosted
    ? theme.ACCENT
    : hostedVisible && hosted
      ? hostedStateTone(theme, hosted.phase)
      : oauthVisible && oauth
        ? oauth.phase === "failed" ? theme.ERROR : oauth.phase === "connected" ? theme.SUCCESS : theme.ACCENT
        : recovery ? theme.ERROR : inInput ? theme.ACCENT : isCloudRow && cloudState.warning ? theme.WARNING : theme.MUTED;

  const hint = connectFooterHint(mode, filter.length > 0);
  const counts = connectConnectedCounts(rows);
  const titleText = `${operatorIcon(SCREEN_KEY, symbols)} ${operatorTitle(SCREEN_KEY)}`;
  const titleMeta = counts.total === 0 ? "" : `${counts.connected}/${counts.total} connected`;
  const title = computeConnectTitleLayout(contentWidth, titleMeta.length);

  const body = (
    <box flexDirection="column" width={contentWidth} flexGrow={1} minWidth={0} overflow="hidden">
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
            placeholder="type to find a provider"
            gutter
            isCurrent={(item) => item.current === true}
            renderDetail={renderDetail}
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

  return <>{frame({ body, hint })}</>;
}
