/** @jsxImportSource @opentui/react */
import React, { useEffect, useState } from "react";
import { VERSION } from "@0sec/shared";
import { useTheme } from "./theme-context.js";
import { useSymbols } from "./symbol-context.js";
import { fitTuiText } from "./text.js";
import { useSettings } from "./settings-store.js";
import { useDialogSurface, useSurfaceDimensions } from "./dialog-surface.js";
import { operatorIcon, operatorTitle } from "./operator-icons.js";
import {
  BRAND_STAMP_WIDTH,
  SHELL_HORIZONTAL_PADDING,
  getFooterLayout,
  getOverlayLayout,
} from "./shell-geometry.js";

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
    <box position="absolute" top="12%" left={overlay.left} width={overlay.width} border borderColor={theme.MUTED} backgroundColor={theme.PANEL_ALT} paddingX={1} paddingY={0} zIndex={10}>
      <box flexDirection="column" width="100%" minWidth={0}>
        <text fg={theme.PRIMARY}>{fitTuiText(title, overlay.contentWidth)}</text>
        {children}
        <text fg={theme.MUTED}>{fitTuiText(footer, overlay.contentWidth)}</text>
      </box>
    </box>
  );
}

// Keep every frame four cells wide so the footer never jitters. The animation
// may glitch the wordmark, but it must remain recognizably 0sec.
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
    </box>
  );
}

export function RailBar({ tone }: { tone: string }) {
  return <box width={1} flexShrink={0} alignSelf="stretch" backgroundColor={tone} />;
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
  const contentWidth = Math.max(1, width - SHELL_HORIZONTAL_PADDING * 2);
  const statusWidth = status
    ? Math.max(1, Math.min(Math.floor(contentWidth * 0.42), Math.max(1, contentWidth - 18)))
    : 0;
  const titleWidth = Math.max(1, contentWidth - statusWidth - (status ? 1 : 0));

  return (
    <box flexDirection="column" width="100%" minWidth={0} marginBottom={1}>
      <box flexDirection="row" width="100%" minWidth={0}>
        <RailBar tone={theme.PRIMARY} />
        <box flexDirection="row" marginLeft={1} flexGrow={1} minWidth={0}>
          <box width={titleWidth} flexShrink={0} minWidth={0}>
            <text fg={theme.TEXT}>{fitTuiText(`${operatorIcon(view, symbols)} ${operatorTitle(view)}`, titleWidth)}</text>
          </box>
          {status ? (
            <box width={statusWidth} flexShrink={0} minWidth={0} alignItems="flex-end">
              {typeof status === "string" ? <text fg={theme.MUTED}>{fitTuiText(status, statusWidth)}</text> : status}
            </box>
          ) : null}
        </box>
      </box>
      <box height={1} width="100%" marginTop={1} backgroundColor={theme.BORDER} />
    </box>
  );
}

export function FooterBar({ hint, status }: { hint: string; status?: React.ReactNode }) {
  const theme = useTheme();
  const { width } = useSurfaceDimensions();
  const inDialog = useDialogSurface();
  const footer = getFooterLayout(width, Boolean(status));
  if (inDialog) {
    const statusWidth = status ? Math.min(30, Math.floor(width / 3)) : 0;
    return (
      <box flexDirection="row" width="100%" height={1} flexShrink={0} overflow="hidden">
        <box flexGrow={1} minWidth={0}><text fg={theme.MUTED}>{fitTuiText(hint, Math.max(0, width - statusWidth))}</text></box>
        {status ? <box width={statusWidth} flexShrink={0}>{typeof status === "string" ? <text fg={theme.MUTED}>{fitTuiText(status, statusWidth)}</text> : status}</box> : null}
      </box>
    );
  }

  return (
    <box flexDirection={footer.inline ? "row" : "column"} width="100%" minWidth={0}>
      <box width={footer.inline ? footer.hintWidth : "100%"} flexShrink={0} minWidth={0}>
        <text fg={theme.MUTED} wrapMode="word">{fitTuiText(hint, footer.hintWidth)}</text>
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
  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={2} paddingRight={2} paddingTop={1} backgroundColor={inDialog ? theme.PANEL : theme.CANVAS}>
      <HeaderBar view={view} status={status ?? meta} />
      {children}
    </box>
  );
}
