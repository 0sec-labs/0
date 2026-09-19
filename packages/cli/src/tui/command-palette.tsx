/** @jsxImportSource @opentui/react */
import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppContext, useKeyboard } from "@opentui/react";
import type { KeyEvent } from "@opentui/core";
import { usePopupStack } from "./popup-stack.js";
import { useTheme } from "./theme-context.js";
import { fitTuiText } from "./text.js";
import { DialogSelect } from "./dialog-select.js";
import { getOverlayBodyRows, getOverlayLayout } from "./shell-geometry.js";
import { OverlayFrame, RailBar } from "./shell-frame.js";
import { useSurfaceDimensions } from "./dialog-surface.js";
import type { ShellNav } from "./shell-nav.js";
import { rankFuzzy } from "./fuzzy-match.js";
import { SLASH_COMMANDS } from "./slash-commands.js";
import { KEYBINDINGS } from "./keybindings.js";
import { useBlockRouteHistory } from "./route-history-keys.js";

/**
 * What a palette row represents. `"command"` is a navigation/action command
 * (the historical entries); `"slash"` is a `/…` slash command searchable by
 * name and description; `"shortcut"` is a keybinding, shown with its chord and
 * treated as informational (selecting it just closes the palette).
 */
export type PaletteKind = "command" | "slash" | "shortcut";

export interface PaletteCommand {
  id: string;
  title: string;
  category: string;
  description: string;
  keybind?: string;
  suggested?: boolean;
  /** Defaults to "command" when absent. */
  kind?: PaletteKind;
  action: () => void;
}

/** Cap on ranked results per keystroke, so a merged list stays fast. */
const PALETTE_RESULT_LIMIT = 60;

/** The searchable haystack for one command: title first (so a prefix match on
 *  the title wins), then chord, category and description. */
function paletteHaystack(command: PaletteCommand): string {
  return `${command.title} ${command.keybind ?? ""} ${command.category} ${command.description}`;
}

/**
 * The slash commands as palette rows, so `/comms`, `/hackstore`, … are findable
 * by name and description. Selecting one runs `onRun` with its bare name (when
 * a runner is wired by the host); with no runner it is informational and simply
 * closes, matching how the palette dispatches (`action()`).
 */
export function slashPaletteCommands(onRun?: (name: string) => void): PaletteCommand[] {
  return SLASH_COMMANDS.map((cmd) => ({
    id: `slash-${cmd.name}`,
    title: `/${cmd.name}`,
    category: cmd.category,
    description: cmd.description,
    kind: "slash" as const,
    action: () => onRun?.(cmd.name),
  }));
}

/**
 * The keybindings as palette rows, each carrying its formatted chord, so a user
 * can search "sidebar" and see the shortcut. Informational — selecting one just
 * closes the palette (a chord cannot be synthesised from here).
 */
export function keybindingPaletteCommands(): PaletteCommand[] {
  return KEYBINDINGS.map((binding) => ({
    id: `kb-${binding.id}`,
    title: binding.description,
    category: binding.category,
    description: binding.keys,
    keybind: binding.keys,
    kind: "shortcut" as const,
    action: () => {},
  }));
}

export function createShellCommands(shell?: ShellNav): PaletteCommand[] {
  if (!shell) return [];
  return [
    {
      id: "nav-chat",
      title: "Open chat",
      category: "Navigate",
      description: "Return to the operator conversation",
      keybind: "1",
      suggested: true,
      action: shell.openChat,
    },
    {
      id: "nav-new-chat",
      title: "New audit",
      category: "Audit",
      description: "Start an independent audit with the staged model and connection",
      action: shell.openNewChat,
    },
    {
      id: "nav-launcher",
      title: "Run engagement",
      category: "Engagement",
      description: "Open the chat-owned control pane for one explicit target",
      keybind: "7",
      action: shell.openLauncher,
    },
    {
      id: "nav-ops",
      title: "Open mission control",
      category: "Navigate",
      description: "Go to the operations overview",
      keybind: "2",
      suggested: true,
      action: shell.openOps,
    },
    {
      id: "nav-history",
      title: "Open history",
      category: "Navigate",
      description: "Browse previous scans",
      keybind: "3",
      suggested: true,
      action: shell.openHistory,
    },
    {
      id: "nav-findings",
      title: "Open findings",
      category: "Navigate",
      description: "Browse finding families and triage state",
      keybind: "4",
      suggested: true,
      action: shell.openFindings,
    },
    {
      id: "nav-doctor",
      title: "Open doctor",
      category: "Navigate",
      description: "Inspect runtime readiness",
      keybind: "5",
      suggested: true,
      action: shell.openDoctor,
    },
    {
      id: "nav-replay",
      title: "Open latest replay",
      category: "Navigate",
      description: "Review the most recent scan replay",
      keybind: "6",
      suggested: true,
      action: () => shell.openReplay(),
    },
    {
      id: "nav-settings",
      title: "Open settings",
      category: "Navigate",
      description: "Console display, transcript and security toggles",
      keybind: "8",
      suggested: true,
      action: shell.openSettings,
    },
    {
      id: "nav-harness",
      title: "Live harness",
      category: "Audit",
      description: "Views, commands, settings, rollback and workspace trust",
      action: shell.openHarness,
    },
    {
      id: "nav-models",
      title: "Open model picker",
      category: "Navigate",
      description: "Browse models by provider, with credential state",
      keybind: "9",
      suggested: true,
      action: () => shell.openModels(),
    },
    {
      id: "nav-resume",
      title: "Resume a saved audit",
      category: "Navigate",
      description: "Find conversations from this project or all projects",
      action: () => shell.openResume(),
    },
    {
      id: "nav-herd",
      title: "Open agent herd",
      category: "Navigate",
      description: "Roster of agents working this project and their status",
      keybind: "0",
      suggested: true,
      action: shell.openHerd,
    },
    {
      id: "nav-comms",
      title: "Open agent comms",
      category: "Navigate",
      description: "Live fleet of sub-agents and the messages flowing between them",
      action: shell.openComms,
    },
    {
      id: "nav-connect",
      title: "Connect a provider",
      category: "Navigate",
      description: "Add an API key or subscription sign-in for a model provider",
      action: shell.openConnect,
    },
    {
      id: "nav-onboard",
      title: "Run onboarding",
      category: "Navigate",
      description: "Review connection, model, and settings choices for the next audit",
      action: shell.openOnboarding,
    },
    {
      id: "nav-usage",
      title: "Open usage report",
      category: "Navigate",
      description: "Context window, token totals, cost, model and tool health",
      action: () => shell.openUsage(),
    },
    {
      id: "nav-finding",
      title: "Open finding detail",
      category: "Navigate",
      description: "Open a finding to read its full body and act on it (fix, copy report)",
      action: () => shell.openFindingDetail(),
    },
    {
      id: "nav-back",
      title: "Go back",
      category: "Navigate",
      description: "Return to the previous console route",
      keybind: "Alt+Left",
      suggested: true,
      action: shell.goBack,
    },
    {
      id: "nav-forward",
      title: "Go forward",
      category: "Navigate",
      description: "Move to the next console route",
      keybind: "Alt+Right",
      suggested: true,
      action: shell.goForward,
    },
  ];
}

/**
 * Filter + rank commands against a query with the fuzzy subsequence scorer:
 * typing "oa" finds "Open agents", and prefix > word-boundary > scattered
 * matches rank in that order. An empty query returns the input unchanged (the
 * caller's curation/order is preserved). Bounded so a merged multi-source list
 * stays fast on every keystroke.
 */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim();
  if (!q) return commands;
  return rankFuzzy(commands, q, paletteHaystack, PALETTE_RESULT_LIMIT).map((ranked) => ranked.item);
}

/** Extra searchable sources to merge into the palette. */
export interface PaletteSources {
  /** Include the `/…` slash commands (default true). */
  includeSlash?: boolean;
  /** Include the keybindings as informational chord rows (default true). */
  includeShortcuts?: boolean;
  /** Runs a chosen slash command by its bare name; omit for informational-only. */
  onRunSlash?: (name: string) => void;
}

export function usePaletteController(commands: PaletteCommand[], sources: PaletteSources = {}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteSelected, setPaletteSelected] = useState(0);

  const { includeSlash = true, includeShortcuts = true, onRunSlash } = sources;

  // The full searchable list: the caller's commands plus the merged sources.
  // Slash/keybinding rows are never `suggested`, so the empty-query view (which
  // shows only suggested commands) is unchanged — they surface only on typing.
  const mergedCommands = useMemo(
    () => [
      ...commands,
      ...(includeSlash ? slashPaletteCommands(onRunSlash) : []),
      ...(includeShortcuts ? keybindingPaletteCommands() : []),
    ],
    [commands, includeSlash, includeShortcuts, onRunSlash],
  );

  const filteredPalette = useMemo(() => {
    const base = paletteQuery.trim() ? mergedCommands : mergedCommands.filter((command) => command.suggested);
    return filterCommands(base, paletteQuery);
  }, [mergedCommands, paletteQuery]);

  const handlePaletteKey = (key: { ctrl?: boolean; meta?: boolean; name?: string; sequence?: string }): boolean => {
    if (key.ctrl && (key.name === "p" || key.name === "k")) {
      setPaletteOpen((current) => !current);
      setPaletteQuery("");
      setPaletteSelected(0);
      return true;
    }

    if (!paletteOpen) return false;

    if (key.name === "escape") {
      setPaletteOpen(false);
      setPaletteQuery("");
      setPaletteSelected(0);
      return true;
    }
    if (key.name === "up") {
      setPaletteSelected((current) => Math.max(0, current - 1));
      return true;
    }
    if (key.name === "down") {
      setPaletteSelected((current) => Math.min(Math.max(filteredPalette.length - 1, 0), current + 1));
      return true;
    }
    if (key.name === "return") {
      filteredPalette[paletteSelected]?.action();
      setPaletteOpen(false);
      return true;
    }
    if (key.name === "backspace") {
      setPaletteQuery((current) => current.slice(0, -1));
      return true;
    }
    if (key.sequence && !key.ctrl && !key.meta && key.name !== "return") {
      setPaletteQuery((current) => current + key.sequence);
      setPaletteSelected(0);
      return true;
    }
    return true;
  };

  return {
    paletteOpen,
    paletteQuery,
    paletteSelected,
    filteredPalette,
    handlePaletteKey,
  };
}

// Historic caps on overlay list length, kept so a tall terminal renders
// exactly what it did before; the height budget only ever lowers them.
const PALETTE_MAX_COMMANDS = 8;

export function PaletteOverlay({
  title,
  query,
  selected,
  commands,
}: {
  title: string;
  query: string;
  selected: number;
  commands: PaletteCommand[];
}) {
  useBlockRouteHistory();
  const theme = useTheme();
  const { width, height } = useSurfaceDimensions();
  const contentWidth = getOverlayLayout(width).contentWidth;
  // Every command row is a one-cell rail plus a one-cell margin before its
  // text column, so the title/keybind pair has to be budgeted against what
  // is left after that gutter. Budgeting against contentWidth overspent the
  // row by two cells, and space-between then fused title into keybind.
  const rowWidth = Math.max(1, contentWidth - 2);
  const commandMetaGap = 1;
  const commandTitleWidth = Math.max(1, Math.min(rowWidth - commandMetaGap, Math.floor(rowWidth * 0.62)));
  const commandMetaWidth = Math.max(0, rowWidth - commandTitleWidth - commandMetaGap);
  const queryLabel = "query ";
  const queryWidth = Math.max(1, contentWidth - queryLabel.length - 1);
  // The overlay box has no height of its own: hand it more rows than the
  // terminal has left below its 12% anchor and it is shrunk until the
  // bottom border lands on the last command. One row goes to the query
  // line, and each command renders a title row plus a description row.
  const visibleCommands = Math.max(
    1,
    Math.min(PALETTE_MAX_COMMANDS, Math.floor((getOverlayBodyRows(height) - 1) / 2)),
  );
  // The no-match message carries the query, so it is built as one string with
  // a real gap between the words: fitTuiText trims and collapses whitespace, so
  // a padded literal in a separate <text> beside the query would lose the gap
  // and fuse. The message is a bounded <text> of its own, distinct from the
  // OverlayFrame footer hint below it, so the two can never share a line.
  const trimmedQuery = query.trim();
  const noMatchText = trimmedQuery
    ? `no command matches ${trimmedQuery}`
    : "no commands available";

  return (
    <OverlayFrame title={title} footer="[⌃P] close · [⏎] run · [esc] cancel">
        <box flexDirection="row" width="100%" minWidth={0}>
          <text flexShrink={0} fg={theme.MUTED}>{queryLabel}</text>
          <box width={queryWidth} flexShrink={0} minWidth={0}>
            <text fg={theme.TEXT}>{fitTuiText(query || "type to filter commands", queryWidth)}</text>
          </box>
          <text width={1} flexShrink={0} fg={theme.INFO}>█</text>
        </box>
        {commands.slice(0, visibleCommands).map((command, index) => {
          const active = index === selected;
          // The right-hand meta shows each row's kind and, for a keybinding, its
          // chord: a shortcut shows "shortcut · <chord>", a slash shows "slash",
          // and a plain command keeps its historical keybind-or-category.
          const metaText =
            command.kind === "shortcut"
              ? (command.keybind ? `shortcut · ${command.keybind}` : "shortcut")
              : command.kind === "slash"
                ? "slash"
                : (command.keybind ?? command.category);
          return (
            <box key={command.id} flexDirection="row" width="100%" minWidth={0}>
              <RailBar tone={active ? theme.PRIMARY : theme.BORDER} />
              <box flexDirection="column" marginLeft={1} flexGrow={1} minWidth={0}>
                <box flexDirection="row" width={rowWidth} minWidth={0} gap={commandMetaGap}>
                  <box width={commandTitleWidth} flexShrink={0} minWidth={0}>
                    <text fg={active ? theme.TEXT : "#CCCCCC"}>{fitTuiText(command.title, commandTitleWidth)}</text>
                  </box>
                  {commandMetaWidth > 0 ? (
                    <box width={commandMetaWidth} flexShrink={0} minWidth={0} alignItems="flex-end">
                      <text fg={theme.MUTED}>{fitTuiText(metaText, commandMetaWidth)}</text>
                    </box>
                  ) : null}
                </box>
                <text fg={active ? theme.ACCENT : theme.MUTED} wrapMode="word">{fitTuiText(command.description, rowWidth)}</text>
              </box>
            </box>
          );
        })}
        {commands.length === 0 ? (
          <box width={rowWidth} flexShrink={0} minWidth={0}>
            <text fg={theme.MUTED}>{fitTuiText(noMatchText, rowWidth)}</text>
          </box>
        ) : null}
    </OverlayFrame>
  );
}

/**
 * The command list, as the topmost popup layer.
 *
 * Rendered by the popup stack, so it alone holds the live keyHandler while it
 * is open. Its own `useKeyboard` re-adds the Ctrl+P / Ctrl+K toggle-to-close
 * that the base pane can no longer serve (the pane is inert under the popup),
 * and `DialogSelect` handles Esc / arrows / enter as before.
 */
function CommandPalettePopup({ shell, onClose }: { shell: ShellNav; onClose: () => void }) {
  const commands = useMemo(() => createShellCommands(shell), [shell]);
  useKeyboard((key) => {
    if (key.ctrl && (key.name === "p" || key.name === "k")) {
      key.preventDefault?.();
      key.stopPropagation?.();
      onClose();
    }
  });
  return (
    <DialogSelect
      title="Commands"
      placeholder="Search commands"
      items={commands.map((command) => ({
        id: command.id, label: command.title, description: command.description,
      }))}
      onSelect={(selection) => {
        const command = commands.find((item) => item.id === selection);
        onClose();
        command?.action();
      }}
      onCancel={onClose}
    />
  );
}

/** Supply command navigation to control panes without their own palette. */
export function PanePalette({ shell, children }: { shell: ShellNav; children: React.ReactNode }) {
  const context = useContext(AppContext);
  const { push, pop } = usePopupStack();
  // The id of the palette popup while it is open, so the same shortcut toggles
  // it and the base pane's inertness (owned by the stack renderer) tracks it.
  const openId = useRef<string | null>(null);

  useEffect(() => {
    const close = () => {
      if (openId.current) {
        pop(openId.current);
        openId.current = null;
      }
    };
    const open = () => {
      if (openId.current) return;
      openId.current = push(() => <CommandPalettePopup shell={shell} onClose={close} />);
    };
    // Capture global shortcuts before a pane can interpret Ctrl+K as plain k.
    const handle = (key: KeyEvent) => {
      if (!key.ctrl || (key.name !== "p" && key.name !== "k")) return;
      key.preventDefault();
      key.stopPropagation();
      open();
    };
    context.keyHandler?.prependListener("keypress", handle);
    return () => { context.keyHandler?.off("keypress", handle); };
  }, [context.keyHandler, push, pop, shell]);

  return <>{children}</>;
}
