/** @jsxImportSource @opentui/react */
import React, { useMemo } from "react";
import { TextAttributes } from "@opentui/core";
import { useRenderer } from "@opentui/react";

import { fitTuiText } from "../text.js";
import { commandCardFrame } from "../transcript-style.js";
import type { Theme } from "../theme-context.js";
import type { ChatImageAttachment } from "./types.js";
import {
  badgeChip,
  imageBadgeLabel,
  imageCellBox,
  imageDimensionsLabel,
} from "./card-layout.js";

/**
 * An inline image from a tool result, drawn as a titled rounded card.
 *
 *   ╭ IMG #1 · PNG ────────────────────────────╮
 *   │ <the picture, or an honest placeholder>  │
 *   │ alt / origin / size                      │
 *   ╰──────────────────────── 1280 × 720 px ───╯
 *
 * Three rules govern everything below.
 *
 * 1. The badge on the TOP border names the kind and the index. The index is
 *    the attachment's own position in the result, so `#2` means the second
 *    image the tool returned — not a renumbering by the view.
 *
 * 2. The dimensions on the BOTTOM border are the image's ACTUAL pixel size,
 *    decoded from its own header bytes by `imagePixelSize` (or copied from an
 *    explicit width/height the result stated). When neither is available the
 *    bottom border carries nothing at all. There is no approximation path.
 *
 * 3. The picture is drawn only when the terminal genuinely reports a graphics
 *    protocol and the bytes are actually inline. Otherwise the card says so in
 *    plain words. It never claims to have shown something it did not, and it
 *    never fetches anything: no disk read, no HTTP. If the result referenced an
 *    image by URL instead of inlining it, the card prints the URL and stops.
 */

/**
 * Largest inline payload we will hand to the renderer. Beyond this the decode
 * cost is paid on the render thread for a picture that will be scaled into a
 * handful of rows anyway, so the card degrades to the placeholder instead.
 */
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

/** Human byte size. Local so this leaf pulls in no formatting module. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ImageCardProps {
  /** The attachment, exactly as projected from the tool result. */
  image: ChatImageAttachment;
  /** Outer cell budget. The card never draws wider than this. */
  width: number;
  theme: Theme;
  /** Rows of separation from the previous entry (the transcript's spacing). */
  marginTop?: number;
}

/**
 * Decode a base64 payload to bytes, or `undefined` when it cannot be decoded.
 * Total: a malformed payload yields the placeholder, never a throw.
 */
function decodeImageBytes(data: string | undefined, byteSize: number | undefined): Uint8Array | undefined {
  if (!data) return undefined;
  if (byteSize !== undefined && byteSize > MAX_INLINE_IMAGE_BYTES) return undefined;
  try {
    const normalized = data.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (normalized.length === 0) return undefined;
    const bytes = new Uint8Array(Buffer.from(normalized, "base64"));
    return bytes.length > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

export function ImageCard({ image, width, theme, marginTop = 0 }: ImageCardProps): React.ReactNode {
  const { MUTED, TEXT, BORDER, BRAND, PANEL } = theme;
  const frame = commandCardFrame(width);

  // The renderer's own capability report. `capabilities` is null until the
  // terminal has answered the query, and a null report is treated as "cannot
  // display" — an honest not-yet rather than an optimistic picture.
  const renderer = useRenderer();
  const capabilities = renderer?.capabilities ?? null;
  const graphics = Boolean(capabilities && (capabilities.kitty_graphics || capabilities.sixel));

  const bytes = useMemo(
    () => (graphics ? decodeImageBytes(image.data, image.byteSize) : undefined),
    [graphics, image.data, image.byteSize],
  );

  // Below the card's chrome cost there is no card: degrade to one honest line.
  if (!frame.render) {
    const label = imageBadgeLabel(image);
    const dims = imageDimensionsLabel(image);
    return (
      <box flexDirection="column" flexShrink={0} minWidth={0} marginTop={marginTop}>
        <text width={Math.max(1, width)} height={1} wrapMode="none" truncate fg={MUTED}>
          {fitTuiText(dims ? `${label} · ${dims}` : label, Math.max(1, width))}
        </text>
      </box>
    );
  }

  const inner = frame.innerWidth;
  const badge = badgeChip(imageBadgeLabel(image), inner);
  const dimensionText = imageDimensionsLabel(image);
  // `fitTuiText` trims, so the chip's padding spaces are added AFTER fitting.
  const dimensions = dimensionText && inner >= 6
    ? ` ${fitTuiText(dimensionText, inner - 2)} `
    : undefined;
  const cellBox = imageCellBox(inner, image);

  // Why the picture is not on screen, in the operator's words. Empty when it is.
  const unavailable = bytes
    ? ""
    : image.url && !image.data
      ? "Referenced by URL; bytes were not inlined"
      : !image.data
        ? "No image data was retained"
        : !graphics
          ? "This terminal reports no image protocol"
          : image.byteSize !== undefined && image.byteSize > MAX_INLINE_IMAGE_BYTES
            ? `Payload too large to display inline (${formatBytes(image.byteSize)})`
            : "Image payload could not be decoded";

  // Facts under the picture. Each line appears only if its datum exists.
  const facts: string[] = [];
  if (image.alt) facts.push(image.alt);
  if (image.origin) facts.push(`from ${image.origin}`);
  const meta: string[] = [];
  if (image.mimeType) meta.push(image.mimeType);
  if (image.byteSize !== undefined) meta.push(formatBytes(image.byteSize));
  if (meta.length > 0) facts.push(meta.join(" · "));
  if (image.url) facts.push(image.url);

  const placeholderRows = Math.max(2, Math.min(cellBox.rows, 6));

  return (
    <box
      flexDirection="column"
      width={frame.outerWidth}
      flexShrink={0}
      minWidth={0}
      marginTop={marginTop}
      border
      borderStyle="rounded"
      borderColor={BORDER}
      title={badge || undefined}
      titleColor={BRAND}
      titleAlignment="left"
      bottomTitle={dimensions}
      bottomTitleAlignment="right"
      backgroundColor={PANEL}
      paddingX={1}
    >
      {bytes ? (
        <box width={inner} height={cellBox.rows} flexShrink={0} minWidth={0} flexDirection="row">
          <image
            source={bytes}
            fit="fit"
            width={Math.min(inner, cellBox.cols)}
            height={cellBox.rows}
            flexShrink={0}
          />
        </box>
      ) : (
        <box
          width={inner}
          height={placeholderRows}
          flexShrink={0}
          minWidth={0}
          flexDirection="column"
          justifyContent="center"
        >
          <text width={inner} height={1} wrapMode="none" truncate fg={MUTED} attributes={TextAttributes.DIM}>
            {fitTuiText("▚▚▚  image not displayed", inner)}
          </text>
          <text width={inner} height={1} wrapMode="none" truncate fg={MUTED}>
            {fitTuiText(unavailable, inner)}
          </text>
        </box>
      )}
      {facts.map((fact, index) => (
        <text
          key={`fact-${index}`}
          width={inner}
          height={1}
          wrapMode="none"
          truncate
          fg={index === 0 && image.alt ? TEXT : MUTED}
        >
          {fitTuiText(fact, inner)}
        </text>
      ))}
    </box>
  );
}

export default ImageCard;
