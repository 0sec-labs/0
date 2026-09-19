/** @jsxImportSource @opentui/react */
import React, { createContext, useContext, useEffect, useState } from "react";
import { VERSION } from "@0sec/shared";
import { useTheme } from "./theme-context.js";
import { readableOnPrimary } from "./themes.js";
import { useSymbols } from "./symbol-context.js";
import { fitLegend, fitTuiText } from "./text.js";
import { useSettings } from "./settings-store.js";
import { useDialogSurface, useSurfaceDimensions } from "./dialog-surface.js";
import { operatorIcon, operatorTitle } from "./operator-icons.js";
import {
  BRAND_STAMP_WIDTH,
  SHELL_HORIZONTAL_PADDING,
  getFooterLayout,
  getOverlayLayout,
} from "./shell-geometry.js";

/**
 * True when this process was launched from a dev source checkout — the `0dev`
 * wrapper execs with `0SEC_DEV_SOURCE_ROOT` set. Drives the [dev] vs [beta]
 * header badge. Read once at module load; the launch channel never changes
 * mid-session.
 */
const DEV_CHANNEL = Boolean(process.env["0SEC_DEV_SOURCE_ROOT"]?.trim());

export function OverlayFrame({
  title,
  footer,
  children,
}: {
  title: string;
  footer: string;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  const { width } = useSurfaceDimensions();
  const overlay = getOverlayLayout(width);

  return (
    <box position="absolute" top="12%" left={overlay.left} width={overlay.width} backgroundColor={theme.PANEL_ALT} paddingX={2} paddingY={1} zIndex={10}>
      <box flexDirection="column" width="100%" minWidth={0}>
        <text fg={theme.PRIMARY}>{fitTuiText(title, overlay.contentWidth)}</text>
        {children}
        <text fg={theme.MUTED}>{fitLegend(overlay.contentWidth, footer)}</text>
      </box>
    </box>
  );
}

// Keep every frame four cells wide so the footer never jitters. The animation
// may glitch the wordmark, but it must remain recognizably 0sec (executable name).
const BRAND_WORD_FRAMES = [
  "0sec",
  "0sec",
  "0S3c",
  "0sEc",
  "0s3c",
  "0s.c",
  "0sec",
  "0sec",
  "0sec",
  "0sec",
];

function useAnimatedBrand(enabled: boolean) {
  const [frame, setFrame] = useState(0);
  const { reduceMotion } = useSettings();
  const animate = enabled && !reduceMotion;

  useEffect(() => {
    if (!animate) {
      setFrame(0);
      return;
    }

    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % BRAND_WORD_FRAMES.length);
    }, 260);

    return () => clearInterval(timer);
  }, [animate]);

  return {
    frame,
    word: animate ? BRAND_WORD_FRAMES[frame] : "0sec",
  };
}


function BrandStamp({ animated = false }: { animated?: boolean }) {
  const theme = useTheme();
  const brand = useAnimatedBrand(animated);

  return (
    <box flexDirection="row" width={BRAND_STAMP_WIDTH} flexShrink={0}>
      <text width={4} flexShrink={0} fg={theme.MUTED}>{animated ? brand.word : "0sec"}</text>
      <text flexShrink={0} fg={theme.MUTED}>{` v${VERSION}`}</text>
      {/* Build-channel badge: [dev] when launched from a dev source checkout
          (the `0dev` wrapper exports 0SEC_DEV_SOURCE_ROOT), else [beta] for a
          published build. Toned so dev is unmistakable at a glance. */}
      {DEV_CHANNEL
        ? <text flexShrink={0} fg={theme.WARNING}>{" [dev]"}</text>
        : <text flexShrink={0} fg={theme.INFO}>{" [beta]"}</text>}
    </box>
  );
}

export function RailBar({ tone }: { tone: string }) {
  return <box width={1} flexShrink={0} alignSelf="stretch" backgroundColor={tone} />;
}

/**
 * The legible foreground colour for text painted on the header's `PRIMARY`
 * strip, published by `HeaderBar` so a status/nav ReactNode a caller supplies
 * (which brings its own `fg`) can pick a colour that reads on the orange bar
 * instead of a canvas-tuned one that would vanish on it. `null` outside a
 * header (the default), so a consumer can fall back to its own palette.
 */
export const HeaderForegroundContext = createContext<string | null>(null);

/** Read the header's readable foreground, or `null` when not inside a header. */
export function useHeaderForeground(): string | null {
  return useContext(HeaderForegroundContext);
}

function HeaderBar({
  view,
  status,
}: {
  view: string;
  status?: React.ReactNode;
}) {
  const theme = useTheme();
  const symbols = useSymbols();
  const { width } = useSurfaceDimensions();
  // The bar is now full-bleed (it escapes ShellFrame's horizontal padding and
  // reaches both terminal edges), keeping only a single-cell text inset via its
  // own paddingX={1}. So its columns are budgeted against that real inner width
  // — the terminal less the two inset cells — not against the shell's padded
  // content column.
  const contentWidth = Math.max(1, width - 2);
  const statusWidth = status
    ? Math.max(1, Math.min(Math.floor(contentWidth * 0.42), Math.max(1, contentWidth - 18)))
    : 0;
  const titleWidth = Math.max(1, contentWidth - statusWidth - (status ? 1 : 0));
  // Dark/legible text on the orange (PRIMARY) strip — theme-picked so it reads
  // on every palette's signature colour, not just the default orange.
  const fg = readableOnPrimary(theme);

  // A single full-BLEED PRIMARY strip: the colour IS the delineation, so no
  // border divider row and no leading rail. It escapes ShellFrame's horizontal
  // padding — the frame now applies that padding to the BODY below instead, so
  // this strip's `width="100%"` is the whole terminal width and the orange
  // reaches column 0 and the last column. Its own `paddingX={1}` keeps the text
  // a clean single cell in from each edge. `marginBottom` keeps content below
  // breathing.
  return (
    <HeaderForegroundContext.Provider value={fg}>
      <box flexDirection="row" width="100%" minWidth={0} marginBottom={1} paddingLeft={1} paddingRight={1} backgroundColor={theme.PRIMARY}>
        <box width={titleWidth} flexShrink={0} minWidth={0}>
          <text fg={fg}>{fitTuiText(`${operatorIcon(view, symbols)} ${operatorTitle(view)}`, titleWidth)}</text>
        </box>
        {status ? (
          <box width={statusWidth} flexShrink={0} minWidth={0} alignItems="flex-end">
            {typeof status === "string" ? <text fg={fg}>{fitTuiText(status, statusWidth)}</text> : status}
          </box>
        ) : null}
      </box>
    </HeaderForegroundContext.Provider>
  );
}

export function FooterBar({ hint, status }: { hint: string | readonly string[]; status?: React.ReactNode }) {
  const theme = useTheme();
  const { width } = useSurfaceDimensions();
  const inDialog = useDialogSurface();
  const footer = getFooterLayout(width, Boolean(status));
  if (inDialog) {
    const statusWidth = status ? Math.min(30, Math.floor(width / 3)) : 0;
    return (
      <box flexDirection="row" width="100%" height={1} flexShrink={0} overflow="hidden">
        <box flexGrow={1} minWidth={0}><text fg={theme.MUTED}>{fitLegend(Math.max(0, width - statusWidth), hint)}</text></box>
        {status ? <box width={statusWidth} flexShrink={0}>{typeof status === "string" ? <text fg={theme.MUTED}>{fitTuiText(status, statusWidth)}</text> : status}</box> : null}
      </box>
    );
  }

  return (
    <box flexDirection={footer.inline ? "row" : "column"} width="100%" minWidth={0}>
      <box width={footer.inline ? footer.hintWidth : "100%"} flexShrink={0} minWidth={0}>
        <text fg={theme.MUTED} wrapMode="word">{fitLegend(footer.hintWidth, hint)}</text>
      </box>
      <box flexDirection="row" flexShrink={0} marginTop={footer.inline ? 0 : 1}>
        {status ? (
          <box width={footer.statusWidth} flexShrink={0} minWidth={0} marginRight={footer.statusGap}>
            {typeof status === "string" ? <text fg={theme.MUTED}>{fitTuiText(status, footer.statusWidth)}</text> : status}
          </box>
        ) : null}
        <box width={BRAND_STAMP_WIDTH} flexShrink={0} minWidth={0}>
          <BrandStamp animated />
        </box>
      </box>
    </box>
  );
}

export function ShellFrame({
  view,
  status,
  meta,
  children,
  dialogContent = false,
}: {
  view: string;
  status?: React.ReactNode;
  meta?: React.ReactNode;
  children: React.ReactNode;
  dialogContent?: boolean;
}) {
  const theme = useTheme();
  const inDialog = useDialogSurface();
  if (inDialog && dialogContent) {
    return <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.PANEL}>{children}</box>;
  }
  // The header bar is full-bleed, so the frame carries only the top padding at
  // the outer level; the horizontal padding moves onto the BODY wrapper below
  // the bar. That lets the orange strip reach both terminal edges while the
  // content keeps its usual side gutter.
  return (
    <box flexDirection="column" width="100%" height="100%" paddingTop={1} backgroundColor={inDialog ? theme.PANEL : theme.CANVAS}>
      <HeaderBar view={view} status={status ?? meta} />
      <box flexDirection="column" flexGrow={1} minHeight={0} width="100%" minWidth={0} paddingLeft={SHELL_HORIZONTAL_PADDING} paddingRight={SHELL_HORIZONTAL_PADDING}>
        {children}
      </box>
    </box>
  );
}
