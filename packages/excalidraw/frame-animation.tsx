import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { KEYS } from "@excalidraw/common";

import {
  CaptureUpdateAction,
  computeBoundTextPosition,
  isBoundToContainer,
  isFreeDrawElement,
  isLinearElement,
  LinearElementEditor,
  newFrameElement,
  withHandwrittenTextOutlinePreview,
} from "@excalidraw/element";

import type {
  ExcalidrawDiamondElement,
  ExcalidrawElement,
  ExcalidrawEllipseElement,
  ExcalidrawFreeDrawElement,
  ExcalidrawFrameElement,
  ExcalidrawLineElement,
  ExcalidrawLinearElement,
  ExcalidrawRectangleElement,
  ExcalidrawTextElement,
  ExcalidrawTextElementWithContainer,
} from "@excalidraw/element/types";

import {
  CloseIcon,
  fullscreenIcon,
  presentationIcon,
} from "./components/icons";
import { useApp, useExcalidrawSetAppState } from "./components/App";
import {
  clampAnimationMs,
  DEFAULT_ELEMENT_DRAWING_ANIMATION_DURATION_MS,
  DEFAULT_FRAME_HOLD_MS,
  DEFAULT_FRAME_REVEAL_DELAY_MS,
  DEFAULT_TRANSITION_DURATION_MS,
  type FrameTransitionEasing,
  getAnimationMetadata,
  getElementDrawingAnimationChoice,
  getElementDrawingAnimationDuration,
  getElementTextRevealSpeed,
  MAX_ANIMATION_MS,
  resolveDrawingAnimationStyleForElement,
  setAnimationMetadata,
  supportsElementDrawingAnimation,
  type TextRevealSpeed,
  type TransitionFallbackPolicy,
} from "./elementAnimation";
import { useCreatePortalContainer } from "./hooks/useCreatePortalContainer";

import type {
  App as ExcalidrawApp,
  AppClassProperties,
  AppState,
  FrameDuplicatePayload,
  FramesNavigatorModeDefinition,
  FramesNavigatorModeRenderContext,
} from "./types";
const PRESENTER_CONTAINER_CLASS = "excalidraw--presenting";

type PlaybackDirection = "forward" | "backward";

type RepairIssue = {
  elementIds: ExcalidrawElement["id"][];
  id: string;
  message: string;
};

type FrameTransitionSettings = {
  durationMs: number;
  easing: FrameTransitionEasing;
  fallback: TransitionFallbackPolicy;
};

type PlaybackTimelineEntry = {
  endMs: number;
  frame: ExcalidrawFrameElement;
  frameIndex: number;
  holdEndMs: number;
  holdMs: number;
  nextFrame: ExcalidrawFrameElement | null;
  revealEndMs: number;
  revealMs: number;
  startMs: number;
  transition: FrameTransitionSettings;
};

type AdjacentPlaybackTransition = {
  direction: PlaybackDirection;
  sourceFrame: ExcalidrawFrameElement;
  sourceFrameIndex: number;
  targetFrame: ExcalidrawFrameElement;
  targetFrameIndex: number;
  transition: FrameTransitionSettings;
  transitionOwnerFrame: ExcalidrawFrameElement;
  transitionOwnerFrameIndex: number;
};

type PlaybackCursor = {
  direction: PlaybackDirection;
  easedProgress: number;
  frame: ExcalidrawFrameElement;
  frameIndex: number;
  frameStartMs: number;
  nextFrame: ExcalidrawFrameElement | null;
  nextFrameIndex: number | null;
  phase: "hold" | "reveal" | "transition";
  progress: number;
  segmentEndMs: number;
  segmentStartMs: number;
  transition: FrameTransitionSettings;
  transitionOwnerFrame: ExcalidrawFrameElement | null;
  transitionOwnerFrameIndex: number | null;
};

type FrameRevealPlan = {
  revealableElementIds: Set<ExcalidrawElement["id"]>;
  revealDurationMs: number;
};

type PlaybackSourceScene = {
  elements: readonly ExcalidrawElement[];
  orderedFrames: readonly ExcalidrawFrameElement[];
};

type PreviewStageFrame = Pick<
  ExcalidrawFrameElement,
  "height" | "width" | "x" | "y"
>;

type PrimitiveRevealShapeElement =
  | ExcalidrawDiamondElement
  | ExcalidrawEllipseElement
  | ExcalidrawRectangleElement;

type PresenterViewportSnapshot = {
  frameRendering: AppState["frameRendering"];
  selectedGroupIds: AppState["selectedGroupIds"];
  scrollX: AppState["scrollX"];
  scrollY: AppState["scrollY"];
  selectedElementIds: AppState["selectedElementIds"];
  zoom: AppState["zoom"];
};

type PreviewInterpolationKind = "generic" | "linear" | "freedraw";

type PreviewInterpolationPair = {
  currentElement: ExcalidrawElement;
  kind: PreviewInterpolationKind;
  nextElement: ExcalidrawElement;
};

type PlaybackPreviewIssue = {
  id: string;
  message: string;
};

type PlaybackPreviewDiagnostics = {
  animatedPairCount: number;
  fallbackCurrentCount: number;
  fallbackNextCount: number;
  issues: readonly PlaybackPreviewIssue[];
};

type PlaybackPreviewPlan = {
  diagnostics: PlaybackPreviewDiagnostics;
  pairedNextElementIds: ReadonlySet<ExcalidrawElement["id"]>;
  pairsByCurrentElementId: ReadonlyMap<
    ExcalidrawElement["id"],
    PreviewInterpolationPair
  >;
};

export type PresenterFullscreenRequestPayload = {
  currentFrame: ExcalidrawFrameElement;
  currentFrameIndex: number;
  presenterElement: HTMLDivElement | null;
  totalFrames: number;
};

export type FrameAnimationModeOptions = {
  onPresenterFullscreenRequest?: (
    payload: PresenterFullscreenRequestPayload,
  ) => void;
  suppressSceneChange?: () => void;
};

type PresentationStartRequest = {
  automated: boolean;
  frameIndex: number;
};

type PresentationController = {
  consumePresentRequest: () => PresentationStartRequest | null;
  requestPresent: (request: PresentationStartRequest) => void;
  subscribe: (listener: () => void) => () => void;
};

const TRANSITION_EASINGS: readonly FrameTransitionEasing[] = [
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
];

const TRANSITION_EASING_LABELS: Record<FrameTransitionEasing, string> = {
  linear: "Linear",
  "ease-in": "Ease in",
  "ease-out": "Ease out",
  "ease-in-out": "Ease in/out",
};

const PRESENTER_CONTROLS_HOTSPOT_HEIGHT = 128;
const PRESENTER_CONTROLS_HOTSPOT_WIDTH = 176;
const ELLIPSE_REVEAL_SEGMENTS = 72;
const TYPEWRITER_TEXT_REVEAL_MS_PER_CHARACTER: Record<TextRevealSpeed, number> =
  {
    fast: 35,
    normal: 55,
    slow: 80,
  };
const HANDWRITTEN_TEXT_REVEAL_MS_PER_CHARACTER: Record<
  TextRevealSpeed,
  number
> = {
  fast: 50,
  normal: 100,
  slow: 300,
};
const HANDWRITTEN_TEXT_REVEAL_SPACE_WEIGHT = 1.6;
const HANDWRITTEN_TEXT_REVEAL_PUNCTUATION_WEIGHT = 2.2;
const HANDWRITTEN_TEXT_REVEAL_LINE_BREAK_WEIGHT = 2.8;
const HANDWRITTEN_TEXT_REVEAL_PUNCTUATION = new Set([
  ",",
  ".",
  "!",
  "?",
  ";",
  ":",
]);

const TRANSITION_FALLBACKS: readonly TransitionFallbackPolicy[] = [
  "cut",
  "fade",
];

const TRANSITION_FALLBACK_LABELS: Record<TransitionFallbackPolicy, string> = {
  cut: "Cut",
  fade: "Fade",
};

// Keep this literal in sync with the renderer-side primitive reveal preview key.
const PRIMITIVE_REVEAL_PREVIEW_CUSTOM_DATA_KEY =
  "excalidrawSyncPrimitiveRevealPreview";

const createPresentationController = (): PresentationController => {
  let pendingPresentRequest: PresentationStartRequest | null = null;
  const listeners = new Set<() => void>();

  return {
    consumePresentRequest: () => {
      const nextRequest = pendingPresentRequest;
      pendingPresentRequest = null;
      return nextRequest;
    },
    requestPresent: (request) => {
      pendingPresentRequest = request;
      listeners.forEach((listener) => {
        listener();
      });
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
};

const shouldUsePresenterControlsHotspot = () => {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }

  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
};

const shouldShowPresenterControlsForPointer = (
  clientX: number,
  clientY: number,
) => {
  if (typeof window === "undefined") {
    return true;
  }

  const viewportWidth =
    window.innerWidth || document.documentElement.clientWidth || 0;

  return (
    clientX >= Math.max(0, viewportWidth - PRESENTER_CONTROLS_HOTSPOT_WIDTH) &&
    clientY <= PRESENTER_CONTROLS_HOTSPOT_HEIGHT
  );
};

const isFrameLikeElement = (element: ExcalidrawElement) => {
  return element.type === "frame" || element.type === "magicframe";
};

const isNormalFrameElement = (
  element: ExcalidrawElement,
): element is ExcalidrawFrameElement => {
  return element.type === "frame" && !element.isDeleted;
};

const isLinkableElement = (element: ExcalidrawElement) => {
  return !element.isDeleted && !isFrameLikeElement(element);
};

const getFrameHoldMs = (frame: ExcalidrawFrameElement) => {
  const metadata = getAnimationMetadata(frame);
  return clampAnimationMs(
    metadata?.holdMs ?? DEFAULT_FRAME_HOLD_MS,
    DEFAULT_FRAME_HOLD_MS,
  );
};

const getFrameRevealDelayMs = (frame: ExcalidrawFrameElement) => {
  const metadata = getAnimationMetadata(frame);

  return clampAnimationMs(
    metadata?.revealDelayMs ?? DEFAULT_FRAME_REVEAL_DELAY_MS,
    DEFAULT_FRAME_REVEAL_DELAY_MS,
  );
};

const getFrameTransition = (
  frame: ExcalidrawFrameElement,
): FrameTransitionSettings => {
  const metadata = getAnimationMetadata(frame);

  return {
    durationMs: clampAnimationMs(
      metadata?.transition?.durationMs ?? DEFAULT_TRANSITION_DURATION_MS,
      DEFAULT_TRANSITION_DURATION_MS,
    ),
    easing: metadata?.transition?.easing || "ease-in-out",
    fallback: metadata?.transition?.fallback || "fade",
  };
};

const setFrameHoldMs = (
  frame: ExcalidrawFrameElement,
  holdMs: number,
): ExcalidrawFrameElement => {
  const currentMetadata = getAnimationMetadata(frame) || {};

  return setAnimationMetadata(frame, {
    ...currentMetadata,
    holdMs: clampAnimationMs(holdMs, DEFAULT_FRAME_HOLD_MS),
  });
};

const setFrameRevealDelayMs = (
  frame: ExcalidrawFrameElement,
  revealDelayMs: number,
): ExcalidrawFrameElement => {
  const currentMetadata = getAnimationMetadata(frame) || {};

  return setAnimationMetadata(frame, {
    ...currentMetadata,
    revealDelayMs: clampAnimationMs(
      revealDelayMs,
      DEFAULT_FRAME_REVEAL_DELAY_MS,
    ),
  });
};

const setFrameTransition = (
  frame: ExcalidrawFrameElement,
  nextTransition: Partial<FrameTransitionSettings>,
): ExcalidrawFrameElement => {
  const currentMetadata = getAnimationMetadata(frame) || {};
  const currentTransition = getFrameTransition(frame);

  return setAnimationMetadata(frame, {
    ...currentMetadata,
    transition: {
      durationMs: clampAnimationMs(
        nextTransition.durationMs ?? currentTransition.durationMs,
        DEFAULT_TRANSITION_DURATION_MS,
      ),
      easing: nextTransition.easing ?? currentTransition.easing,
      fallback: nextTransition.fallback ?? currentTransition.fallback,
    },
  });
};

const setElementLinkId = (element: ExcalidrawElement, linkId: string) => {
  const currentMetadata = getAnimationMetadata(element) || {};

  if (currentMetadata.linkId === linkId) {
    return element;
  }

  return setAnimationMetadata(element, {
    ...currentMetadata,
    linkId,
  });
};

const clearElementLinkId = (element: ExcalidrawElement) => {
  const currentMetadata = getAnimationMetadata(element);

  if (!currentMetadata?.linkId) {
    return element;
  }

  const { linkId: _removedLinkId, ...restMetadata } = currentMetadata;
  return setAnimationMetadata(
    element,
    Object.keys(restMetadata).length > 0 ? restMetadata : null,
  );
};

const createLinkId = () => {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  return `link-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
};

export const getElementLinkId = (element: ExcalidrawElement) => {
  return getAnimationMetadata(element)?.linkId || null;
};

const getOrderedFrameIndexById = (
  orderedFrames: readonly ExcalidrawFrameElement[],
) => {
  return new Map(
    orderedFrames.map((frame, index) => [frame.id, index] as const),
  );
};

const buildPlaybackLinkedRenderSeedByElementId = ({
  elements,
  orderedFrames,
}: {
  elements: readonly ExcalidrawElement[];
  orderedFrames: readonly ExcalidrawFrameElement[];
}) => {
  const frameIndexById = getOrderedFrameIndexById(orderedFrames);
  const stableSeedByLinkId = new Map<
    string,
    {
      elementId: ExcalidrawElement["id"];
      frameIndex: number;
      seed: number;
    }
  >();

  for (const element of elements) {
    const linkId = getElementLinkId(element);

    if (!linkId || !isLinkableElement(element) || !element.frameId) {
      continue;
    }

    const frameIndex = frameIndexById.get(element.frameId);

    if (frameIndex == null) {
      continue;
    }

    const currentBest = stableSeedByLinkId.get(linkId);

    if (
      !currentBest ||
      frameIndex < currentBest.frameIndex ||
      (frameIndex === currentBest.frameIndex &&
        element.id.localeCompare(currentBest.elementId) < 0)
    ) {
      stableSeedByLinkId.set(linkId, {
        elementId: element.id,
        frameIndex,
        seed: element.seed,
      });
    }
  }

  const stableSeedByElementId = new Map<
    ExcalidrawElement["id"],
    ExcalidrawElement["seed"]
  >();

  for (const element of elements) {
    const linkId = getElementLinkId(element);
    const stableSeed = linkId
      ? stableSeedByLinkId.get(linkId)?.seed
      : undefined;

    if (stableSeed == null || stableSeed === element.seed) {
      continue;
    }

    stableSeedByElementId.set(element.id, stableSeed);
  }

  return stableSeedByElementId;
};

const applyPlaybackLinkedRenderSeed = <T extends ExcalidrawElement>(
  element: T,
  linkedRenderSeedByElementId: ReadonlyMap<
    ExcalidrawElement["id"],
    ExcalidrawElement["seed"]
  >,
): T => {
  const stableSeed = linkedRenderSeedByElementId.get(element.id);

  if (stableSeed == null || stableSeed === element.seed) {
    return element;
  }

  return {
    ...element,
    seed: stableSeed,
  } as T;
};

const getFrameById = (orderedFrames: readonly ExcalidrawFrameElement[]) => {
  return new Map(orderedFrames.map((frame) => [frame.id, frame] as const));
};

const getFrameLabel = (frame: ExcalidrawFrameElement | undefined) => {
  return frame?.name || "Unnamed frame";
};

const getFrameChildren = (
  elements: readonly ExcalidrawElement[],
  frameId: ExcalidrawFrameElement["id"],
) => {
  return elements.filter((element) => {
    return isLinkableElement(element) && element.frameId === frameId;
  });
};

const buildAdjacentTransitionControlledElementIds = ({
  sourceFrameChildren,
  targetFrameChildren,
}: {
  sourceFrameChildren: readonly ExcalidrawElement[];
  targetFrameChildren: readonly ExcalidrawElement[];
}) => {
  const sourceLinkIds = new Set<string>();

  for (const element of sourceFrameChildren) {
    const linkId = getAnimationMetadata(element)?.linkId;

    if (linkId) {
      sourceLinkIds.add(linkId);
    }
  }

  if (!sourceLinkIds.size) {
    return new Set<ExcalidrawElement["id"]>();
  }

  const transitionControlledElementIds = new Set<ExcalidrawElement["id"]>();

  for (const element of targetFrameChildren) {
    const linkId = getAnimationMetadata(element)?.linkId;

    if (linkId && sourceLinkIds.has(linkId)) {
      transitionControlledElementIds.add(element.id);
    }
  }

  return transitionControlledElementIds;
};

const getResolvedElementRevealStyle = (element: ExcalidrawElement) => {
  if (!supportsElementDrawingAnimation(element)) {
    return null;
  }

  const style = resolveDrawingAnimationStyleForElement({
    choice: getElementDrawingAnimationChoice(element),
    elementType: element.type,
    fontFamily: element.type === "text" ? element.fontFamily : undefined,
  });

  return style === "none" ? null : style;
};

const getHandwrittenTextRevealUnitWeight = (character: string) => {
  if (character === "\n" || character === "\r") {
    return HANDWRITTEN_TEXT_REVEAL_LINE_BREAK_WEIGHT;
  }

  if (HANDWRITTEN_TEXT_REVEAL_PUNCTUATION.has(character)) {
    return HANDWRITTEN_TEXT_REVEAL_PUNCTUATION_WEIGHT;
  }

  if (/\s/u.test(character)) {
    return HANDWRITTEN_TEXT_REVEAL_SPACE_WEIGHT;
  }

  return 1;
};

const getTextRevealUnitWeight = (
  character: string,
  revealStyle: "handwritten" | "typewriter",
) => {
  return revealStyle === "handwritten"
    ? getHandwrittenTextRevealUnitWeight(character)
    : 1;
};

const getTextRevealUnits = (
  text: string,
  revealStyle: "handwritten" | "typewriter",
) => {
  return Array.from(text).map((character) =>
    getTextRevealUnitWeight(character, revealStyle),
  );
};

const getTextRevealDurationMs = (
  element: ExcalidrawTextElement,
  revealStyle: "handwritten" | "typewriter",
) => {
  const appearance = getAnimationMetadata(element)?.appearance;

  if (
    typeof appearance?.durationMs === "number" &&
    Number.isFinite(appearance.durationMs) &&
    !appearance.speed
  ) {
    return clampAnimationMs(
      appearance.durationMs,
      DEFAULT_ELEMENT_DRAWING_ANIMATION_DURATION_MS,
    );
  }

  const totalUnits = getTextRevealUnits(element.text, revealStyle).reduce(
    (sum, unit) => sum + unit,
    0,
  );

  if (totalUnits <= 0) {
    return 0;
  }

  const perCharacterMs =
    revealStyle === "handwritten"
      ? HANDWRITTEN_TEXT_REVEAL_MS_PER_CHARACTER[
          getElementTextRevealSpeed(element)
        ]
      : TYPEWRITER_TEXT_REVEAL_MS_PER_CHARACTER[
          getElementTextRevealSpeed(element)
        ];

  return clampAnimationMs(
    totalUnits * perCharacterMs,
    DEFAULT_ELEMENT_DRAWING_ANIMATION_DURATION_MS,
  );
};

const getElementRevealDurationMs = (element: ExcalidrawElement) => {
  const revealStyle = getResolvedElementRevealStyle(element);

  if (
    element.type === "text" &&
    (revealStyle === "typewriter" || revealStyle === "handwritten")
  ) {
    return getTextRevealDurationMs(element, revealStyle);
  }

  return getElementDrawingAnimationDuration(element);
};

const buildFrameRevealPlan = (
  frameChildren: readonly ExcalidrawElement[],
  transitionControlledElementIds?: ReadonlySet<ExcalidrawElement["id"]>,
): FrameRevealPlan => {
  const revealableElements = frameChildren.filter((element) => {
    return (
      !transitionControlledElementIds?.has(element.id) &&
      !!getResolvedElementRevealStyle(element)
    );
  });
  const revealableElementIds = new Set(
    revealableElements.map((element) => element.id),
  );
  const revealDurationMs = revealableElements.reduce((maxDuration, element) => {
    return Math.max(maxDuration, getElementRevealDurationMs(element));
  }, 0);

  return {
    revealableElementIds,
    revealDurationMs,
  };
};

const getRevealStateForElement = ({
  elapsedMs,
  element,
  revealDelayMs,
  revealPlan,
}: {
  elapsedMs: number;
  element: ExcalidrawElement;
  revealDelayMs: number;
  revealPlan: FrameRevealPlan;
}) => {
  if (!revealPlan.revealableElementIds.has(element.id)) {
    return { progress: 1, visible: true };
  }

  if (elapsedMs < revealDelayMs) {
    return { progress: 0, visible: false };
  }

  const revealElapsedMs = elapsedMs - revealDelayMs;
  const durationMs = getElementRevealDurationMs(element);

  if (durationMs <= 0 || revealElapsedMs >= durationMs) {
    return { progress: 1, visible: true };
  }

  return {
    progress: revealElapsedMs / durationMs,
    visible: true,
  };
};

const getBoundTextRevealContainer = (
  element: ExcalidrawElement,
  frameChildrenById: ReadonlyMap<ExcalidrawElement["id"], ExcalidrawElement>,
) => {
  if (!isBoundToContainer(element)) {
    return null;
  }

  return frameChildrenById.get(element.containerId) || null;
};

const getPreviewRevealStateForElement = ({
  elapsedMs,
  element,
  frameChildrenById,
  revealDelayMs,
  revealPlan,
}: {
  elapsedMs: number;
  element: ExcalidrawElement;
  frameChildrenById: ReadonlyMap<ExcalidrawElement["id"], ExcalidrawElement>;
  revealDelayMs: number;
  revealPlan: FrameRevealPlan;
}) => {
  const elementRevealState = getRevealStateForElement({
    elapsedMs,
    element,
    revealDelayMs,
    revealPlan,
  });
  const container = getBoundTextRevealContainer(element, frameChildrenById);

  if (!container) {
    return {
      containerProgress: 1,
      ...elementRevealState,
    };
  }

  const containerRevealState = getRevealStateForElement({
    elapsedMs,
    element: container,
    revealDelayMs,
    revealPlan,
  });

  return {
    containerProgress: containerRevealState.progress,
    progress: Math.min(
      elementRevealState.progress,
      containerRevealState.progress,
    ),
    visible: elementRevealState.visible && containerRevealState.visible,
  };
};

const shouldHideElementUntilReveal = ({
  element,
  frameChildrenById,
  revealPlan,
}: {
  element: ExcalidrawElement;
  frameChildrenById: ReadonlyMap<ExcalidrawElement["id"], ExcalidrawElement>;
  revealPlan: FrameRevealPlan;
}) => {
  if (revealPlan.revealableElementIds.has(element.id)) {
    return true;
  }

  const container = getBoundTextRevealContainer(element, frameChildrenById);
  return !!container && revealPlan.revealableElementIds.has(container.id);
};

const buildLinkedElementGroups = (elements: readonly ExcalidrawElement[]) => {
  const linkedElementGroups = new Map<string, ExcalidrawElement[]>();

  for (const element of elements) {
    const linkId = getElementLinkId(element);
    if (!linkId) {
      continue;
    }

    const group = linkedElementGroups.get(linkId) || [];
    group.push(element);
    linkedElementGroups.set(linkId, group);
  }

  return linkedElementGroups;
};

const getPreviewStageFrame = (
  frame: ExcalidrawFrameElement,
): PreviewStageFrame => {
  return {
    height: frame.height,
    width: frame.width,
    x: frame.x,
    y: frame.y,
  };
};
const getConfiguredFrameIndex = (
  orderedFrames: readonly ExcalidrawFrameElement[],
  selectedElementIds: AppState["selectedElementIds"],
) => {
  if (!orderedFrames.length) {
    return -1;
  }

  const selectedFrameIndex = orderedFrames.findIndex((frame) => {
    return selectedElementIds[frame.id];
  });

  return selectedFrameIndex >= 0 ? selectedFrameIndex : 0;
};

const capturePresenterViewportSnapshot = (
  app: AppClassProperties,
): PresenterViewportSnapshot => {
  return {
    frameRendering: { ...app.state.frameRendering },
    selectedGroupIds: { ...app.state.selectedGroupIds },
    scrollX: app.state.scrollX,
    scrollY: app.state.scrollY,
    selectedElementIds: { ...app.state.selectedElementIds },
    zoom: { ...app.state.zoom },
  };
};

const restorePresenterViewportSnapshot = (
  app: AppClassProperties,
  snapshot: PresenterViewportSnapshot,
) => {
  app.syncActionResult({
    appState: {
      frameRendering: snapshot.frameRendering,
      selectedGroupIds: snapshot.selectedGroupIds,
      scrollX: snapshot.scrollX,
      scrollY: snapshot.scrollY,
      selectedElementIds: snapshot.selectedElementIds,
      zoom: snapshot.zoom,
    },
    captureUpdate: CaptureUpdateAction.NEVER,
  });
};

const setPresenterContainerClass = (
  app: AppClassProperties,
  isPresenting: boolean,
) => {
  document.body.classList.toggle(PRESENTER_CONTAINER_CLASS, isPresenting);

  const container =
    app.excalidrawContainerValue.container ||
    (app.interactiveCanvas?.closest(
      ".excalidraw-container",
    ) as HTMLElement | null);

  container?.classList.toggle(PRESENTER_CONTAINER_CLASS, isPresenting);
};

const getPreviewStageAnchorFrame = (cursor: PlaybackCursor) => {
  if (
    cursor.phase === "transition" &&
    cursor.nextFrame &&
    cursor.progress >= 0.5
  ) {
    return cursor.nextFrame;
  }

  return cursor.frame;
};

const getPlaybackPreviewKey = (cursor: PlaybackCursor) => {
  switch (cursor.phase) {
    case "hold":
      return `hold:${cursor.frame.id}`;
    case "reveal":
      return `reveal:${cursor.frame.id}:${Math.round(cursor.progress * 1000)}`;
    case "transition":
      return `transition:${cursor.direction}:${cursor.frame.id}:${
        cursor.nextFrame?.id
      }:${Math.round(cursor.easedProgress * 1000)}`;
  }
};

const rebaseFrameElementToPreviewStage = <T extends ExcalidrawFrameElement>(
  frame: T,
  stage: PreviewStageFrame,
): T => {
  return {
    ...frame,
    height: stage.height,
    width: stage.width,
    x: stage.x,
    y: stage.y,
  };
};

const rebaseElementToPreviewStage = <T extends ExcalidrawElement>(
  element: T,
  frame: ExcalidrawFrameElement,
  stage: PreviewStageFrame,
): T => {
  const deltaX = stage.x - frame.x;
  const deltaY = stage.y - frame.y;

  return {
    ...element,
    x: element.x + deltaX,
    y: element.y + deltaY,
  } as T;
};

const buildPlaybackTimeline = (
  elements: readonly ExcalidrawElement[],
  orderedFrames: readonly ExcalidrawFrameElement[],
) => {
  let elapsedMs = 0;

  return orderedFrames.map((frame, frameIndex) => {
    const frameChildren = getFrameChildren(elements, frame.id);
    const previousFrame = orderedFrames[frameIndex - 1] || null;
    const nextFrame = orderedFrames[frameIndex + 1] || null;
    const revealSuppressedElementIds = previousFrame
      ? buildAdjacentTransitionControlledElementIds({
          sourceFrameChildren: getFrameChildren(elements, previousFrame.id),
          targetFrameChildren: frameChildren,
        })
      : nextFrame
      ? buildAdjacentTransitionControlledElementIds({
          sourceFrameChildren: getFrameChildren(elements, nextFrame.id),
          targetFrameChildren: frameChildren,
        })
      : undefined;
    const revealPlan = buildFrameRevealPlan(
      frameChildren,
      revealSuppressedElementIds,
    );
    const revealDelayMs = revealPlan.revealableElementIds.size
      ? getFrameRevealDelayMs(frame)
      : 0;
    const revealMs = revealDelayMs + revealPlan.revealDurationMs;
    const holdMs = getFrameHoldMs(frame);
    const transition = getFrameTransition(frame);
    const durationMs = nextFrame ? transition.durationMs : 0;
    const entry: PlaybackTimelineEntry = {
      endMs: elapsedMs + revealMs + holdMs + durationMs,
      frame,
      frameIndex,
      holdEndMs: elapsedMs + revealMs + holdMs,
      holdMs,
      nextFrame,
      revealEndMs: elapsedMs + revealMs,
      revealMs,
      startMs: elapsedMs,
      transition: {
        ...transition,
        durationMs,
      },
    };

    elapsedMs = entry.endMs;

    return entry;
  });
};

const getFrameStartMs = (
  timeline: readonly PlaybackTimelineEntry[],
  frameIndex: number,
) => {
  if (!timeline.length) {
    return 0;
  }

  const clampedIndex = Math.max(0, Math.min(frameIndex, timeline.length - 1));
  return timeline[clampedIndex].startMs;
};

const getFrameRevealEndMs = (
  timeline: readonly PlaybackTimelineEntry[],
  frameIndex: number,
) => {
  if (!timeline.length) {
    return 0;
  }

  const clampedIndex = Math.max(0, Math.min(frameIndex, timeline.length - 1));
  return timeline[clampedIndex].revealEndMs;
};

const getResolvedFramePlaybackMs = ({
  timeline,
  frameIndex,
  settled,
}: {
  timeline: readonly PlaybackTimelineEntry[];
  frameIndex: number;
  settled: boolean;
}) => {
  if (!timeline.length) {
    return 0;
  }

  const clampedIndex = Math.max(0, Math.min(frameIndex, timeline.length - 1));
  const entry = timeline[clampedIndex];
  const previousEntry = clampedIndex > 0 ? timeline[clampedIndex - 1] : null;
  const baseMs = settled ? entry.revealEndMs : entry.startMs;

  if (
    !previousEntry ||
    previousEntry.transition.durationMs > 0 ||
    baseMs > entry.startMs
  ) {
    return baseMs;
  }

  return Math.min(entry.startMs + 0.001, entry.endMs);
};

const getTotalPlaybackMs = (timeline: readonly PlaybackTimelineEntry[]) => {
  return timeline.at(-1)?.endMs ?? 0;
};

const applyTransitionEasing = (
  progress: number,
  easing: FrameTransitionEasing,
) => {
  switch (easing) {
    case "linear":
      return progress;
    case "ease-in":
      return progress * progress;
    case "ease-out":
      return 1 - (1 - progress) * (1 - progress);
    case "ease-in-out":
      return progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;
  }
};

const applyDirectedTransitionEasing = (
  progress: number,
  easing: FrameTransitionEasing,
  direction: PlaybackDirection,
) => {
  if (direction === "forward") {
    return applyTransitionEasing(progress, easing);
  }

  return 1 - applyTransitionEasing(1 - progress, easing);
};

export const getAdjacentPlaybackTransition = ({
  direction,
  orderedFrames,
  sourceFrameIndex,
}: {
  direction: PlaybackDirection;
  orderedFrames: readonly ExcalidrawFrameElement[];
  sourceFrameIndex: number;
}): AdjacentPlaybackTransition | null => {
  const sourceFrame = orderedFrames[sourceFrameIndex];
  const targetFrameIndex =
    direction === "forward" ? sourceFrameIndex + 1 : sourceFrameIndex - 1;
  const targetFrame = orderedFrames[targetFrameIndex];

  if (!sourceFrame || !targetFrame) {
    return null;
  }

  const transitionOwnerFrameIndex = Math.min(
    sourceFrameIndex,
    targetFrameIndex,
  );
  const transitionOwnerFrame = orderedFrames[transitionOwnerFrameIndex];

  if (!transitionOwnerFrame) {
    return null;
  }

  return {
    direction,
    sourceFrame,
    sourceFrameIndex,
    targetFrame,
    targetFrameIndex,
    transition: getFrameTransition(transitionOwnerFrame),
    transitionOwnerFrame,
    transitionOwnerFrameIndex,
  };
};

export const buildAdjacentPlaybackCursor = (
  transition: AdjacentPlaybackTransition,
  playbackMs: number,
): PlaybackCursor => {
  const durationMs = transition.transition.durationMs;
  const clampedPlaybackMs = Math.max(0, Math.min(playbackMs, durationMs));
  const progress = durationMs > 0 ? clampedPlaybackMs / durationMs : 1;

  return {
    direction: transition.direction,
    easedProgress: applyDirectedTransitionEasing(
      progress,
      transition.transition.easing,
      transition.direction,
    ),
    frame: transition.sourceFrame,
    frameIndex: transition.sourceFrameIndex,
    frameStartMs: 0,
    nextFrame: transition.targetFrame,
    nextFrameIndex: transition.targetFrameIndex,
    phase: "transition",
    progress,
    segmentEndMs: durationMs,
    segmentStartMs: 0,
    transition: transition.transition,
    transitionOwnerFrame: transition.transitionOwnerFrame,
    transitionOwnerFrameIndex: transition.transitionOwnerFrameIndex,
  };
};

const getVisibleFrameIndex = (cursor: PlaybackCursor | null) => {
  if (!cursor) {
    return 0;
  }

  if (
    cursor.phase === "transition" &&
    cursor.nextFrameIndex != null &&
    cursor.progress >= 0.5
  ) {
    return cursor.nextFrameIndex;
  }

  return cursor.frameIndex;
};

const getPlaybackCursor = (
  timeline: readonly PlaybackTimelineEntry[],
  playbackMs: number,
): PlaybackCursor | null => {
  if (!timeline.length) {
    return null;
  }

  const clampedPlaybackMs = Math.max(
    0,
    Math.min(playbackMs, getTotalPlaybackMs(timeline)),
  );

  for (const entry of timeline) {
    if (!entry.nextFrame) {
      if (entry.revealMs > 0 && clampedPlaybackMs < entry.revealEndMs) {
        return {
          direction: "forward",
          easedProgress: 0,
          frame: entry.frame,
          frameIndex: entry.frameIndex,
          frameStartMs: entry.startMs,
          nextFrame: null,
          nextFrameIndex: null,
          phase: "reveal",
          progress: (clampedPlaybackMs - entry.startMs) / entry.revealMs,
          segmentEndMs: entry.revealEndMs,
          segmentStartMs: entry.startMs,
          transition: entry.transition,
          transitionOwnerFrame: null,
          transitionOwnerFrameIndex: null,
        };
      }

      return {
        direction: "forward",
        easedProgress: 0,
        frame: entry.frame,
        frameIndex: entry.frameIndex,
        frameStartMs: entry.startMs,
        nextFrame: null,
        nextFrameIndex: null,
        phase: "hold",
        progress:
          entry.holdMs > 0
            ? (clampedPlaybackMs - entry.revealEndMs) / entry.holdMs
            : 1,
        segmentEndMs: entry.holdEndMs,
        segmentStartMs: entry.revealEndMs,
        transition: entry.transition,
        transitionOwnerFrame: null,
        transitionOwnerFrameIndex: null,
      };
    }

    if (entry.revealMs > 0 && clampedPlaybackMs < entry.revealEndMs) {
      return {
        direction: "forward",
        easedProgress: 0,
        frame: entry.frame,
        frameIndex: entry.frameIndex,
        frameStartMs: entry.startMs,
        nextFrame: entry.nextFrame,
        nextFrameIndex: entry.frameIndex + 1,
        phase: "reveal",
        progress: (clampedPlaybackMs - entry.startMs) / entry.revealMs,
        segmentEndMs: entry.revealEndMs,
        segmentStartMs: entry.startMs,
        transition: entry.transition,
        transitionOwnerFrame: entry.frame,
        transitionOwnerFrameIndex: entry.frameIndex,
      };
    }

    if (clampedPlaybackMs <= entry.holdEndMs) {
      return {
        direction: "forward",
        easedProgress: 0,
        frame: entry.frame,
        frameIndex: entry.frameIndex,
        frameStartMs: entry.startMs,
        nextFrame: entry.nextFrame,
        nextFrameIndex: entry.frameIndex + 1,
        phase: "hold",
        progress:
          entry.holdMs > 0
            ? (clampedPlaybackMs - entry.revealEndMs) / entry.holdMs
            : 1,
        segmentEndMs: entry.holdEndMs,
        segmentStartMs: entry.revealEndMs,
        transition: entry.transition,
        transitionOwnerFrame: entry.frame,
        transitionOwnerFrameIndex: entry.frameIndex,
      };
    }

    if (clampedPlaybackMs < entry.endMs && entry.transition.durationMs > 0) {
      const progress =
        (clampedPlaybackMs - entry.holdEndMs) / entry.transition.durationMs;

      return {
        direction: "forward",
        easedProgress: applyDirectedTransitionEasing(
          progress,
          entry.transition.easing,
          "forward",
        ),
        frame: entry.frame,
        frameIndex: entry.frameIndex,
        frameStartMs: entry.startMs,
        nextFrame: entry.nextFrame,
        nextFrameIndex: entry.frameIndex + 1,
        phase: "transition",
        progress,
        segmentEndMs: entry.endMs,
        segmentStartMs: entry.holdEndMs,
        transition: entry.transition,
        transitionOwnerFrame: entry.frame,
        transitionOwnerFrameIndex: entry.frameIndex,
      };
    }
  }

  const lastEntry = timeline.at(-1)!;
  return {
    direction: "forward",
    easedProgress: 0,
    frame: lastEntry.frame,
    frameIndex: lastEntry.frameIndex,
    frameStartMs: lastEntry.startMs,
    nextFrame: null,
    nextFrameIndex: null,
    phase: "hold",
    progress: 1,
    segmentEndMs: lastEntry.holdEndMs,
    segmentStartMs: lastEntry.revealEndMs,
    transition: lastEntry.transition,
    transitionOwnerFrame: null,
    transitionOwnerFrameIndex: null,
  };
};

const getPreviewInterpolationKind = (
  left: ExcalidrawElement,
  right: ExcalidrawElement,
): PreviewInterpolationKind | null => {
  if (
    left.type !== right.type ||
    isFrameLikeElement(left) ||
    isFrameLikeElement(right)
  ) {
    return null;
  }

  if (isLinearElement(left) && isLinearElement(right)) {
    return "linear";
  }

  if (isFreeDrawElement(left) && isFreeDrawElement(right)) {
    return "freedraw";
  }

  return "generic";
};

const lerp = (start: number, end: number, progress: number) => {
  return start + (end - start) * progress;
};

const clampUnitProgress = (value: number) => {
  return Math.max(0, Math.min(1, value));
};

const clampOpacity = (value: number) => {
  return Math.max(0, Math.min(100, Math.round(value)));
};

const getPointDistance = (
  left: readonly [number, number],
  right: readonly [number, number],
) => {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
};

const resamplePoints = ({
  points,
  targetCount,
  values,
}: {
  points: readonly (readonly [number, number])[];
  targetCount: number;
  values?: readonly number[];
}) => {
  if (targetCount <= 0) {
    return {
      points: [] as [number, number][],
    };
  }

  const sourcePoints = points.length ? points : ([[0, 0]] as const);
  const sourceValues = values?.length
    ? values
    : values
    ? Array(sourcePoints.length).fill(0.5)
    : null;

  if (sourcePoints.length === 1) {
    return {
      points: Array.from(
        { length: targetCount },
        () => [sourcePoints[0][0], sourcePoints[0][1]] as [number, number],
      ),
      values:
        sourceValues == null
          ? undefined
          : Array.from({ length: targetCount }, () => sourceValues[0] ?? 0.5),
    };
  }

  const cumulativeLengths = [0];
  for (let index = 1; index < sourcePoints.length; index++) {
    cumulativeLengths.push(
      cumulativeLengths[index - 1] +
        getPointDistance(sourcePoints[index - 1], sourcePoints[index]),
    );
  }

  const totalLength = cumulativeLengths[cumulativeLengths.length - 1];
  if (totalLength <= 0) {
    return {
      points: Array.from(
        { length: targetCount },
        () => [sourcePoints[0][0], sourcePoints[0][1]] as [number, number],
      ),
      values:
        sourceValues == null
          ? undefined
          : Array.from({ length: targetCount }, () => sourceValues[0] ?? 0.5),
    };
  }

  const sourceArcPositions = cumulativeLengths.map((distance) => {
    return totalLength <= 0 ? 0 : distance / totalLength;
  });
  const sampledPoints: [number, number][] = [];
  const sampledValues = sourceValues == null ? undefined : ([] as number[]);

  for (let index = 0; index < targetCount; index++) {
    const targetPosition = targetCount === 1 ? 0 : index / (targetCount - 1);
    let nearestSourceIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (
      let sourceIndex = 0;
      sourceIndex < sourceArcPositions.length;
      sourceIndex += 1
    ) {
      const distance = Math.abs(
        sourceArcPositions[sourceIndex] - targetPosition,
      );

      if (
        distance < nearestDistance ||
        (distance === nearestDistance && sourceIndex > nearestSourceIndex)
      ) {
        nearestSourceIndex = sourceIndex;
        nearestDistance = distance;
      }
    }

    const sourcePoint =
      sourcePoints[nearestSourceIndex] || sourcePoints[sourcePoints.length - 1];

    sampledPoints.push([sourcePoint[0], sourcePoint[1]]);

    if (sampledValues) {
      sampledValues.push(
        sourceValues?.[nearestSourceIndex] ?? sourceValues?.at(-1) ?? 0.5,
      );
    }
  }

  return {
    points: sampledPoints,
    values: sampledValues,
  };
};

const trimPointsToProgress = ({
  points,
  progress,
  values,
}: {
  points: readonly (readonly [number, number])[];
  progress: number;
  values?: readonly number[];
}) => {
  const clampedProgress = clampUnitProgress(progress);
  const sourcePoints = points.length ? points : ([[0, 0]] as const);
  const sourceValues = values?.length ? values : values ? [0.5] : undefined;
  const firstPoint = sourcePoints[0];
  const firstValue = sourceValues?.[0] ?? 0.5;

  if (clampedProgress >= 1) {
    return {
      points: sourcePoints.map(
        (point) => [point[0], point[1]] as [number, number],
      ),
      values: sourceValues ? [...sourceValues] : undefined,
    };
  }

  if (clampedProgress <= 0 || sourcePoints.length === 1) {
    return {
      points: [
        [firstPoint[0], firstPoint[1]] as [number, number],
        [firstPoint[0], firstPoint[1]] as [number, number],
      ],
      values: sourceValues ? [firstValue, firstValue] : undefined,
    };
  }

  const cumulativeLengths = [0];
  for (let index = 1; index < sourcePoints.length; index++) {
    cumulativeLengths.push(
      cumulativeLengths[index - 1] +
        getPointDistance(sourcePoints[index - 1], sourcePoints[index]),
    );
  }

  const totalLength = cumulativeLengths[cumulativeLengths.length - 1];
  if (totalLength <= 0) {
    return {
      points: [
        [firstPoint[0], firstPoint[1]] as [number, number],
        [firstPoint[0], firstPoint[1]] as [number, number],
      ],
      values: sourceValues ? [firstValue, firstValue] : undefined,
    };
  }

  const targetLength = totalLength * clampedProgress;
  const trimmedPoints: [number, number][] = [
    [firstPoint[0], firstPoint[1]] as [number, number],
  ];
  const trimmedValues = sourceValues == null ? undefined : [firstValue];

  for (let index = 1; index < sourcePoints.length; index++) {
    const point = sourcePoints[index];
    const distanceAtPoint = cumulativeLengths[index];

    if (distanceAtPoint < targetLength) {
      trimmedPoints.push([point[0], point[1]] as [number, number]);
      if (trimmedValues) {
        trimmedValues.push(sourceValues?.[index] ?? firstValue);
      }
      continue;
    }

    const previousPoint = sourcePoints[index - 1];
    const previousDistance = cumulativeLengths[index - 1];
    const segmentLength = distanceAtPoint - previousDistance;
    const segmentProgress =
      segmentLength <= 0
        ? 0
        : (targetLength - previousDistance) / segmentLength;

    trimmedPoints.push([
      lerp(previousPoint[0], point[0], segmentProgress),
      lerp(previousPoint[1], point[1], segmentProgress),
    ]);

    if (trimmedValues) {
      trimmedValues.push(
        lerp(
          sourceValues?.[index - 1] ?? firstValue,
          sourceValues?.[index] ?? firstValue,
          segmentProgress,
        ),
      );
    }
    break;
  }

  if (trimmedPoints.length === 1) {
    const duplicatedPoint: [number, number] = [
      trimmedPoints[0][0],
      trimmedPoints[0][1],
    ];

    trimmedPoints.push(duplicatedPoint);
    trimmedValues?.push(trimmedValues[0]);
  }

  return {
    points: trimmedPoints,
    values: trimmedValues,
  };
};

const normalizeLinearPreviewElement = (element: ExcalidrawLinearElement) => {
  const normalized =
    LinearElementEditor.getNormalizeElementPointsAndCoords(element);

  return {
    points: normalized.points as readonly (readonly [number, number])[],
    x: normalized.x,
    y: normalized.y,
  };
};

const applyLinearReveal = <T extends ExcalidrawLinearElement>(
  element: T,
  progress: number,
): T => {
  const trimmed = trimPointsToProgress({
    points: element.points,
    progress,
  });

  return {
    ...element,
    endArrowhead: progress >= 0.98 ? element.endArrowhead : null,
    points: trimmed.points as unknown as T["points"],
    startArrowhead: progress >= 0.98 ? element.startArrowhead : null,
  } as T;
};

const applyFreeDrawReveal = <T extends ExcalidrawFreeDrawElement>(
  element: T,
  progress: number,
): T => {
  const trimmed = trimPointsToProgress({
    points: element.points,
    progress,
    values: element.pressures,
  });

  return {
    ...element,
    points: trimmed.points as unknown as T["points"],
    pressures: (trimmed.values || [0.5, 0.5]) as T["pressures"],
  };
};

const isPrimitiveRevealShapeElement = (
  element: ExcalidrawElement,
): element is PrimitiveRevealShapeElement => {
  return (
    element.type === "rectangle" ||
    element.type === "diamond" ||
    element.type === "ellipse"
  );
};

const getPrimitiveShapeRevealOutlinePoints = (
  element: PrimitiveRevealShapeElement,
): readonly (readonly [number, number])[] => {
  switch (element.type) {
    case "rectangle":
      return [
        [0, 0],
        [element.width, 0],
        [element.width, element.height],
        [0, element.height],
        [0, 0],
      ] as const;
    case "diamond":
      return [
        [element.width / 2, 0],
        [element.width, element.height / 2],
        [element.width / 2, element.height],
        [0, element.height / 2],
        [element.width / 2, 0],
      ] as const;
    case "ellipse": {
      const centerX = element.width / 2;
      const centerY = element.height / 2;
      const radiusX = element.width / 2;
      const radiusY = element.height / 2;
      const points: [number, number][] = [];

      for (let index = 0; index <= ELLIPSE_REVEAL_SEGMENTS; index += 1) {
        const angle =
          -Math.PI / 2 + (Math.PI * 2 * index) / ELLIPSE_REVEAL_SEGMENTS;

        points.push([
          centerX + Math.cos(angle) * radiusX,
          centerY + Math.sin(angle) * radiusY,
        ]);
      }

      return points;
    }
  }
};

const applyPrimitiveShapeReveal = (
  element: PrimitiveRevealShapeElement,
  progress: number,
): ExcalidrawLineElement => {
  const revealPoints = getPrimitiveShapeRevealOutlinePoints(element);
  const trimmed = trimPointsToProgress({
    points: revealPoints,
    progress,
  });

  return {
    ...element,
    customData: {
      ...(element.customData || {}),
      [PRIMITIVE_REVEAL_PREVIEW_CUSTOM_DATA_KEY]: {
        progress,
        roughness: element.roughness,
        roundness: element.roundness,
        sourceType: element.type,
      },
    },
    endArrowhead: null,
    endBinding: null,
    points: trimmed.points as unknown as ExcalidrawLineElement["points"],
    polygon: false,
    roughness: 0,
    roundness: null,
    startArrowhead: null,
    startBinding: null,
    type: "line",
  } as ExcalidrawLineElement;
};

const applyShapeReveal = <T extends ExcalidrawElement>(
  element: T,
  progress: number,
): T => {
  const clampedProgress = Math.max(progress, 0.001);
  const nextWidth = Math.max(element.width * clampedProgress, 1);
  const nextHeight = Math.max(element.height * clampedProgress, 1);

  return {
    ...element,
    height: nextHeight,
    width: nextWidth,
    x: element.x + (element.width - nextWidth) / 2,
    y: element.y + (element.height - nextHeight) / 2,
  } as T;
};

const getRevealedTextForProgress = (text: string, progress: number) => {
  const characters = Array.from(text);
  const clampedProgress = clampUnitProgress(progress);

  if (!characters.length) {
    return text;
  }

  if (clampedProgress >= 1) {
    return text;
  }

  const revealUnits = getTextRevealUnits(text, "typewriter");
  const totalUnits = revealUnits.reduce((sum, unit) => sum + unit, 0);
  const targetUnits = clampedProgress * totalUnits;
  let cumulativeUnits = 0;
  let visibleCharacterCount = 1;

  for (let index = 0; index < revealUnits.length; index++) {
    cumulativeUnits += revealUnits[index];

    if (targetUnits + Number.EPSILON >= cumulativeUnits) {
      visibleCharacterCount = index + 1;
      continue;
    }

    break;
  }

  return characters.slice(0, visibleCharacterCount).join("");
};

const getHandwrittenTextPreviewForProgress = (
  text: string,
  progress: number,
) => {
  const characters = Array.from(text);
  const clampedProgress = clampUnitProgress(progress);

  if (!characters.length) {
    return {
      tailProgress: undefined,
      text,
    };
  }

  if (clampedProgress >= 1) {
    return {
      tailProgress: undefined,
      text,
    };
  }

  const revealUnits = getTextRevealUnits(text, "handwritten");
  const totalUnits = revealUnits.reduce((sum, unit) => sum + unit, 0);
  const targetUnits = clampedProgress * totalUnits;
  let cumulativeUnits = 0;
  const visibleCharacters: string[] = [];

  if (targetUnits <= Number.EPSILON) {
    return {
      tailProgress: undefined,
      text: "",
    };
  }

  for (let index = 0; index < revealUnits.length; index++) {
    const revealStart = cumulativeUnits;
    const revealEnd = cumulativeUnits + 1;

    if (targetUnits + Number.EPSILON < revealStart) {
      break;
    }

    if (targetUnits + Number.EPSILON < revealEnd) {
      visibleCharacters.push(characters[index]);
      return {
        tailProgress: Math.max(0, Math.min(1, targetUnits - revealStart)),
        text: visibleCharacters.join(""),
      };
    }

    visibleCharacters.push(characters[index]);
    cumulativeUnits += revealUnits[index];

    if (targetUnits + Number.EPSILON < cumulativeUnits) {
      return {
        tailProgress: undefined,
        text: visibleCharacters.join(""),
      };
    }
  }

  return {
    tailProgress: undefined,
    text: visibleCharacters.join(""),
  };
};

const applyTypewriterReveal = <T extends ExcalidrawTextElement>(
  element: T,
  progress: number,
): T => {
  const nextText = getRevealedTextForProgress(element.text, progress);

  if (nextText === element.text) {
    return element;
  }

  return {
    ...element,
    originalText: nextText,
    text: nextText,
  };
};

const applyHandwrittenReveal = <T extends ExcalidrawTextElement>(
  element: T,
  progress: number,
): { element: T; opacityScale: number } => {
  const clampedProgress = clampUnitProgress(progress);
  const preview = getHandwrittenTextPreviewForProgress(
    element.text,
    clampedProgress,
  );
  const previewElement =
    preview.text === element.text
      ? element
      : {
          ...element,
          originalText: preview.text,
          text: preview.text,
        };

  return {
    element: withHandwrittenTextOutlinePreview(previewElement, {
      progress: clampedProgress,
      tailProgress: preview.tailProgress,
    }),
    opacityScale: 1,
  };
};

const applyRevealToPreviewElement = <T extends ExcalidrawElement>(
  element: T,
  progress: number,
): { element: ExcalidrawElement; opacityScale: number } => {
  const clampedProgress = clampUnitProgress(progress);
  const revealStyle = getResolvedElementRevealStyle(element);

  if (clampedProgress >= 1) {
    return { element, opacityScale: 1 };
  }

  if (!revealStyle) {
    return {
      element,
      opacityScale: element.type === "text" ? clampedProgress : 1,
    };
  }

  if (element.type === "text") {
    if (revealStyle === "typewriter") {
      return {
        element: applyTypewriterReveal(element, clampedProgress),
        opacityScale: 1,
      };
    }

    if (revealStyle === "handwritten") {
      return applyHandwrittenReveal(element, clampedProgress);
    }

    return { element, opacityScale: clampedProgress };
  }

  if (isLinearElement(element)) {
    return {
      element: applyLinearReveal(element, clampedProgress) as T,
      opacityScale: 1,
    };
  }

  if (isFreeDrawElement(element)) {
    return {
      element: applyFreeDrawReveal(element, clampedProgress),
      opacityScale: 1,
    };
  }

  if (isPrimitiveRevealShapeElement(element)) {
    return {
      element: applyPrimitiveShapeReveal(element, clampedProgress),
      opacityScale: 1,
    };
  }

  return {
    element: applyShapeReveal(element, clampedProgress),
    opacityScale: 1,
  };
};

const positionBoundTextInPreviewContainer = ({
  container,
  containerProgress,
  previewElementsById,
  textElement,
}: {
  container: ExcalidrawElement;
  containerProgress: number;
  previewElementsById: ReadonlyMap<ExcalidrawElement["id"], ExcalidrawElement>;
  textElement: ExcalidrawTextElementWithContainer;
}) => {
  const previewContainerBase =
    previewElementsById.get(container.id) || container;
  const previewContainer = isPrimitiveRevealShapeElement(previewContainerBase)
    ? previewContainerBase
    : applyRevealToPreviewElement(previewContainerBase, containerProgress)
        .element;
  const previewElementsWithContainer = new Map(previewElementsById);

  previewElementsWithContainer.set(container.id, previewContainer);

  return {
    ...textElement,
    ...computeBoundTextPosition(
      previewContainer,
      textElement,
      previewElementsWithContainer,
    ),
  };
};

const setPreviewVisibility = <T extends ExcalidrawElement>(
  element: T,
  visible: boolean,
  opacityScale: number = 1,
): T => {
  if (element.isDeleted) {
    return element;
  }

  if (!visible) {
    return {
      ...element,
      isDeleted: true,
    } as T;
  }

  return {
    ...element,
    isDeleted: false,
    opacity: clampOpacity((element.opacity ?? 100) * opacityScale),
  } as T;
};

const interpolateGenericPreviewElement = <T extends ExcalidrawElement>(
  startElement: T,
  endElement: T,
  progress: number,
): T => {
  return {
    ...startElement,
    angle: lerp(startElement.angle, endElement.angle, progress),
    height: lerp(startElement.height, endElement.height, progress),
    isDeleted: false,
    opacity: clampOpacity(
      lerp(startElement.opacity ?? 100, endElement.opacity ?? 100, progress),
    ),
    width: lerp(startElement.width, endElement.width, progress),
    x: lerp(startElement.x, endElement.x, progress),
    y: lerp(startElement.y, endElement.y, progress),
  } as T;
};

const interpolateLinearPreviewElement = <T extends ExcalidrawLinearElement>(
  startElement: T,
  endElement: T,
  progress: number,
): T => {
  const normalizedStart = normalizeLinearPreviewElement(startElement);
  const normalizedEnd = normalizeLinearPreviewElement(endElement);
  const pointCount = Math.max(
    normalizedStart.points.length,
    normalizedEnd.points.length,
    2,
  );
  const startPoints =
    normalizedStart.points.length === normalizedEnd.points.length
      ? normalizedStart.points.map(
          (point) => [point[0], point[1]] as [number, number],
        )
      : resamplePoints({
          points: normalizedStart.points,
          targetCount: pointCount,
        }).points;
  const endPoints =
    normalizedStart.points.length === normalizedEnd.points.length
      ? normalizedEnd.points.map(
          (point) => [point[0], point[1]] as [number, number],
        )
      : resamplePoints({
          points: normalizedEnd.points,
          targetCount: pointCount,
        }).points;
  const previewElement: T = {
    ...startElement,
    angle: lerp(startElement.angle, endElement.angle, progress),
    height: lerp(startElement.height, endElement.height, progress),
    isDeleted: false,
    opacity: clampOpacity(
      lerp(startElement.opacity ?? 100, endElement.opacity ?? 100, progress),
    ),
    points: startPoints.map((point, index) => {
      const nextPoint =
        endPoints[index] || endPoints[endPoints.length - 1] || point;
      return [
        lerp(point[0], nextPoint[0], progress),
        lerp(point[1], nextPoint[1], progress),
      ] as [number, number];
    }),
    startBinding: null,
    endBinding: null,
    width: lerp(startElement.width, endElement.width, progress),
    x: lerp(normalizedStart.x, normalizedEnd.x, progress),
    y: lerp(normalizedStart.y, normalizedEnd.y, progress),
  };

  if (previewElement.type === "arrow") {
    const previewArrow = previewElement as T & {
      elbowed?: boolean;
      endIsSpecial?: boolean | null;
      fixedSegments?: readonly unknown[] | null;
      startIsSpecial?: boolean | null;
    };
    const startArrow = startElement as typeof previewArrow;
    const endArrow = endElement as typeof previewArrow;

    previewArrow.elbowed = Boolean(startArrow.elbowed && endArrow.elbowed);

    if ("fixedSegments" in previewArrow) {
      previewArrow.fixedSegments = null;
    }
    if ("startIsSpecial" in previewArrow) {
      previewArrow.startIsSpecial = null;
    }
    if ("endIsSpecial" in previewArrow) {
      previewArrow.endIsSpecial = null;
    }
  }

  return previewElement;
};

const interpolateFreeDrawPreviewElement = <T extends ExcalidrawFreeDrawElement>(
  startElement: T,
  endElement: T,
  progress: number,
): T => {
  const pointCount = Math.max(
    startElement.points.length,
    endElement.points.length,
    1,
  );
  const hasMatchingTopology =
    startElement.points.length === endElement.points.length;
  const startSamples = hasMatchingTopology
    ? {
        points: startElement.points.map(
          (point) => [point[0], point[1]] as [number, number],
        ),
        values:
          startElement.pressures.length === startElement.points.length
            ? [...startElement.pressures]
            : Array.from({ length: pointCount }, (_, index) => {
                return (
                  startElement.pressures[index] ??
                  startElement.pressures.at(-1) ??
                  0.5
                );
              }),
      }
    : resamplePoints({
        points: startElement.points,
        targetCount: pointCount,
        values: startElement.pressures,
      });
  const endSamples = hasMatchingTopology
    ? {
        points: endElement.points.map(
          (point) => [point[0], point[1]] as [number, number],
        ),
        values:
          endElement.pressures.length === endElement.points.length
            ? [...endElement.pressures]
            : Array.from({ length: pointCount }, (_, index) => {
                return (
                  endElement.pressures[index] ??
                  endElement.pressures.at(-1) ??
                  0.5
                );
              }),
      }
    : resamplePoints({
        points: endElement.points,
        targetCount: pointCount,
        values: endElement.pressures,
      });

  return {
    ...startElement,
    angle: lerp(startElement.angle, endElement.angle, progress),
    height: lerp(startElement.height, endElement.height, progress),
    isDeleted: false,
    opacity: clampOpacity(
      lerp(startElement.opacity ?? 100, endElement.opacity ?? 100, progress),
    ),
    points: startSamples.points.map((point, index) => {
      const nextPoint =
        endSamples.points[index] ||
        endSamples.points[endSamples.points.length - 1] ||
        point;
      return [
        lerp(point[0], nextPoint[0], progress),
        lerp(point[1], nextPoint[1], progress),
      ] as [number, number];
    }),
    pressures: startSamples.values!.map((pressure, index) => {
      const nextPressure =
        endSamples.values?.[index] ??
        endSamples.values?.[endSamples.values.length - 1] ??
        pressure;
      return lerp(pressure, nextPressure, progress);
    }),
    simulatePressure:
      startElement.simulatePressure || endElement.simulatePressure,
    width: lerp(startElement.width, endElement.width, progress),
    x: lerp(startElement.x, endElement.x, progress),
    y: lerp(startElement.y, endElement.y, progress),
  } as T;
};

const interpolatePreviewElement = <T extends ExcalidrawElement>(
  startElement: T,
  endElement: T,
  kind: PreviewInterpolationKind,
  progress: number,
): T => {
  switch (kind) {
    case "generic":
      return interpolateGenericPreviewElement(
        startElement,
        endElement,
        progress,
      );
    case "linear":
      return interpolateLinearPreviewElement(
        startElement as T & ExcalidrawLinearElement,
        endElement as T & ExcalidrawLinearElement,
        progress,
      );
    case "freedraw":
      return interpolateFreeDrawPreviewElement(
        startElement as T & ExcalidrawFreeDrawElement,
        endElement as T & ExcalidrawFreeDrawElement,
        progress,
      );
  }
};

const getPlaybackPreviewIssueMessage = (
  currentFrame: ExcalidrawFrameElement,
  nextFrame: ExcalidrawFrameElement,
  linkId: string,
  currentGroup: readonly ExcalidrawElement[],
  nextGroup: readonly ExcalidrawElement[],
) => {
  if (currentGroup.length > 1 || nextGroup.length > 1) {
    const duplicateFrames: string[] = [];

    if (currentGroup.length > 1) {
      duplicateFrames.push(
        `${getFrameLabel(currentFrame)} (${currentGroup.length})`,
      );
    }

    if (nextGroup.length > 1) {
      duplicateFrames.push(`${getFrameLabel(nextFrame)} (${nextGroup.length})`);
    }

    return `Link ${linkId.slice(
      0,
      8,
    )} appears multiple times in ${duplicateFrames.join(
      " and ",
    )}. Preview falls back for that chain.`;
  }

  if (
    currentGroup.length === 1 &&
    nextGroup.length === 1 &&
    currentGroup[0].type !== nextGroup[0].type
  ) {
    return `${getFrameLabel(currentFrame)} -> ${getFrameLabel(
      nextFrame,
    )} changes linked type from ${currentGroup[0].type} to ${
      nextGroup[0].type
    }.`;
  }

  if (currentGroup.length === 1 && nextGroup.length === 1) {
    return `${getFrameLabel(currentFrame)} -> ${getFrameLabel(
      nextFrame,
    )} cannot interpolate linked ${currentGroup[0].type} elements yet.`;
  }

  return "Preview falls back for unmatched elements in this transition.";
};

const buildPlaybackPreviewPlan = ({
  currentFrame,
  currentFrameChildren,
  nextFrame,
  nextFrameChildren,
}: {
  currentFrame: ExcalidrawFrameElement;
  currentFrameChildren: readonly ExcalidrawElement[];
  nextFrame: ExcalidrawFrameElement;
  nextFrameChildren: readonly ExcalidrawElement[];
}): PlaybackPreviewPlan => {
  const currentGroups = buildLinkedElementGroups(currentFrameChildren);
  const nextGroups = buildLinkedElementGroups(nextFrameChildren);
  const allLinkIds = new Set([...currentGroups.keys(), ...nextGroups.keys()]);
  const pairsByCurrentElementId = new Map<
    ExcalidrawElement["id"],
    PreviewInterpolationPair
  >();
  const pairedNextElementIds = new Set<ExcalidrawElement["id"]>();
  const issues: PlaybackPreviewIssue[] = [];

  for (const linkId of allLinkIds) {
    const currentGroup = currentGroups.get(linkId) || [];
    const nextGroup = nextGroups.get(linkId) || [];

    if (currentGroup.length === 1 && nextGroup.length === 1) {
      const kind = getPreviewInterpolationKind(currentGroup[0], nextGroup[0]);

      if (kind) {
        pairsByCurrentElementId.set(currentGroup[0].id, {
          currentElement: currentGroup[0],
          kind,
          nextElement: nextGroup[0],
        });
        pairedNextElementIds.add(nextGroup[0].id);
        continue;
      }
    }

    if (
      currentGroup.length > 1 ||
      nextGroup.length > 1 ||
      (currentGroup.length === 1 && nextGroup.length === 1)
    ) {
      issues.push({
        id: `preview-${linkId}`,
        message: getPlaybackPreviewIssueMessage(
          currentFrame,
          nextFrame,
          linkId,
          currentGroup,
          nextGroup,
        ),
      });
    }
  }

  return {
    diagnostics: {
      animatedPairCount: pairsByCurrentElementId.size,
      fallbackCurrentCount:
        currentFrameChildren.length - pairsByCurrentElementId.size,
      fallbackNextCount: nextFrameChildren.length - pairedNextElementIds.size,
      issues,
    },
    pairedNextElementIds,
    pairsByCurrentElementId,
  };
};

const buildPlaybackPreviewScene = ({
  cursor,
  elements,
  orderedFrames,
  stage,
}: {
  cursor: PlaybackCursor;
  elements: readonly ExcalidrawElement[];
  orderedFrames: readonly ExcalidrawFrameElement[];
  stage: PreviewStageFrame;
}) => {
  const currentFrameId = cursor.frame.id;
  const currentFrameChildren = getFrameChildren(elements, currentFrameId);
  const currentFrameChildrenById = new Map(
    currentFrameChildren.map((element) => [element.id, element] as const),
  );
  const previousFrame = orderedFrames[cursor.frameIndex - 1] || null;
  const upcomingFrame = orderedFrames[cursor.frameIndex + 1] || null;
  const currentFrameRevealPlan = buildFrameRevealPlan(
    currentFrameChildren,
    previousFrame
      ? buildAdjacentTransitionControlledElementIds({
          sourceFrameChildren: getFrameChildren(elements, previousFrame.id),
          targetFrameChildren: currentFrameChildren,
        })
      : upcomingFrame
      ? buildAdjacentTransitionControlledElementIds({
          sourceFrameChildren: getFrameChildren(elements, upcomingFrame.id),
          targetFrameChildren: currentFrameChildren,
        })
      : undefined,
  );
  const currentFrameRevealDelayMs = currentFrameRevealPlan.revealableElementIds
    .size
    ? getFrameRevealDelayMs(cursor.frame)
    : 0;
  const currentFrameRevealMs =
    currentFrameRevealDelayMs + currentFrameRevealPlan.revealDurationMs;
  const playbackLinkedRenderSeedByElementId =
    buildPlaybackLinkedRenderSeedByElementId({
      elements,
      orderedFrames,
    });
  const toPreviewElement = <T extends ExcalidrawElement>(
    element: T,
    frame: ExcalidrawFrameElement,
  ) => {
    const previewElement = rebaseElementToPreviewStage(
      applyPlaybackLinkedRenderSeed(
        element,
        playbackLinkedRenderSeedByElementId,
      ),
      frame,
      stage,
    );

    return previewElement.type === "text"
      ? withHandwrittenTextOutlinePreview(previewElement)
      : previewElement;
  };
  const currentFramePreviewElementsById = new Map(
    currentFrameChildren.map((element) => [
      element.id,
      toPreviewElement(element, cursor.frame),
    ]),
  );

  if (cursor.phase === "reveal") {
    return elements.map((element) => {
      if (element.isDeleted) {
        return element;
      }

      if (isFrameLikeElement(element)) {
        if (element.type !== "frame") {
          return setPreviewVisibility(element, false);
        }

        return element.id === currentFrameId
          ? setPreviewVisibility(
              rebaseFrameElementToPreviewStage(element, stage),
              true,
            )
          : setPreviewVisibility(element, false);
      }

      if (!element.frameId) {
        return element;
      }

      if (element.frameId !== currentFrameId) {
        return setPreviewVisibility(element, false);
      }

      const revealState = getPreviewRevealStateForElement({
        elapsedMs: cursor.progress * currentFrameRevealMs,
        element,
        frameChildrenById: currentFrameChildrenById,
        revealDelayMs: currentFrameRevealDelayMs,
        revealPlan: currentFrameRevealPlan,
      });
      const container = getBoundTextRevealContainer(
        element,
        currentFrameChildrenById,
      );
      let rebasedElement =
        currentFramePreviewElementsById.get(element.id) ||
        toPreviewElement(element, cursor.frame);

      if (container && element.type === "text") {
        rebasedElement = positionBoundTextInPreviewContainer({
          container,
          containerProgress: revealState.containerProgress,
          previewElementsById: currentFramePreviewElementsById,
          textElement: rebasedElement as ExcalidrawTextElementWithContainer,
        });
      }

      const revealedElement = applyRevealToPreviewElement(
        rebasedElement,
        revealState.progress,
      );

      return setPreviewVisibility(
        revealedElement.element,
        revealState.visible,
        revealedElement.opacityScale,
      );
    });
  }

  if (cursor.phase === "hold" || !cursor.nextFrame) {
    return elements.map((element) => {
      if (element.isDeleted) {
        return element;
      }

      if (isFrameLikeElement(element)) {
        if (element.type !== "frame") {
          return setPreviewVisibility(element, false);
        }

        return element.id === currentFrameId
          ? setPreviewVisibility(
              rebaseFrameElementToPreviewStage(element, stage),
              true,
            )
          : setPreviewVisibility(element, false);
      }

      if (!element.frameId) {
        return element;
      }

      if (element.frameId !== currentFrameId) {
        return setPreviewVisibility(element, false);
      }

      return setPreviewVisibility(
        toPreviewElement(element, cursor.frame),
        true,
      );
    });
  }

  const nextFrame = cursor.nextFrame;
  if (!nextFrame) {
    return elements;
  }

  const nextFrameId = nextFrame.id;
  const nextFrameChildren = getFrameChildren(elements, nextFrameId);
  const nextFrameChildrenById = new Map(
    nextFrameChildren.map((element) => [element.id, element] as const),
  );
  const nextFrameRevealPlan = buildFrameRevealPlan(
    nextFrameChildren,
    buildAdjacentTransitionControlledElementIds({
      sourceFrameChildren: currentFrameChildren,
      targetFrameChildren: nextFrameChildren,
    }),
  );
  const previewPlan = buildPlaybackPreviewPlan({
    currentFrame: cursor.frame,
    currentFrameChildren,
    nextFrame,
    nextFrameChildren,
  });

  const showNextOnCut = cursor.progress >= 0.5;

  return elements.map((element) => {
    if (element.isDeleted) {
      return element;
    }

    if (isFrameLikeElement(element)) {
      if (element.type !== "frame") {
        return setPreviewVisibility(element, false);
      }

      if (element.id !== currentFrameId && element.id !== nextFrameId) {
        return setPreviewVisibility(element, false);
      }

      return setPreviewVisibility(
        rebaseFrameElementToPreviewStage(element, stage),
        showNextOnCut
          ? element.id === nextFrameId
          : element.id === currentFrameId,
      );
    }

    if (!element.frameId) {
      return element;
    }

    if (element.frameId !== currentFrameId && element.frameId !== nextFrameId) {
      return setPreviewVisibility(element, false);
    }

    if (element.frameId === currentFrameId) {
      const interpolatedPair = previewPlan.pairsByCurrentElementId.get(
        element.id,
      );
      if (interpolatedPair) {
        return interpolatePreviewElement(
          toPreviewElement(element, cursor.frame),
          toPreviewElement(interpolatedPair.nextElement, nextFrame),
          interpolatedPair.kind,
          cursor.easedProgress,
        );
      }

      return setPreviewVisibility(
        toPreviewElement(element, cursor.frame),
        cursor.transition.fallback === "fade" ? true : !showNextOnCut,
        cursor.transition.fallback === "fade" ? 1 - cursor.easedProgress : 1,
      );
    }

    if (previewPlan.pairedNextElementIds.has(element.id)) {
      return setPreviewVisibility(toPreviewElement(element, nextFrame), false);
    }

    if (
      shouldHideElementUntilReveal({
        element,
        frameChildrenById: nextFrameChildrenById,
        revealPlan: nextFrameRevealPlan,
      })
    ) {
      return setPreviewVisibility(toPreviewElement(element, nextFrame), false);
    }

    return setPreviewVisibility(
      toPreviewElement(element, nextFrame),
      cursor.transition.fallback === "fade" ? true : showNextOnCut,
      cursor.transition.fallback === "fade" ? cursor.easedProgress : 1,
    );
  });
};

export const applyFrameDuplicateLinks = (payload: FrameDuplicatePayload) => {
  const previousElementsById = new Map(
    payload.prevElements.map((element) => [element.id, element] as const),
  );
  const linkAssignments = new Map<ExcalidrawElement["id"], string>();

  for (const [
    originalId,
    duplicateId,
  ] of payload.origIdToDuplicateId.entries()) {
    const originalElement = previousElementsById.get(originalId);

    if (!originalElement || !isLinkableElement(originalElement)) {
      continue;
    }

    const linkId = getElementLinkId(originalElement) || createLinkId();
    linkAssignments.set(originalId, linkId);
    linkAssignments.set(duplicateId, linkId);
  }

  if (!linkAssignments.size) {
    return [...payload.nextElements];
  }

  return payload.nextElements.map((element) => {
    const linkId = linkAssignments.get(element.id);
    if (!linkId) {
      return element;
    }

    return setElementLinkId(element, linkId);
  });
};

const collectRepairIssues = (
  elements: readonly ExcalidrawElement[],
  orderedFrames: readonly ExcalidrawFrameElement[],
) => {
  const frameIndexById = getOrderedFrameIndexById(orderedFrames);
  const framesById = getFrameById(orderedFrames);
  const groups = new Map<string, ExcalidrawElement[]>();

  for (const element of elements) {
    const linkId = getElementLinkId(element);

    if (!linkId || !isLinkableElement(element) || !element.frameId) {
      continue;
    }

    const group = groups.get(linkId) || [];
    group.push(element);
    groups.set(linkId, group);
  }

  const issues: RepairIssue[] = [];

  for (const [linkId, groupElements] of groups.entries()) {
    const elementsByFrameId = new Map<string, ExcalidrawElement[]>();

    for (const element of groupElements) {
      if (!element.frameId) {
        continue;
      }

      const frameElements = elementsByFrameId.get(element.frameId) || [];
      frameElements.push(element);
      elementsByFrameId.set(element.frameId, frameElements);
    }

    for (const [frameId, frameElements] of elementsByFrameId.entries()) {
      if (frameElements.length < 2) {
        continue;
      }

      issues.push({
        elementIds: frameElements.map((element) => element.id),
        id: `duplicate-${linkId}-${frameId}`,
        message: `${getFrameLabel(framesById.get(frameId))} contains ${
          frameElements.length
        } elements with link ${linkId.slice(0, 8)}.`,
      });
    }

    const orderedGroupElements = groupElements
      .filter(
        (element) => element.frameId && frameIndexById.has(element.frameId),
      )
      .slice()
      .sort((left, right) => {
        return (
          frameIndexById.get(left.frameId!)! -
          frameIndexById.get(right.frameId!)!
        );
      });

    for (let index = 0; index < orderedGroupElements.length - 1; index++) {
      const currentElement = orderedGroupElements[index];
      const nextElement = orderedGroupElements[index + 1];
      const currentFrameIndex = frameIndexById.get(currentElement.frameId!);
      const nextFrameIndex = frameIndexById.get(nextElement.frameId!);

      if (currentFrameIndex == null || nextFrameIndex == null) {
        continue;
      }

      if (nextFrameIndex - currentFrameIndex > 1) {
        issues.push({
          elementIds: [currentElement.id, nextElement.id],
          id: `gap-${linkId}-${currentElement.id}-${nextElement.id}`,
          message: `Link ${linkId.slice(0, 8)} skips from ${getFrameLabel(
            framesById.get(currentElement.frameId!),
          )} to ${getFrameLabel(framesById.get(nextElement.frameId!))}.`,
        });
      }

      if (
        nextFrameIndex - currentFrameIndex === 1 &&
        currentElement.type !== nextElement.type
      ) {
        issues.push({
          elementIds: [currentElement.id, nextElement.id],
          id: `unsupported-${linkId}-${currentElement.id}-${nextElement.id}`,
          message: `Adjacent linked elements change type from ${currentElement.type} to ${nextElement.type}.`,
        });
      }
    }
  }

  return issues;
};

const FramesPresenterOverlay = ({
  canStepBackward,
  canStepForward,
  currentFrame,
  currentFrameIndex,
  isTransitioning,
  onCloseRequest,
  onFullscreenRequest,
  onStepBackward,
  onStepForward,
  totalFrames,
}: {
  canStepBackward: boolean;
  canStepForward: boolean;
  currentFrame: ExcalidrawFrameElement | null;
  currentFrameIndex: number;
  isTransitioning: boolean;
  onCloseRequest: () => void;
  onFullscreenRequest?: (payload: PresenterFullscreenRequestPayload) => void;
  onStepBackward: () => void;
  onStepForward: () => void;
  totalFrames: number;
}) => {
  const portalContainer = useCreatePortalContainer({
    className: "frames-presenter-container",
  });
  const presenterRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const usesControlsHotspot = useMemo(() => {
    return shouldUsePresenterControlsHotspot();
  }, []);
  const [areControlsVisible, setAreControlsVisible] = useState(() => {
    return !usesControlsHotspot;
  });
  const keepOverlayFocus = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    overlayRef.current?.focus();
  };
  const revealControls = useCallback(() => {
    if (!usesControlsHotspot) {
      return;
    }

    setAreControlsVisible(true);
  }, [usesControlsHotspot]);
  const hideControls = useCallback(() => {
    if (!usesControlsHotspot) {
      return;
    }

    setAreControlsVisible(false);
  }, [usesControlsHotspot]);
  const handleSurfacePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (
        !usesControlsHotspot ||
        (event.pointerType && event.pointerType !== "mouse")
      ) {
        return;
      }

      setAreControlsVisible(
        shouldShowPresenterControlsForPointer(event.clientX, event.clientY),
      );
    },
    [usesControlsHotspot],
  );
  const handleSurfacePointerLeave = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!usesControlsHotspot) {
        return;
      }

      const nextTarget = event.relatedTarget as Node | null;
      if (controlsRef.current?.contains(nextTarget)) {
        return;
      }

      setAreControlsVisible(false);
    },
    [usesControlsHotspot],
  );
  const handleControlsBlurCapture = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (!usesControlsHotspot) {
        return;
      }

      const nextTarget = event.relatedTarget as Node | null;
      if (controlsRef.current?.contains(nextTarget)) {
        return;
      }

      hideControls();
    },
    [hideControls, usesControlsHotspot],
  );
  const handleFullscreenButtonClick = useCallback(() => {
    if (!currentFrame || !onFullscreenRequest) {
      return;
    }

    onFullscreenRequest({
      currentFrame,
      currentFrameIndex,
      presenterElement: presenterRef.current,
      totalFrames,
    });
  }, [currentFrame, currentFrameIndex, onFullscreenRequest, totalFrames]);

  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === KEYS.ESCAPE) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        onCloseRequest();
        return;
      }

      if (
        event.key === KEYS.ARROW_LEFT ||
        event.key === KEYS.PAGE_UP ||
        event.key === KEYS.BACKSPACE
      ) {
        if (!canStepBackward || isTransitioning) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        onStepBackward();
        return;
      }

      if (
        event.key === KEYS.ARROW_RIGHT ||
        event.key === KEYS.PAGE_DOWN ||
        event.key === KEYS.ENTER ||
        event.key === " "
      ) {
        if (!canStepForward || isTransitioning) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        onStepForward();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [
    canStepBackward,
    canStepForward,
    isTransitioning,
    onCloseRequest,
    onStepBackward,
    onStepForward,
  ]);

  if (!portalContainer || !currentFrame) {
    return null;
  }

  return createPortal(
    <div
      ref={presenterRef}
      className="frames-presenter"
      data-testid="frames-presenter"
      role="dialog"
      aria-modal="true"
      aria-labelledby="frames-presenter-title"
    >
      <div className="frames-presenter__scrim" />
      <div
        ref={overlayRef}
        tabIndex={0}
        className="frames-presenter__surface"
        data-testid="frames-presenter-surface"
        onPointerLeave={handleSurfacePointerLeave}
        onPointerMove={handleSurfacePointerMove}
      >
        <h3 id="frames-presenter-title" className="visually-hidden">
          Presenting {getFrameLabel(currentFrame)}. Frame{" "}
          {currentFrameIndex + 1} of {totalFrames}.
        </h3>

        <div
          ref={controlsRef}
          className={`frames-presenter__controls${
            areControlsVisible ? "" : " frames-presenter__controls--hidden"
          }`}
          data-testid="frames-presenter-controls"
          data-controls-visible={areControlsVisible ? "true" : "false"}
          onBlurCapture={handleControlsBlurCapture}
          onFocusCapture={revealControls}
        >
          {onFullscreenRequest ? (
            <button
              type="button"
              className="frames-presenter__control frames-presenter__control--fullscreen"
              data-testid="frames-presenter-fullscreen"
              aria-label="Fullscreen"
              title="Fullscreen"
              onPointerDown={keepOverlayFocus}
              onClick={handleFullscreenButtonClick}
            >
              <span
                className="frames-presenter__control-icon"
                aria-hidden="true"
              >
                {fullscreenIcon}
              </span>
            </button>
          ) : null}
          <button
            type="button"
            className="frames-presenter__control frames-presenter__control--close"
            data-testid="frames-presenter-close"
            aria-label="Exit presenter"
            title="Exit presenter (Escape)"
            onPointerDown={keepOverlayFocus}
            onClick={onCloseRequest}
          >
            <span className="frames-presenter__control-icon" aria-hidden="true">
              {CloseIcon}
            </span>
          </button>
        </div>

        <div
          className="frames-presenter__stage"
          data-testid="frames-presenter-stage"
        >
          <button
            type="button"
            className="frames-presenter__stage-action frames-presenter__stage-action--previous"
            data-testid="frames-presenter-stage-previous"
            disabled={!canStepBackward || isTransitioning}
            aria-label="Previous frame"
            title="Previous frame"
            onPointerDown={keepOverlayFocus}
            onClick={onStepBackward}
          />
          <button
            type="button"
            className="frames-presenter__stage-action frames-presenter__stage-action--next"
            data-testid="frames-presenter-stage-next"
            disabled={!canStepForward || isTransitioning}
            aria-label="Next frame"
            title="Next frame"
            onPointerDown={keepOverlayFocus}
            onClick={onStepForward}
          />
        </div>
      </div>
    </div>,
    portalContainer,
  );
};

const FramesPresentationMode = ({
  context,
  controller,
  options,
}: {
  context: FramesNavigatorModeRenderContext;
  controller: PresentationController;
  options: FrameAnimationModeOptions;
}) => {
  const app = useApp() as AppClassProperties & {
    updateFrameRendering: ExcalidrawApp["updateFrameRendering"];
  };
  const setAppState = useExcalidrawSetAppState();
  const previewActiveRef = useRef(false);
  const previewStageFrameRef = useRef<PreviewStageFrame | null>(null);
  const presenterViewportRef = useRef<PresenterViewportSnapshot | null>(null);
  // App-level presenter setup updates can rerender before local presenter state commits.
  const presenterLifecycleRef = useRef<"idle" | "entering" | "active">("idle");
  const previewSourceSceneRef = useRef<PlaybackSourceScene>({
    elements: context.elements,
    orderedFrames: context.orderedFrames,
  });
  const lastPreviewKeyRef = useRef<string | null>(null);
  const commitSceneElementsRef = useRef(context.commitSceneElements);
  const suppressSceneChangeRef = useRef(options.suppressSceneChange);
  const playbackMsRef = useRef(0);
  const presenterPlaybackLimitRef = useRef<number | null>(null);
  const playingRef = useRef(false);

  commitSceneElementsRef.current = context.commitSceneElements;
  suppressSceneChangeRef.current = options.suppressSceneChange;

  const [playbackMs, setPlaybackMs] = useState(() => {
    const initialFrameIndex = getConfiguredFrameIndex(
      context.orderedFrames,
      context.appState.selectedElementIds,
    );

    return getFrameStartMs(
      buildPlaybackTimeline(context.elements, context.orderedFrames),
      initialFrameIndex,
    );
  });
  const [isPlaying, setIsPlaying] = useState(false);
  const [manualTransition, setManualTransition] =
    useState<AdjacentPlaybackTransition | null>(null);
  const [manualTransitionMs, setManualTransitionMs] = useState(0);
  const [isPresenting, setIsPresenting] = useState(false);
  const [isAutomatedPresentation, setIsAutomatedPresentation] = useState(false);

  playbackMsRef.current = playbackMs;

  playingRef.current = isPresenting && isPlaying && !manualTransition;

  if (!previewActiveRef.current) {
    previewSourceSceneRef.current = {
      elements: context.elements,
      orderedFrames: context.orderedFrames,
    };
  }

  const sourceScene = previewActiveRef.current
    ? previewSourceSceneRef.current
    : {
        elements: context.elements,
        orderedFrames: context.orderedFrames,
      };
  const sourceElements = sourceScene.elements;
  const orderedFrames = sourceScene.orderedFrames;
  const timeline = useMemo(() => {
    return buildPlaybackTimeline(sourceElements, orderedFrames);
  }, [orderedFrames, sourceElements]);
  const totalPlaybackMs = timeline.at(-1)?.endMs ?? 0;
  const configuredFrameIndex = getConfiguredFrameIndex(
    orderedFrames,
    context.appState.selectedElementIds,
  );
  const timelineCursor = useMemo(() => {
    return getPlaybackCursor(timeline, playbackMs);
  }, [timeline, playbackMs]);
  const manualCursor = useMemo(() => {
    return manualTransition
      ? buildAdjacentPlaybackCursor(manualTransition, manualTransitionMs)
      : null;
  }, [manualTransition, manualTransitionMs]);
  const activeCursor = manualCursor || (isPresenting ? timelineCursor : null);
  const visibleFrameIndex = orderedFrames.length
    ? isPresenting
      ? getVisibleFrameIndex(activeCursor)
      : configuredFrameIndex
    : -1;
  const currentFrameIndex = visibleFrameIndex;
  const currentFrame =
    currentFrameIndex >= 0 ? orderedFrames[currentFrameIndex] : null;
  const transitionOwnerFrame = isPresenting
    ? activeCursor?.transitionOwnerFrame ?? currentFrame
    : currentFrame;
  const transitionOwnerFrameIndex = isPresenting
    ? activeCursor?.transitionOwnerFrameIndex ??
      (currentFrameIndex >= 0 ? currentFrameIndex : null)
    : currentFrameIndex >= 0
    ? currentFrameIndex
    : null;
  const nextFrame =
    transitionOwnerFrameIndex == null
      ? null
      : orderedFrames[transitionOwnerFrameIndex + 1] || null;
  const previousTransition =
    visibleFrameIndex >= 0
      ? getAdjacentPlaybackTransition({
          direction: "backward",
          orderedFrames,
          sourceFrameIndex: visibleFrameIndex,
        })
      : null;
  const nextTransition =
    visibleFrameIndex >= 0
      ? getAdjacentPlaybackTransition({
          direction: "forward",
          orderedFrames,
          sourceFrameIndex: visibleFrameIndex,
        })
      : null;
  const isManualTransitionActive = !!manualTransition;
  const presenterFrameIndex = visibleFrameIndex >= 0 ? visibleFrameIndex : 0;
  const presenterFrame = orderedFrames[presenterFrameIndex] || null;

  const replacePreviewScene = useCallback(
    (nextElements: readonly ExcalidrawElement[]) => {
      suppressSceneChangeRef.current?.();
      app.suppressNextSceneChangeEffects();
      app.scene.replaceAllElements(nextElements);
    },
    [app],
  );

  const commitPreviewScene = useCallback(
    (cursor: PlaybackCursor, stage: PreviewStageFrame) => {
      const previewElements = buildPlaybackPreviewScene({
        cursor,
        elements: sourceElements,
        orderedFrames,
        stage,
      });

      replacePreviewScene(previewElements);
      previewActiveRef.current = true;
      lastPreviewKeyRef.current = getPlaybackPreviewKey(cursor);
    },
    [orderedFrames, replacePreviewScene, sourceElements],
  );

  const restorePreviewScene = useCallback(() => {
    if (!previewActiveRef.current) {
      return;
    }

    replacePreviewScene(previewSourceSceneRef.current.elements);
    previewActiveRef.current = false;
    previewStageFrameRef.current = null;
    lastPreviewKeyRef.current = null;
  }, [replacePreviewScene]);

  const startPresenterFramePlayback = useCallback(
    (frameIndex: number, automated: boolean) => {
      const startMs = getResolvedFramePlaybackMs({
        timeline,
        frameIndex,
        settled: false,
      });
      const stopMs = automated
        ? totalPlaybackMs
        : getFrameRevealEndMs(timeline, frameIndex);

      presenterPlaybackLimitRef.current = stopMs;
      setPlaybackMs(startMs);
      setIsPlaying(stopMs > startMs);
    },
    [timeline, totalPlaybackMs],
  );

  useEffect(() => {
    if (!isPresenting) {
      return;
    }

    if (!orderedFrames.length) {
      setIsPresenting(false);
    }
  }, [isPresenting, orderedFrames.length]);

  useEffect(() => {
    setPlaybackMs((currentPlaybackMs) => {
      return Math.max(0, Math.min(currentPlaybackMs, totalPlaybackMs));
    });
  }, [totalPlaybackMs]);

  useEffect(() => {
    if (
      !isPresenting ||
      !isPlaying ||
      totalPlaybackMs <= 0 ||
      manualTransition
    ) {
      return;
    }

    playingRef.current = true;
    const playbackLimitMs = Math.min(
      presenterPlaybackLimitRef.current ?? totalPlaybackMs,
      totalPlaybackMs,
    );

    if (playbackLimitMs <= playbackMsRef.current) {
      playingRef.current = false;
      queueMicrotask(() => setIsPlaying(false));
      return;
    }

    let animationFrameId = 0;
    let previousFrameTime = performance.now();

    const step = (now: number) => {
      const deltaMs = now - previousFrameTime;
      previousFrameTime = now;

      setPlaybackMs((currentPlaybackMs) => {
        const nextPlaybackMs = Math.min(
          currentPlaybackMs + deltaMs,
          playbackLimitMs,
          totalPlaybackMs,
        );

        if (
          nextPlaybackMs >= playbackLimitMs ||
          nextPlaybackMs >= totalPlaybackMs
        ) {
          playingRef.current = false;
          queueMicrotask(() => setIsPlaying(false));
        }

        return nextPlaybackMs;
      });

      if (playingRef.current) {
        animationFrameId = requestAnimationFrame(step);
      }
    };

    animationFrameId = requestAnimationFrame(step);

    return () => {
      playingRef.current = false;
      cancelAnimationFrame(animationFrameId);
    };
  }, [isPlaying, isPresenting, manualTransition, totalPlaybackMs]);

  useEffect(() => {
    if (!manualTransition) {
      return;
    }

    const durationMs = manualTransition.transition.durationMs;

    if (durationMs <= 0) {
      setManualTransition(null);
      setManualTransitionMs(0);

      if (isPresenting) {
        startPresenterFramePlayback(
          manualTransition.targetFrameIndex,
          isAutomatedPresentation,
        );
      } else {
        setPlaybackMs(
          getFrameStartMs(timeline, manualTransition.targetFrameIndex),
        );
      }

      return;
    }

    const startedAt = performance.now();
    let animationFrameId = 0;

    const step = (now: number) => {
      const nextPlaybackMs = Math.min(now - startedAt, durationMs);
      setManualTransitionMs(nextPlaybackMs);

      if (nextPlaybackMs >= durationMs) {
        setManualTransition(null);
        setManualTransitionMs(0);

        if (isPresenting) {
          startPresenterFramePlayback(
            manualTransition.targetFrameIndex,
            isAutomatedPresentation,
          );
        } else {
          setPlaybackMs(
            getFrameStartMs(timeline, manualTransition.targetFrameIndex),
          );
        }

        return;
      }

      animationFrameId = requestAnimationFrame(step);
    };

    animationFrameId = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [
    isAutomatedPresentation,
    isPresenting,
    manualTransition,
    startPresenterFramePlayback,
    timeline,
  ]);

  useEffect(() => {
    if (isPresenting) {
      presenterLifecycleRef.current = "active";
      return;
    }

    presenterPlaybackLimitRef.current = null;

    if (presenterLifecycleRef.current !== "active") {
      return;
    }

    const presenterViewport = presenterViewportRef.current;
    presenterViewportRef.current = null;
    presenterLifecycleRef.current = "idle";

    if (!presenterViewport) {
      return;
    }

    restorePresenterViewportSnapshot(app, presenterViewport);
  }, [app, isPresenting]);

  useEffect(() => {
    setPresenterContainerClass(app, isPresenting);

    return () => {
      setPresenterContainerClass(app, false);
    };
  }, [app, isPresenting]);

  useEffect(() => {
    return () => {
      if (
        presenterLifecycleRef.current === "active" &&
        presenterViewportRef.current
      ) {
        restorePresenterViewportSnapshot(app, presenterViewportRef.current);
        presenterViewportRef.current = null;
      }

      presenterLifecycleRef.current = "idle";

      restorePreviewScene();
    };
  }, [app, restorePreviewScene]);

  useEffect(() => {
    if (!isPresenting) {
      restorePreviewScene();
      return;
    }

    if (!activeCursor) {
      restorePreviewScene();
      return;
    }

    if (!previewStageFrameRef.current) {
      previewStageFrameRef.current = getPreviewStageFrame(
        getPreviewStageAnchorFrame(activeCursor),
      );
    }

    const previewKey = getPlaybackPreviewKey(activeCursor);

    if (lastPreviewKeyRef.current === previewKey) {
      return;
    }
    commitPreviewScene(activeCursor, previewStageFrameRef.current);
  }, [activeCursor, commitPreviewScene, isPresenting, restorePreviewScene]);

  useEffect(() => {
    if (!isPresenting || !presenterViewportRef.current) {
      return;
    }

    const shouldClearSelection =
      Object.keys(presenterViewportRef.current.selectedElementIds).length > 0 ||
      Object.keys(presenterViewportRef.current.selectedGroupIds).length > 0;

    if (!shouldClearSelection) {
      return;
    }

    const animationFrameId = requestAnimationFrame(() => {
      setAppState({
        selectedElementIds: {},
        selectedGroupIds: {},
      });
    });

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [isPresenting, setAppState]);

  const updateFrameInSourceScene = (
    frameId: ExcalidrawFrameElement["id"],
    updater: (frame: ExcalidrawFrameElement) => ExcalidrawFrameElement,
  ) => {
    let didChange = false;
    let updatedFrame: ExcalidrawFrameElement | null = null;

    const nextElements = sourceElements.map((element) => {
      if (!isNormalFrameElement(element) || element.id !== frameId) {
        return element;
      }

      updatedFrame = updater(element);
      didChange = updatedFrame !== element;

      return updatedFrame;
    });

    if (!didChange || !updatedFrame) {
      return;
    }

    const nextOrderedFrames = orderedFrames.map((frame) => {
      return frame.id === updatedFrame!.id ? updatedFrame! : frame;
    });

    previewSourceSceneRef.current = {
      elements: nextElements,
      orderedFrames: nextOrderedFrames,
    };
    lastPreviewKeyRef.current = null;
    context.commitSceneElements(nextElements);
  };

  const handleAnimateToAdjacentFrame = (direction: PlaybackDirection) => {
    setIsPlaying(false);

    const transition = getAdjacentPlaybackTransition({
      direction,
      orderedFrames,
      sourceFrameIndex: visibleFrameIndex >= 0 ? visibleFrameIndex : 0,
    });

    if (!transition) {
      return;
    }

    if (transition.transition.durationMs <= 0) {
      setManualTransition(null);
      setManualTransitionMs(0);

      if (isPresenting) {
        startPresenterFramePlayback(
          transition.targetFrameIndex,
          isAutomatedPresentation,
        );
      } else {
        setPlaybackMs(
          getResolvedFramePlaybackMs({
            timeline,
            frameIndex: transition.targetFrameIndex,
            settled: false,
          }),
        );
      }

      return;
    }

    setManualTransition(transition);
    setManualTransitionMs(0);
  };

  const handleStartPresenting = useCallback(
    ({ automated, frameIndex }: PresentationStartRequest) => {
      const startFrameIndex =
        frameIndex >= 0 ? frameIndex : configuredFrameIndex;

      if (
        presenterLifecycleRef.current !== "idle" ||
        !orderedFrames.length ||
        startFrameIndex < 0
      ) {
        return;
      }

      const startFrame = orderedFrames[startFrameIndex];

      if (!startFrame) {
        return;
      }

      const presenterStartMs = automated
        ? getResolvedFramePlaybackMs({
            timeline,
            frameIndex: startFrameIndex,
            settled: false,
          })
        : getResolvedFramePlaybackMs({
            timeline,
            frameIndex: startFrameIndex,
            settled: true,
          });
      const previewStageFrame =
        previewStageFrameRef.current || getPreviewStageFrame(startFrame);
      const presenterStageTarget = newFrameElement({
        x: previewStageFrame.x,
        y: previewStageFrame.y,
        width: previewStageFrame.width,
        height: previewStageFrame.height,
      });

      setIsPlaying(false);
      setManualTransition(null);
      setManualTransitionMs(0);
      setIsAutomatedPresentation(automated);
      presenterLifecycleRef.current = "entering";
      presenterViewportRef.current = capturePresenterViewportSnapshot(app);
      presenterPlaybackLimitRef.current = automated ? totalPlaybackMs : null;
      app.updateFrameRendering({
        enabled: true,
        clip: true,
        name: false,
        outline: false,
      });

      setPlaybackMs(presenterStartMs);
      setIsPlaying(
        automated &&
          presenterPlaybackLimitRef.current != null &&
          presenterPlaybackLimitRef.current > presenterStartMs,
      );
      app.scrollToContent(presenterStageTarget, {
        fitToViewport: true,
        animate: false,
        canvasOffsets: {
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
        },
      });
      setIsPresenting(true);
    },
    [app, configuredFrameIndex, timeline, totalPlaybackMs, orderedFrames],
  );

  const handleStopPresenting = () => {
    setIsPlaying(false);
    presenterPlaybackLimitRef.current = null;
    setPlaybackMs(getFrameRevealEndMs(timeline, presenterFrameIndex));
    setManualTransition(null);
    setManualTransitionMs(0);
    setIsPresenting(false);
    setIsAutomatedPresentation(false);
    context.setActiveMode("frames");
  };

  useEffect(() => {
    const maybeStartPresenting = () => {
      const request = controller.consumePresentRequest();

      if (!request) {
        return;
      }

      handleStartPresenting(request);
    };

    maybeStartPresenting();

    return controller.subscribe(() => {
      maybeStartPresenting();
    });
  }, [controller, handleStartPresenting]);

  const currentFrameHoldMs = currentFrame ? getFrameHoldMs(currentFrame) : 0;
  const currentFrameRevealDelayMs = currentFrame
    ? getFrameRevealDelayMs(currentFrame)
    : 0;
  const currentFrameTransition = transitionOwnerFrame
    ? getFrameTransition(transitionOwnerFrame)
    : null;

  return (
    <div className="frames-mode-panel frames-mode-panel--presentation">
      <section className="frames-mode-panel__section">
        <div className="frames-mode-panel__section-header">
          <h3 className="frames-mode-panel__title">Presentation</h3>
          <span className="frames-mode-panel__pill">
            {isPresenting
              ? isAutomatedPresentation
                ? "Automated"
                : "Manual"
              : "Configure"}
          </span>
        </div>
        <p className="frames-mode-panel__copy">
          {isPresenting
            ? isAutomatedPresentation
              ? "Presentation is running with authored reveal, hold, and transition timing."
              : "Presentation advances only when you click or use keyboard navigation. Each step still animates."
            : "Edit the selected frame timing here. Use the checkbox next to Present to switch between manual and automated presentation."}
        </p>
        {!orderedFrames.length ? (
          <div className="frames-mode-panel__empty">
            Create at least one frame to configure a presentation.
          </div>
        ) : null}
      </section>

      <section className="frames-mode-panel__section">
        <div className="frames-mode-panel__section-header">
          <h3 className="frames-mode-panel__title">Current frame</h3>
        </div>
        {currentFrame ? (
          <div className="frames-mode-panel__field-grid">
            <div className="frames-mode-panel__card">
              <div className="frames-mode-panel__card-title">
                {getFrameLabel(currentFrame)}
              </div>
              <div className="frames-mode-panel__card-meta">
                Frame {currentFrameIndex + 1} of {orderedFrames.length}
              </div>
            </div>
            <label className="frames-mode-panel__field">
              <span className="frames-mode-panel__field-label">
                Reveal delay (ms)
              </span>
              <input
                type="number"
                min={0}
                max={MAX_ANIMATION_MS}
                step={50}
                className="frames-mode-panel__input"
                disabled={isManualTransitionActive}
                value={currentFrameRevealDelayMs}
                onChange={(event) => {
                  updateFrameInSourceScene(currentFrame.id, (frame) => {
                    return setFrameRevealDelayMs(
                      frame,
                      event.currentTarget.valueAsNumber,
                    );
                  });
                }}
              />
            </label>
            <label className="frames-mode-panel__field">
              <span className="frames-mode-panel__field-label">
                Hold duration (ms)
              </span>
              <input
                type="number"
                min={0}
                max={MAX_ANIMATION_MS}
                step={50}
                className="frames-mode-panel__input"
                disabled={isManualTransitionActive}
                value={currentFrameHoldMs}
                onChange={(event) => {
                  updateFrameInSourceScene(currentFrame.id, (frame) => {
                    return setFrameHoldMs(
                      frame,
                      event.currentTarget.valueAsNumber,
                    );
                  });
                }}
              />
            </label>
          </div>
        ) : (
          <div className="frames-mode-panel__empty">
            No frame is active yet.
          </div>
        )}
      </section>

      <section className="frames-mode-panel__section">
        <div className="frames-mode-panel__section-header">
          <h3 className="frames-mode-panel__title">Transition</h3>
        </div>
        {transitionOwnerFrame && nextFrame && currentFrameTransition ? (
          <div className="frames-mode-panel__field-grid">
            <div className="frames-mode-panel__card">
              <div className="frames-mode-panel__card-title">
                {getFrameLabel(transitionOwnerFrame)}
                {" -> "}
                {getFrameLabel(nextFrame)}
              </div>
              <div className="frames-mode-panel__card-meta">
                {isPresenting && activeCursor?.phase === "transition"
                  ? `${
                      activeCursor.direction === "backward"
                        ? "Reverse preview"
                        : "Transition"
                    } ${(activeCursor.progress * 100).toFixed(0)}%`
                  : "Next outgoing transition"}
              </div>
            </div>
            <label className="frames-mode-panel__field">
              <span className="frames-mode-panel__field-label">
                Duration (ms)
              </span>
              <input
                type="number"
                min={0}
                max={MAX_ANIMATION_MS}
                step={50}
                className="frames-mode-panel__input"
                disabled={isManualTransitionActive}
                value={currentFrameTransition.durationMs}
                onChange={(event) => {
                  updateFrameInSourceScene(transitionOwnerFrame.id, (frame) => {
                    return setFrameTransition(frame, {
                      durationMs: event.currentTarget.valueAsNumber,
                    });
                  });
                }}
              />
            </label>
            <label className="frames-mode-panel__field">
              <span className="frames-mode-panel__field-label">Easing</span>
              <select
                className="frames-mode-panel__input"
                disabled={isManualTransitionActive}
                value={currentFrameTransition.easing}
                onChange={(event) => {
                  updateFrameInSourceScene(transitionOwnerFrame.id, (frame) => {
                    return setFrameTransition(frame, {
                      easing: event.currentTarget
                        .value as FrameTransitionEasing,
                    });
                  });
                }}
              >
                {TRANSITION_EASINGS.map((easing) => {
                  return (
                    <option key={easing} value={easing}>
                      {TRANSITION_EASING_LABELS[easing]}
                    </option>
                  );
                })}
              </select>
            </label>
            <label className="frames-mode-panel__field">
              <span className="frames-mode-panel__field-label">
                Unsupported / unlinked
              </span>
              <select
                className="frames-mode-panel__input"
                disabled={isManualTransitionActive}
                value={currentFrameTransition.fallback}
                onChange={(event) => {
                  updateFrameInSourceScene(transitionOwnerFrame.id, (frame) => {
                    return setFrameTransition(frame, {
                      fallback: event.currentTarget
                        .value as TransitionFallbackPolicy,
                    });
                  });
                }}
              >
                {TRANSITION_FALLBACKS.map((fallback) => {
                  return (
                    <option key={fallback} value={fallback}>
                      {TRANSITION_FALLBACK_LABELS[fallback]}
                    </option>
                  );
                })}
              </select>
            </label>
          </div>
        ) : (
          <div className="frames-mode-panel__empty">
            {transitionOwnerFrame
              ? `${getFrameLabel(
                  transitionOwnerFrame,
                )} is the last frame, so there is no outgoing transition.`
              : "No transition is active yet."}
          </div>
        )}
      </section>

      {isPresenting ? (
        <FramesPresenterOverlay
          canStepBackward={!!previousTransition}
          canStepForward={!!nextTransition}
          currentFrame={presenterFrame}
          currentFrameIndex={presenterFrameIndex}
          isTransitioning={isManualTransitionActive}
          onCloseRequest={handleStopPresenting}
          onFullscreenRequest={options.onPresenterFullscreenRequest}
          onStepBackward={() => handleAnimateToAdjacentFrame("backward")}
          onStepForward={() => handleAnimateToAdjacentFrame("forward")}
          totalFrames={orderedFrames.length}
        />
      ) : null}
    </div>
  );
};

const FramesRepairMode = ({
  context,
}: {
  context: FramesNavigatorModeRenderContext;
}) => {
  const framesById = getFrameById(context.orderedFrames);
  const frameIndexById = getOrderedFrameIndexById(context.orderedFrames);
  const linkableSelectedElements = context.elements.filter((element) => {
    return (
      context.appState.selectedElementIds[element.id] &&
      isLinkableElement(element)
    );
  });
  const selectedPair =
    linkableSelectedElements.length === 2
      ? ([linkableSelectedElements[0], linkableSelectedElements[1]] as const)
      : null;
  const selectedPairLinkIds = selectedPair
    ? selectedPair.map((element) => getElementLinkId(element))
    : [];

  let selectionSummary =
    "Select exactly two elements from different frames to link them.";
  let canLinkSelectedPair = false;

  if (linkableSelectedElements.length === 1) {
    selectionSummary =
      "Select one more element in another frame to link the pair.";
  } else if (linkableSelectedElements.length > 2) {
    selectionSummary = "Select only two elements to repair a link.";
  } else if (selectedPair) {
    const [firstElement, secondElement] = selectedPair;

    if (!firstElement.frameId || !secondElement.frameId) {
      selectionSummary = "Both selected elements must belong to frames.";
    } else if (firstElement.frameId === secondElement.frameId) {
      selectionSummary = "Selected elements must be in different frames.";
    } else if (
      selectedPairLinkIds[0] &&
      selectedPairLinkIds[1] &&
      selectedPairLinkIds[0] !== selectedPairLinkIds[1]
    ) {
      selectionSummary =
        "The selected elements already belong to different link chains. Unlink one before merging.";
    } else {
      selectionSummary = "Ready to link the selected pair.";
      canLinkSelectedPair = true;
    }
  }

  const selectedPairDetails =
    selectedPair || linkableSelectedElements.slice(0, 2);
  const selectedSingleElement =
    linkableSelectedElements.length === 1 ? linkableSelectedElements[0] : null;
  const selectedSingleLinkId =
    selectedSingleElement && getElementLinkId(selectedSingleElement);
  const selectedSingleFrameIndex =
    selectedSingleElement?.frameId != null
      ? frameIndexById.get(selectedSingleElement.frameId) ?? null
      : null;
  const linkedElements =
    selectedSingleLinkId != null
      ? context.elements.filter((element) => {
          return (
            isLinkableElement(element) &&
            element.id !== selectedSingleElement?.id &&
            getElementLinkId(element) === selectedSingleLinkId
          );
        })
      : [];
  const previousLinkedElement =
    selectedSingleFrameIndex == null
      ? null
      : linkedElements.find((element) => {
          return (
            element.frameId != null &&
            frameIndexById.get(element.frameId) === selectedSingleFrameIndex - 1
          );
        }) || null;
  const nextLinkedElement =
    selectedSingleFrameIndex == null
      ? null
      : linkedElements.find((element) => {
          return (
            element.frameId != null &&
            frameIndexById.get(element.frameId) === selectedSingleFrameIndex + 1
          );
        }) || null;
  const repairIssues = collectRepairIssues(
    context.elements,
    context.orderedFrames,
  );

  const handleLinkSelectedPair = () => {
    if (!selectedPair || !canLinkSelectedPair) {
      return;
    }

    const [firstElement, secondElement] = selectedPair;
    const nextLinkId =
      getElementLinkId(firstElement) ||
      getElementLinkId(secondElement) ||
      createLinkId();
    const selectedIds = new Set([firstElement.id, secondElement.id]);
    const nextElements = context.elements.map((element) => {
      return selectedIds.has(element.id)
        ? setElementLinkId(element, nextLinkId)
        : element;
    });

    context.commitSceneElements(nextElements);
    context.notify("Linked selected pair.");
  };

  const handleUnlinkSelected = () => {
    const selectedIds = new Set(
      linkableSelectedElements.map((element) => element.id),
    );

    if (!selectedIds.size) {
      return;
    }

    const nextElements = context.elements.map((element) => {
      return selectedIds.has(element.id)
        ? clearElementLinkId(element)
        : element;
    });

    context.commitSceneElements(nextElements);
    context.notify("Removed link metadata from the selected elements.");
  };

  const handleFocusLinkedElement = (element: ExcalidrawElement | null) => {
    if (!element) {
      return;
    }

    context.selectAndFocusElementIds([element.id], {
      fitToViewport: false,
    });
  };

  const handleHighlightBrokenChains = () => {
    const issueElementIds = [
      ...new Set(repairIssues.flatMap((issue) => issue.elementIds)),
    ];

    if (!issueElementIds.length) {
      context.notify("No broken chains found.");
      return;
    }

    context.selectAndFocusElementIds(issueElementIds);
    context.notify(
      `Highlighted ${issueElementIds.length} elements with repair issues.`,
    );
  };

  return (
    <div className="frames-mode-panel frames-mode-panel--repair">
      <section className="frames-mode-panel__section">
        <div className="frames-mode-panel__section-header">
          <h3 className="frames-mode-panel__title">Repair links</h3>
        </div>
        <p className="frames-mode-panel__copy">{selectionSummary}</p>
        <div className="frames-mode-panel__cards">
          {selectedPairDetails.length ? (
            selectedPairDetails.map((element) => {
              const frame = element.frameId
                ? framesById.get(element.frameId)
                : undefined;
              const linkId = getElementLinkId(element);

              return (
                <div key={element.id} className="frames-mode-panel__card">
                  <div className="frames-mode-panel__card-title">
                    {getFrameLabel(frame)}
                  </div>
                  <div className="frames-mode-panel__card-meta">
                    Type: {element.type}
                  </div>
                  <div className="frames-mode-panel__card-meta">
                    Link: {linkId ? linkId.slice(0, 8) : "none"}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="frames-mode-panel__empty">
              No linkable elements selected.
            </div>
          )}
        </div>
        <div className="frames-mode-panel__actions">
          <button
            type="button"
            className="frames-mode-panel__button frames-mode-panel__button--primary"
            disabled={!canLinkSelectedPair}
            onClick={handleLinkSelectedPair}
          >
            Link selected pair
          </button>
          <button
            type="button"
            className="frames-mode-panel__button"
            disabled={!linkableSelectedElements.length}
            onClick={handleUnlinkSelected}
          >
            Unlink selected
          </button>
        </div>
      </section>

      <section className="frames-mode-panel__section">
        <div className="frames-mode-panel__section-header">
          <h3 className="frames-mode-panel__title">Counterparts</h3>
        </div>
        <p className="frames-mode-panel__copy">
          Select one linked element to jump to its previous or next frame
          counterpart.
        </p>
        <div className="frames-mode-panel__actions">
          <button
            type="button"
            className="frames-mode-panel__button"
            disabled={!previousLinkedElement}
            onClick={() => handleFocusLinkedElement(previousLinkedElement)}
          >
            Show previous linked
          </button>
          <button
            type="button"
            className="frames-mode-panel__button"
            disabled={!nextLinkedElement}
            onClick={() => handleFocusLinkedElement(nextLinkedElement)}
          >
            Show next linked
          </button>
        </div>
      </section>

      <section className="frames-mode-panel__section">
        <div className="frames-mode-panel__section-header">
          <h3 className="frames-mode-panel__title">Broken chains</h3>
          <button
            type="button"
            className="frames-mode-panel__button"
            disabled={!repairIssues.length}
            onClick={handleHighlightBrokenChains}
          >
            Highlight broken chains
          </button>
        </div>
        {repairIssues.length ? (
          <ul className="frames-mode-panel__issues">
            {repairIssues.map((issue) => {
              return (
                <li key={issue.id} className="frames-mode-panel__issue">
                  <span>{issue.message}</span>
                  <button
                    type="button"
                    className="frames-mode-panel__issue-action"
                    onClick={() =>
                      context.selectAndFocusElementIds(issue.elementIds, {
                        fitToViewport: false,
                      })
                    }
                  >
                    Focus
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="frames-mode-panel__empty">
            No broken chains detected.
          </div>
        )}
      </section>
    </div>
  );
};

const FramesPresentationPresentAction = ({
  context,
  controller,
}: {
  context: FramesNavigatorModeRenderContext;
  controller: PresentationController;
}) => {
  const [automated, setAutomated] = useState(false);

  return (
    <div className="frames-window__mode-action-group">
      <button
        type="button"
        className="frames-window__mode-action"
        data-testid="frames-presentation-present"
        disabled={!context.orderedFrames.length}
        onClick={() => {
          controller.requestPresent({
            automated,
            frameIndex: getConfiguredFrameIndex(
              context.orderedFrames,
              context.appState.selectedElementIds,
            ),
          });
          context.setActiveMode("presentation");
        }}
      >
        <span className="frames-window__mode-action-icon">
          {presentationIcon}
        </span>
        <span>Present</span>
      </button>
      <label
        className="frames-window__mode-toggle"
        title="Automatically advance using reveal, hold, and transition timing"
      >
        <input
          type="checkbox"
          className="frames-window__mode-checkbox"
          data-testid="frames-presentation-automation"
          checked={automated}
          disabled={!context.orderedFrames.length}
          onChange={(event) => setAutomated(event.currentTarget.checked)}
        />
        <span>Auto</span>
      </label>
    </div>
  );
};

export const createFrameAnimationModes = (
  options: FrameAnimationModeOptions = {},
): readonly FramesNavigatorModeDefinition[] => {
  const presentationController = createPresentationController();

  return [
    {
      id: "repair",
      label: "Repair",
      render: (context) => <FramesRepairMode context={context} />,
    },
    {
      id: "presentation",
      label: "Presentation",
      renderWindowAction: (context) => (
        <FramesPresentationPresentAction
          context={context}
          controller={presentationController}
        />
      ),
      render: (context) => (
        <FramesPresentationMode
          context={context}
          controller={presentationController}
          options={options}
        />
      ),
    },
  ];
};

export const FRAME_ANIMATION_MODES = createFrameAnimationModes();
