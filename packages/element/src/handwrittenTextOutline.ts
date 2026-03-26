import {
  FONT_FAMILY,
  SVG_NS,
  THEME,
  applyDarkModeFilter,
  getFontFamilyString,
  getFontString,
  getVerticalOffset,
  isRTL,
} from "@excalidraw/common";

import {
  getExcalifontOutlineGlyph,
  EXCALIFONT_OUTLINE_MANIFEST,
} from "./excalifontOutlineManifest";
import { getLineHeightInPx, getLineWidth, normalizeText } from "./textMeasurements";

import type { ExcalidrawTextElement, FontString } from "./types";

import type { ExcalifontOutlineGlyph } from "./excalifontOutlineManifest";

// Keep this literal in sync with the app-layer animation metadata key.
const ANIMATION_CUSTOM_DATA_KEY = "excalidrawSyncAnimation";

export const HANDWRITTEN_TEXT_OUTLINE_PREVIEW_CUSTOM_DATA_KEY =
  "excalidrawSyncHandwrittenTextOutlinePreview";

type SupportedTextAnimationStyle = "draw" | "handwritten" | "none" | "typewriter";

export type HandwrittenTextOutlinePreviewData = {
  progress: number;
  tailProgress?: number;
};

type PendingLineFragment =
  | {
  glyph: ExcalifontOutlineGlyph;
      kind: "path";
      path: string;
      text: string;
      width: number;
    }
  | {
      kind: "text";
      text: string;
      width: number;
    };

type HandwrittenTextOutlineFragment =
  | {
  glyph: ExcalifontOutlineGlyph;
      kind: "path";
      path: string;
      scale: number;
      text: string;
      width: number;
      x: number;
      y: number;
    }
  | {
      kind: "text";
      text: string;
      width: number;
      x: number;
      y: number;
    };

type HandwrittenTextOutlineRenderable = {
  fill: string;
  fontFamily: string;
  fontSize: number;
  fontString: FontString;
  fragments: readonly HandwrittenTextOutlineFragment[];
};

const outlinePathCache = new Map<string, Path2D>();
const outlinePathLengthCache = new Map<string, number>();

const getTextAnimationStyle = (
  element: ExcalidrawTextElement,
): SupportedTextAnimationStyle | null => {
  const animation = element.customData?.[ANIMATION_CUSTOM_DATA_KEY];

  if (!animation || typeof animation !== "object" || Array.isArray(animation)) {
    return null;
  }

  const appearance =
    "appearance" in animation &&
    animation.appearance &&
    typeof animation.appearance === "object" &&
    !Array.isArray(animation.appearance)
      ? animation.appearance
      : null;

  if (!appearance || !("style" in appearance)) {
    return null;
  }

  const { style } = appearance;

  return style === "draw" ||
    style === "handwritten" ||
    style === "none" ||
    style === "typewriter"
    ? style
    : null;
};

const shouldRenderHandwrittenTextOutline = (element: ExcalidrawTextElement) => {
  if (element.fontFamily !== FONT_FAMILY.Excalifont || isRTL(element.text)) {
    return false;
  }

  const animationStyle = getTextAnimationStyle(element);

  return animationStyle !== "none" && animationStyle !== "typewriter";
};

const getOutlineFill = (element: ExcalidrawTextElement, theme: string) => {
  return theme === THEME.DARK
    ? applyDarkModeFilter(element.strokeColor)
    : element.strokeColor;
};

const getLineStartX = (element: ExcalidrawTextElement, lineWidth: number) => {
  if (element.textAlign === "center") {
    return element.width / 2 - lineWidth / 2;
  }

  if (element.textAlign === "right") {
    return element.width - lineWidth;
  }

  return 0;
};

const getPreviewProgress = (element: ExcalidrawTextElement) => {
  const preview = element.customData?.[HANDWRITTEN_TEXT_OUTLINE_PREVIEW_CUSTOM_DATA_KEY];

  if (!preview || typeof preview !== "object" || Array.isArray(preview)) {
    return null;
  }

  const progress =
    "progress" in preview && typeof preview.progress === "number"
      ? preview.progress
      : NaN;
  const tailProgress =
    "tailProgress" in preview && typeof preview.tailProgress === "number"
      ? preview.tailProgress
      : NaN;

  return Number.isFinite(progress)
    ? {
        progress: Math.max(0, Math.min(1, progress)),
        ...(Number.isFinite(tailProgress) && tailProgress < 1
          ? { tailProgress: Math.max(0, Math.min(1, tailProgress)) }
          : {}),
      }
    : null;
};

const buildHandwrittenTextOutlineRenderable = (
  element: ExcalidrawTextElement,
  theme: string,
): HandwrittenTextOutlineRenderable | null => {
  if (!shouldRenderHandwrittenTextOutline(element)) {
    return null;
  }

  const fontString = getFontString(element);
  const fontFamily = getFontFamilyString(element);
  const fontSize = element.fontSize;
  const lineHeightPx = getLineHeightInPx(element.fontSize, element.lineHeight);
  const verticalOffset = getVerticalOffset(
    element.fontFamily,
    element.fontSize,
    lineHeightPx,
  );
  const scale = element.fontSize / EXCALIFONT_OUTLINE_MANIFEST.unitsPerEm;
  const fragments: HandwrittenTextOutlineFragment[] = [];
  let hasPathFragment = false;

  const lines = normalizeText(element.text).split("\n");

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const pendingFragments: PendingLineFragment[] = [];
    let fallbackText = "";
    let lineWidth = 0;

    const flushFallbackText = () => {
      if (!fallbackText) {
        return;
      }

      const width = getLineWidth(fallbackText, fontString);
      pendingFragments.push({
        kind: "text",
        text: fallbackText,
        width,
      });
      lineWidth += width;
      fallbackText = "";
    };

    for (const character of Array.from(line)) {
      const codePoint = character.codePointAt(0);
      const glyph = codePoint ? getExcalifontOutlineGlyph(codePoint) : null;

      if (!glyph) {
        fallbackText += character;
        continue;
      }

      flushFallbackText();

      const width = getLineWidth(character, fontString) || glyph.advanceWidth * scale;

      pendingFragments.push({
        glyph,
        kind: "path",
        path: glyph.path,
        text: character,
        width,
      });
      lineWidth += width;

      if (glyph.path) {
        hasPathFragment = true;
      }
    }

    flushFallbackText();

    const baselineY = lineIndex * lineHeightPx + verticalOffset;
    let cursorX = getLineStartX(element, lineWidth);

    for (const fragment of pendingFragments) {
      if (fragment.kind === "path") {
        fragments.push({
          glyph: fragment.glyph,
          kind: "path",
          path: fragment.path,
          scale,
          text: fragment.text,
          width: fragment.width,
          x: cursorX,
          y: baselineY,
        });
      } else {
        fragments.push({
          kind: "text",
          text: fragment.text,
          width: fragment.width,
          x: cursorX,
          y: baselineY,
        });
      }

      cursorX += fragment.width;
    }
  }

  return hasPathFragment
    ? {
        fill: getOutlineFill(element, theme),
        fontFamily,
        fontSize,
        fontString,
        fragments,
      }
    : null;
};

const getPath2D = (path: string) => {
  const cachedPath = outlinePathCache.get(path);

  if (cachedPath) {
    return cachedPath;
  }

  const nextPath = new Path2D(path);
  outlinePathCache.set(path, nextPath);
  return nextPath;
};

const getPathLength = (path: string) => {
  const cachedLength = outlinePathLengthCache.get(path);

  if (cachedLength != null) {
    return cachedLength;
  }

  if (typeof document === "undefined") {
    return null;
  }

  const svgPath = document.createElementNS(SVG_NS, "path");
  svgPath.setAttribute("d", path);

  if (typeof svgPath.getTotalLength !== "function") {
    return null;
  }

  const totalLength = svgPath.getTotalLength();

  if (!Number.isFinite(totalLength) || totalLength <= 0) {
    return null;
  }

  outlinePathLengthCache.set(path, totalLength);
  return totalLength;
};

const createCanvasLayer = (context: CanvasRenderingContext2D) => {
  if (typeof document === "undefined") {
    return null;
  }

  const layer = document.createElement("canvas");
  layer.width = context.canvas.width;
  layer.height = context.canvas.height;
  return layer;
};

const getProgressStrokeWidthPx = ({
  fontSize,
  fragmentWidth,
}: {
  fontSize: number;
  fragmentWidth: number;
}) => {
  return Math.min(
    fontSize * 0.42,
    Math.max(fontSize * 0.22, fragmentWidth * 0.45),
  );
};

const drawProgressedPathFragmentToCanvas = ({
  context,
  fill,
  fontSize,
  fragment,
  progress,
}: {
  context: CanvasRenderingContext2D;
  fill: string;
  fontSize: number;
  fragment: Extract<HandwrittenTextOutlineFragment, { kind: "path" }>;
  progress: number;
}) => {
  const totalLength = getPathLength(fragment.path);
  const layer = createCanvasLayer(context);

  if (!layer || totalLength == null) {
    return false;
  }

  const layerContext = layer.getContext("2d");

  if (!layerContext) {
    return false;
  }

  const clampedProgress = Math.max(0, Math.min(1, progress));
  const path2D = getPath2D(fragment.path);
  const strokeWidthPx = getProgressStrokeWidthPx({
    fontSize,
    fragmentWidth: fragment.width,
  });

  layerContext.save();
  layerContext.fillStyle = fill;
  layerContext.translate(fragment.x, fragment.y);
  layerContext.scale(fragment.scale, -fragment.scale);
  layerContext.fill(path2D);
  layerContext.restore();

  layerContext.save();
  layerContext.globalCompositeOperation = "destination-in";
  layerContext.lineCap = "round";
  layerContext.lineJoin = "round";
  layerContext.strokeStyle = "#000";
  layerContext.translate(fragment.x, fragment.y);
  layerContext.scale(fragment.scale, -fragment.scale);
  layerContext.lineWidth = strokeWidthPx / fragment.scale;
  layerContext.setLineDash([totalLength * clampedProgress, totalLength + 1]);
  layerContext.stroke(path2D);
  layerContext.restore();

  context.drawImage(layer, 0, 0);
  return true;
};

export const getHandwrittenTextOutlinePreviewData = (
  element: ExcalidrawTextElement,
) => {
  return getPreviewProgress(element);
};

export const withHandwrittenTextOutlinePreview = <T extends ExcalidrawTextElement>(
  element: T,
  previewData?: Partial<HandwrittenTextOutlinePreviewData>,
): T => {
  if (!shouldRenderHandwrittenTextOutline(element)) {
    return element;
  }

  return {
    ...element,
    customData: {
      ...(element.customData || {}),
      [HANDWRITTEN_TEXT_OUTLINE_PREVIEW_CUSTOM_DATA_KEY]: {
        progress: Math.max(0, Math.min(1, previewData?.progress ?? 1)),
        ...(typeof previewData?.tailProgress === "number" &&
        Number.isFinite(previewData.tailProgress) &&
        previewData.tailProgress < 1
          ? {
              tailProgress: Math.max(0, Math.min(1, previewData.tailProgress)),
            }
          : {}),
      },
    },
  };
};

export const drawHandwrittenTextOutlineToCanvas = ({
  context,
  element,
  requirePreviewMarker,
  theme,
}: {
  context: CanvasRenderingContext2D;
  element: ExcalidrawTextElement;
  requirePreviewMarker: boolean;
  theme: string;
}) => {
  const previewData = getPreviewProgress(element);

  if (requirePreviewMarker && !previewData) {
    return false;
  }

  if (typeof Path2D !== "function") {
    return false;
  }

  const renderable = buildHandwrittenTextOutlineRenderable(element, theme);

  if (!renderable) {
    return false;
  }

  context.save();
  context.font = renderable.fontString;
  context.fillStyle = renderable.fill;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";

  const partiallyVisibleFragmentIndex =
    previewData?.tailProgress != null && previewData.tailProgress < 1
      ? renderable.fragments.length - 1
      : -1;
  const clipHeight = renderable.fontSize * 3;
  const clipOffsetY = renderable.fontSize * 1.5;

  for (const [fragmentIndex, fragment] of renderable.fragments.entries()) {
    const fragmentTailProgress =
      fragmentIndex === partiallyVisibleFragmentIndex
        ? previewData?.tailProgress
        : undefined;

    if (fragment.kind === "path") {
      if (!fragment.path) {
        continue;
      }

      if (fragmentTailProgress != null) {
        const didDrawProgressedPath = drawProgressedPathFragmentToCanvas({
          context,
          fill: renderable.fill,
          fontSize: renderable.fontSize,
          fragment,
          progress: fragmentTailProgress,
        });

        if (didDrawProgressedPath) {
          continue;
        }
      }

      context.save();
      context.translate(fragment.x, fragment.y);

      if (fragmentTailProgress != null) {
        context.beginPath();
        context.rect(
          0,
          -clipOffsetY,
          fragment.width * fragmentTailProgress,
          clipHeight,
        );
        context.clip();
      }

      context.scale(fragment.scale, -fragment.scale);
      context.fill(getPath2D(fragment.path));
      context.restore();
      continue;
    }

    if (fragmentTailProgress != null) {
      context.save();
      context.beginPath();
      context.rect(
        fragment.x,
        fragment.y - clipOffsetY,
        fragment.width * fragmentTailProgress,
        clipHeight,
      );
      context.clip();
      context.fillText(fragment.text, fragment.x, fragment.y);
      context.restore();
      continue;
    }

    context.fillText(fragment.text, fragment.x, fragment.y);
  }

  context.restore();
  return true;
};

export const appendHandwrittenTextOutlineToSvg = ({
  element,
  node,
  theme,
}: {
  element: ExcalidrawTextElement;
  node: SVGElement;
  theme: string;
}) => {
  const renderable = buildHandwrittenTextOutlineRenderable(element, theme);

  if (!renderable) {
    return false;
  }

  for (const fragment of renderable.fragments) {
    if (fragment.kind === "path") {
      if (!fragment.path) {
        continue;
      }

      const path = node.ownerDocument.createElementNS(SVG_NS, "path");
      path.setAttribute("d", fragment.path);
      path.setAttribute("fill", renderable.fill);
      path.setAttribute(
        "transform",
        `translate(${fragment.x} ${fragment.y}) scale(${fragment.scale} ${-fragment.scale})`,
      );
      node.appendChild(path);
      continue;
    }

    if (!fragment.text) {
      continue;
    }

    const text = node.ownerDocument.createElementNS(SVG_NS, "text");
    text.textContent = fragment.text;
    text.setAttribute("x", `${fragment.x}`);
    text.setAttribute("y", `${fragment.y}`);
    text.setAttribute("font-family", renderable.fontFamily);
    text.setAttribute("font-size", `${renderable.fontSize}px`);
    text.setAttribute("fill", renderable.fill);
    text.setAttribute("text-anchor", "start");
    text.setAttribute("style", "white-space: pre;");
    text.setAttribute("direction", "ltr");
    text.setAttribute("dominant-baseline", "alphabetic");
    node.appendChild(text);
  }

  return true;
};