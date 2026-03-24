import { FONT_FAMILY } from "@excalidraw/common";

import type {
  ExcalidrawElement,
  ExcalidrawElementType,
  FontFamilyValues,
} from "@excalidraw/element/types";

export const ANIMATION_CUSTOM_DATA_KEY = "excalidrawSyncAnimation";
export const DEFAULT_FRAME_HOLD_MS = 800;
export const DEFAULT_FRAME_REVEAL_DELAY_MS = 0;
export const DEFAULT_TRANSITION_DURATION_MS = 350;
export const DEFAULT_ELEMENT_DRAWING_ANIMATION_DURATION_MS = 600;
export const DEFAULT_TEXT_REVEAL_SPEED = "normal";
export const MAX_ANIMATION_MS = 30000;

export type FrameTransitionEasing =
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out";

export type TransitionFallbackPolicy = "cut" | "fade";

export type ElementDrawingAnimationStyle =
  | "none"
  | "draw"
  | "typewriter"
  | "handwritten";

export type ElementDrawingAnimationChoice =
  | "automatic"
  | ElementDrawingAnimationStyle;

export type TextRevealSpeed = "fast" | "normal" | "slow";

export type ElementDrawingAnimation = {
  durationMs?: number;
  speed?: TextRevealSpeed;
  style?: ElementDrawingAnimationStyle;
};

export type AnimationMetadata = {
  linkId?: string;
  holdMs?: number;
  revealDelayMs?: number;
  transition?: {
    durationMs?: number;
    easing?: FrameTransitionEasing;
    fallback?: TransitionFallbackPolicy;
  };
  appearance?: ElementDrawingAnimation;
};

const DRAWING_ANIMATION_STYLES = new Set<ElementDrawingAnimationStyle>([
  "none",
  "draw",
  "typewriter",
  "handwritten",
]);

const TEXT_REVEAL_SPEEDS = new Set<TextRevealSpeed>([
  "fast",
  "normal",
  "slow",
]);

const DRAWING_ANIMATION_SUPPORTED_TYPES = new Set<string>([
  "rectangle",
  "diamond",
  "ellipse",
  "arrow",
  "line",
  "freedraw",
  "text",
]);

export const clampAnimationMs = (value: number, fallback: number) => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.min(Math.round(value), MAX_ANIMATION_MS));
};

export const getTextRevealSpeedForDuration = (durationMs: number) => {
  const clampedDuration = clampAnimationMs(
    durationMs,
    DEFAULT_ELEMENT_DRAWING_ANIMATION_DURATION_MS,
  );

  if (clampedDuration <= 450) {
    return "fast" as const;
  }

  if (clampedDuration >= 800) {
    return "slow" as const;
  }

  return DEFAULT_TEXT_REVEAL_SPEED;
};

export const supportsElementDrawingAnimation = (
  elementOrType: ExcalidrawElement | ExcalidrawElementType | string,
) => {
  const type =
    typeof elementOrType === "string" ? elementOrType : elementOrType.type;

  return DRAWING_ANIMATION_SUPPORTED_TYPES.has(type);
};

export const getDefaultDrawingAnimationStyleForElement = ({
  elementType,
  fontFamily,
}: {
  elementType: ExcalidrawElementType | string;
  fontFamily?: FontFamilyValues;
}): ExcalidrawElementType extends "text"
  ? ElementDrawingAnimationStyle
  : ElementDrawingAnimationStyle => {
  if (elementType !== "text") {
    return "draw";
  }

  switch (fontFamily) {
    case FONT_FAMILY.Excalifont:
    case FONT_FAMILY.Virgil:
      return "handwritten";
    case FONT_FAMILY.Cascadia:
      return "typewriter";
    default:
      return "typewriter";
  }
};

export const normalizeDrawingAnimationChoiceForElement = ({
  choice,
  elementType,
}: {
  choice?: ElementDrawingAnimationChoice;
  elementType: ExcalidrawElementType | string;
}): ElementDrawingAnimationChoice => {
  if (!choice || choice === "automatic") {
    return "automatic";
  }

  if (choice === "draw") {
    return elementType === "text" ? "automatic" : choice;
  }

  if (choice === "typewriter" || choice === "handwritten") {
    return elementType === "text" ? choice : "draw";
  }

  return choice;
};

const normalizeDrawingAnimationStyleForElement = ({
  choice,
  elementType,
}: {
  choice: ElementDrawingAnimationChoice | undefined;
  elementType: ExcalidrawElementType | string;
}): ElementDrawingAnimationStyle | undefined => {
  const normalizedChoice = normalizeDrawingAnimationChoiceForElement({
    choice,
    elementType,
  });

  if (normalizedChoice === "automatic") {
    return undefined;
  }

  return normalizedChoice;
};

export const resolveDrawingAnimationStyleForElement = ({
  choice,
  elementType,
  fontFamily,
}: {
  choice?: ElementDrawingAnimationChoice;
  elementType: ExcalidrawElementType | string;
  fontFamily?: FontFamilyValues;
}) => {
  return (
    normalizeDrawingAnimationStyleForElement({ choice, elementType }) ||
    getDefaultDrawingAnimationStyleForElement({ elementType, fontFamily })
  );
};

const normalizeElementDrawingAnimation = (
  appearance: ElementDrawingAnimation | null,
) => {
  if (!appearance) {
    return null;
  }

  const nextAppearance: ElementDrawingAnimation = {};

  if (appearance.style && DRAWING_ANIMATION_STYLES.has(appearance.style)) {
    nextAppearance.style = appearance.style;
  }

  if (appearance.speed && TEXT_REVEAL_SPEEDS.has(appearance.speed)) {
    nextAppearance.speed = appearance.speed;
  }

  if (
    typeof appearance.durationMs === "number" &&
    Number.isFinite(appearance.durationMs)
  ) {
    nextAppearance.durationMs = clampAnimationMs(
      appearance.durationMs,
      DEFAULT_ELEMENT_DRAWING_ANIMATION_DURATION_MS,
    );
  }

  return Object.keys(nextAppearance).length > 0 ? nextAppearance : null;
};

export const normalizeAnimationMetadata = (metadata: AnimationMetadata | null) => {
  if (!metadata) {
    return null;
  }

  const nextMetadata: AnimationMetadata = {};

  if (metadata.linkId) {
    nextMetadata.linkId = metadata.linkId;
  }

  if (typeof metadata.holdMs === "number" && Number.isFinite(metadata.holdMs)) {
    nextMetadata.holdMs = metadata.holdMs;
  }

  if (
    typeof metadata.revealDelayMs === "number" &&
    Number.isFinite(metadata.revealDelayMs)
  ) {
    nextMetadata.revealDelayMs = metadata.revealDelayMs;
  }

  if (metadata.transition) {
    const nextTransition: NonNullable<AnimationMetadata["transition"]> = {};

    if (
      typeof metadata.transition.durationMs === "number" &&
      Number.isFinite(metadata.transition.durationMs)
    ) {
      nextTransition.durationMs = metadata.transition.durationMs;
    }

    if (metadata.transition.easing) {
      nextTransition.easing = metadata.transition.easing;
    }

    if (metadata.transition.fallback) {
      nextTransition.fallback = metadata.transition.fallback;
    }

    if (Object.keys(nextTransition).length > 0) {
      nextMetadata.transition = nextTransition;
    }
  }

  const nextAppearance = normalizeElementDrawingAnimation(
    metadata.appearance || null,
  );

  if (nextAppearance) {
    nextMetadata.appearance = nextAppearance;
  }

  return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
};

export const getAnimationMetadata = (element: ExcalidrawElement) => {
  const metadata = element.customData?.[ANIMATION_CUSTOM_DATA_KEY];

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  return metadata as AnimationMetadata;
};

export const setAnimationMetadata = <T extends ExcalidrawElement>(
  element: T,
  nextMetadata: AnimationMetadata | null,
) => {
  const nextCustomData = { ...(element.customData || {}) };
  const normalizedMetadata = normalizeAnimationMetadata(nextMetadata);

  if (normalizedMetadata) {
    nextCustomData[ANIMATION_CUSTOM_DATA_KEY] = normalizedMetadata;
  } else {
    delete nextCustomData[ANIMATION_CUSTOM_DATA_KEY];
  }

  return {
    ...element,
    customData:
      Object.keys(nextCustomData).length > 0 ? nextCustomData : undefined,
  } as T;
};

export const buildAnimationCustomData = (
  nextMetadata: AnimationMetadata | null | undefined,
) => {
  const normalizedMetadata = normalizeAnimationMetadata(nextMetadata || null);

  return normalizedMetadata
    ? { [ANIMATION_CUSTOM_DATA_KEY]: normalizedMetadata }
    : undefined;
};

export const getElementDrawingAnimation = (element: ExcalidrawElement) => {
  return getAnimationMetadata(element)?.appearance || null;
};

export const getElementDrawingAnimationChoice = (
  element: ExcalidrawElement,
): ElementDrawingAnimationChoice => {
  return normalizeDrawingAnimationChoiceForElement({
    choice: getElementDrawingAnimation(element)?.style,
    elementType: element.type,
  });
};

export const getElementDrawingAnimationDuration = (
  element: ExcalidrawElement,
) => {
  return clampAnimationMs(
    getElementDrawingAnimation(element)?.durationMs ??
      DEFAULT_ELEMENT_DRAWING_ANIMATION_DURATION_MS,
    DEFAULT_ELEMENT_DRAWING_ANIMATION_DURATION_MS,
  );
};

export const getElementTextRevealSpeed = (element: ExcalidrawElement) => {
  const appearance = getElementDrawingAnimation(element);

  if (appearance?.speed && TEXT_REVEAL_SPEEDS.has(appearance.speed)) {
    return appearance.speed;
  }

  if (
    element.type === "text" &&
    typeof appearance?.durationMs === "number" &&
    Number.isFinite(appearance.durationMs)
  ) {
    return getTextRevealSpeedForDuration(appearance.durationMs);
  }

  return DEFAULT_TEXT_REVEAL_SPEED;
};

export const setElementDrawingAnimation = <T extends ExcalidrawElement>(
  element: T,
  nextAppearance: ElementDrawingAnimation | null,
) => {
  const currentMetadata = getAnimationMetadata(element) || {};

  return setAnimationMetadata(element, {
    ...currentMetadata,
    appearance: nextAppearance || undefined,
  });
};

export const buildElementDrawingAnimation = ({
  choice,
  durationMs,
  elementType,
  fontFamily,
  speed,
}: {
  choice: ElementDrawingAnimationChoice;
  durationMs?: number;
  elementType: ExcalidrawElementType | string;
  fontFamily?: FontFamilyValues;
  speed?: TextRevealSpeed;
}) => {
  if (!supportsElementDrawingAnimation(elementType)) {
    return null;
  }

  const normalizedChoice = normalizeDrawingAnimationChoiceForElement({
    choice,
    elementType,
  });
  const nextAppearance: ElementDrawingAnimation = {};
  const explicitStyle = normalizeDrawingAnimationStyleForElement({
    choice: normalizedChoice,
    elementType,
  });
  const nextDuration = clampAnimationMs(
    durationMs ?? DEFAULT_ELEMENT_DRAWING_ANIMATION_DURATION_MS,
    DEFAULT_ELEMENT_DRAWING_ANIMATION_DURATION_MS,
  );

  if (explicitStyle) {
    nextAppearance.style = explicitStyle;
  }

  if (elementType === "text") {
    const resolvedStyle = resolveDrawingAnimationStyleForElement({
      choice: normalizedChoice,
      elementType,
      fontFamily,
    });

    if (resolvedStyle !== "none") {
      const nextSpeed =
        speed ??
        (typeof durationMs === "number"
          ? getTextRevealSpeedForDuration(durationMs)
          : DEFAULT_TEXT_REVEAL_SPEED);

      if (nextSpeed !== DEFAULT_TEXT_REVEAL_SPEED) {
        nextAppearance.speed = nextSpeed;
      }
    }

    if (Object.keys(nextAppearance).length === 0) {
      return null;
    }

    if (normalizedChoice === "automatic" && !explicitStyle) {
      if (fontFamily) {
        return nextAppearance;
      }
    }

    return nextAppearance;
  }

  if (nextDuration !== DEFAULT_ELEMENT_DRAWING_ANIMATION_DURATION_MS) {
    nextAppearance.durationMs = nextDuration;
  }

  if (Object.keys(nextAppearance).length === 0) {
    return null;
  }

  if (normalizedChoice === "automatic" && !explicitStyle) {
    if (fontFamily && elementType === "text") {
      return nextAppearance;
    }
  }

  return nextAppearance;
};