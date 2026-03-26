import { arrayToMap } from "@excalidraw/common";

import {
  duplicateElements,
  newElementWith,
  newFrameElement,
  syncInvalidIndices,
  syncMovedIndices,
} from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
} from "@excalidraw/element/types";

import type { AppState } from "./types";

export type FrameDropPosition = "before" | "after";

export const FRAME_NAVIGATOR_SPACING = 30;

export const FRAME_ASPECT_RATIO_PRESETS = [
  {
    id: "16:9",
    label: "16:9",
    width: 16,
    height: 9,
  },
  {
    id: "4:3",
    label: "4:3",
    width: 4,
    height: 3,
  },
  {
    id: "1:1",
    label: "1:1",
    width: 1,
    height: 1,
  },
] as const;

export type FrameAspectRatioPresetId =
  (typeof FRAME_ASPECT_RATIO_PRESETS)[number]["id"];

type FrameSelectionState = {
  selectedElementIds: {
    [key: string]: true;
  };
  selectedGroupIds: {};
};

type FrameCanvasOffsets = Partial<{
  top: number;
  right: number;
  bottom: number;
  left: number;
}>;

type CanonicalFrameNameAppState = Pick<
  AppState,
  | "editingFrame"
  | "editingTextElement"
  | "multiElement"
  | "newElement"
  | "resizingElement"
  | "selectedElementsAreBeingDragged"
  | "selectionElement"
>;

type FrameFocusApp = {
  getEditorUIOffsets: () => FrameCanvasOffsets;
  scrollToContent: (
    frame: ExcalidrawFrameElement,
    options: {
      fitToViewport?: boolean;
      animate?: boolean;
      canvasOffsets?: FrameCanvasOffsets;
    },
  ) => void;
};

const CANONICAL_FRAME_NAME = /^Frame_(\d+)$/;

const compareFramesByCanvasPosition = (
  left: ExcalidrawFrameElement,
  right: ExcalidrawFrameElement,
) => {
  return left.y - right.y || left.x - right.x || left.id.localeCompare(right.id);
};

export const isNormalFrameElement = (
  element: ExcalidrawElement,
): element is ExcalidrawFrameElement => {
  return element.type === "frame" && !element.isDeleted;
};

export const getCanonicalFrameName = (index: number) => {
  return `Frame_${index}`;
};

export const parseCanonicalFrameIndex = (name: string | null | undefined) => {
  if (!name) {
    return null;
  }

  const match = name.match(CANONICAL_FRAME_NAME);
  if (!match) {
    return null;
  }

  const index = Number(match[1]);
  return Number.isInteger(index) && index > 0 ? index : null;
};

export const getOrderedNormalFrames = (
  elements: readonly ExcalidrawElement[],
): ExcalidrawFrameElement[] => {
  const normalFrames = elements
    .filter(isNormalFrameElement)
    .slice()
    .sort(compareFramesByCanvasPosition);

  const canonicalFramesByIndex = new Map<number, ExcalidrawFrameElement>();

  for (const frame of normalFrames) {
    const frameIndex = parseCanonicalFrameIndex(frame.name);

    if (!frameIndex || canonicalFramesByIndex.has(frameIndex)) {
      continue;
    }

    canonicalFramesByIndex.set(frameIndex, frame);
  }

  const canonicalFrames = [...canonicalFramesByIndex.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, frame]) => frame);

  const canonicalFrameIds = new Set(canonicalFrames.map((frame) => frame.id));

  const overflowFrames = normalFrames.filter(
    (frame) => !canonicalFrameIds.has(frame.id),
  );

  return [...canonicalFrames, ...overflowFrames];
};

export const getMasterNormalFrame = (
  elements: readonly ExcalidrawElement[],
) => {
  return getOrderedNormalFrames(elements)[0] || null;
};

export const isMasterNormalFrameId = (
  elements: readonly ExcalidrawElement[],
  frameId: ExcalidrawElement["id"],
) => {
  return getMasterNormalFrame(elements)?.id === frameId;
};

export const getFrameHeightForAspectRatio = (
  width: number,
  presetId: FrameAspectRatioPresetId,
) => {
  const preset = FRAME_ASPECT_RATIO_PRESETS.find(
    (candidate) => candidate.id === presetId,
  );

  if (!preset) {
    return width;
  }

  return Math.max(1, Math.round(((width * preset.height) / preset.width) * 100) / 100);
};

const getFrameGridSlot = (
  frame: ExcalidrawFrameElement,
  masterFrame: ExcalidrawFrameElement,
) => {
  const strideX = Math.max(masterFrame.width + FRAME_NAVIGATOR_SPACING, 1);
  const strideY = Math.max(masterFrame.height + FRAME_NAVIGATOR_SPACING, 1);

  return {
    column: Math.round((frame.x - masterFrame.x) / strideX),
    row: Math.round((frame.y - masterFrame.y) / strideY),
  };
};

export const syncNormalFramesToMasterSize = <T extends ExcalidrawElement>({
  elements,
  masterFrameId,
  referenceElements,
}: {
  elements: readonly T[];
  masterFrameId?: ExcalidrawElement["id"];
  referenceElements?: readonly ExcalidrawElement[];
}) => {
  const referenceSceneElements = referenceElements || elements;
  const referenceOrderedFrames = getOrderedNormalFrames(referenceSceneElements);
  const referenceMasterFrame =
    referenceOrderedFrames.find((frame) => frame.id === masterFrameId) ||
    referenceOrderedFrames[0];

  if (!referenceMasterFrame) {
    return elements;
  }

  const currentElementsById = new Map(
    elements.map((element) => [element.id, element] as const),
  );
  const currentMasterFrame = currentElementsById.get(referenceMasterFrame.id);

  if (!currentMasterFrame || !isNormalFrameElement(currentMasterFrame)) {
    return elements;
  }

  const nextFrameBoundsById = new Map<
    ExcalidrawElement["id"],
    {
      deltaX: number;
      deltaY: number;
      height: number;
      width: number;
      x: number;
      y: number;
    }
  >();

  for (const referenceFrame of referenceOrderedFrames) {
    const currentFrame = currentElementsById.get(referenceFrame.id);

    if (!currentFrame || !isNormalFrameElement(currentFrame)) {
      continue;
    }

    const slot = getFrameGridSlot(referenceFrame, referenceMasterFrame);
    const targetX =
      currentMasterFrame.x +
      slot.column * (currentMasterFrame.width + FRAME_NAVIGATOR_SPACING);
    const targetY =
      currentMasterFrame.y +
      slot.row * (currentMasterFrame.height + FRAME_NAVIGATOR_SPACING);

    nextFrameBoundsById.set(currentFrame.id, {
      deltaX: targetX - currentFrame.x,
      deltaY: targetY - currentFrame.y,
      height: currentMasterFrame.height,
      width: currentMasterFrame.width,
      x: targetX,
      y: targetY,
    });
  }

  let didChange = false;

  const nextElements = elements.map((element) => {
    if (isNormalFrameElement(element)) {
      const nextFrameBounds = nextFrameBoundsById.get(element.id);

      if (!nextFrameBounds) {
        return element;
      }

      if (
        element.x === nextFrameBounds.x &&
        element.y === nextFrameBounds.y &&
        element.width === nextFrameBounds.width &&
        element.height === nextFrameBounds.height
      ) {
        return element;
      }

      didChange = true;
      return newElementWith(element as ExcalidrawFrameElement, {
        height: nextFrameBounds.height,
        width: nextFrameBounds.width,
        x: nextFrameBounds.x,
        y: nextFrameBounds.y,
      }) as T;
    }

    if (!element.frameId) {
      return element;
    }

    const nextFrameBounds = nextFrameBoundsById.get(element.frameId);
    if (
      !nextFrameBounds ||
      (nextFrameBounds.deltaX === 0 && nextFrameBounds.deltaY === 0)
    ) {
      return element;
    }

    didChange = true;
    return newElementWith(element as ExcalidrawElement, {
      x: element.x + nextFrameBounds.deltaX,
      y: element.y + nextFrameBounds.deltaY,
    }) as T;
  });

  return didChange ? nextElements : elements;
};

export const reorderFrameIds = (
  orderedFrameIds: readonly ExcalidrawElement["id"][],
  draggedFrameId: ExcalidrawElement["id"],
  targetFrameId: ExcalidrawElement["id"],
  position: FrameDropPosition,
) => {
  if (draggedFrameId === targetFrameId) {
    return [...orderedFrameIds];
  }

  const withoutDraggedFrame = orderedFrameIds.filter(
    (frameId) => frameId !== draggedFrameId,
  );
  const targetIndex = withoutDraggedFrame.indexOf(targetFrameId);

  if (targetIndex < 0) {
    return [...orderedFrameIds];
  }

  const insertionIndex = position === "after" ? targetIndex + 1 : targetIndex;
  withoutDraggedFrame.splice(insertionIndex, 0, draggedFrameId);

  return withoutDraggedFrame;
};

export const insertFrameIdAfter = (
  orderedFrameIds: readonly ExcalidrawElement["id"][],
  targetFrameId: ExcalidrawElement["id"],
  insertedFrameId: ExcalidrawElement["id"],
) => {
  const nextOrderedFrameIds = orderedFrameIds.filter(
    (frameId) => frameId !== insertedFrameId,
  );
  const targetIndex = nextOrderedFrameIds.indexOf(targetFrameId);

  if (targetIndex < 0) {
    return [...nextOrderedFrameIds, insertedFrameId];
  }

  nextOrderedFrameIds.splice(targetIndex + 1, 0, insertedFrameId);
  return nextOrderedFrameIds;
};

export const selectAndFocusFrame = ({
  app,
  frame,
  setAppState,
}: {
  app: FrameFocusApp;
  frame: ExcalidrawFrameElement;
  setAppState: (nextAppState: FrameSelectionState) => void;
}) => {
  setAppState({
    selectedElementIds: { [frame.id]: true },
    selectedGroupIds: {},
  });

  app.scrollToContent(frame, {
    fitToViewport: true,
    animate: true,
    canvasOffsets: app.getEditorUIOffsets(),
  });
};

export const shouldApplyCanonicalFrameNames = (
  appState: CanonicalFrameNameAppState,
) => {
  return !(
    appState.editingFrame ||
    appState.editingTextElement ||
    appState.multiElement ||
    appState.newElement ||
    appState.resizingElement ||
    appState.selectedElementsAreBeingDragged ||
    appState.selectionElement
  );
};

export const duplicateFrameUnderneath = ({
  elements,
  frame,
  orderedFrameIds,
}: {
  elements: readonly ExcalidrawElement[];
  frame: ExcalidrawFrameElement;
  orderedFrameIds: readonly ExcalidrawElement["id"][];
}) => {
  const masterFrame = getMasterNormalFrame(elements) || frame;
  const duplicateOffsetY =
    Math.max(frame.height, masterFrame.height) + FRAME_NAVIGATOR_SPACING;

  const { duplicatedElements, elementsWithDuplicates, origIdToDuplicateId } =
    duplicateElements({
      type: "in-place",
      elements,
      idsOfElementsToDuplicate: arrayToMap([frame]),
      appState: {
        editingGroupId: null,
        selectedGroupIds: {},
      },
      randomizeSeed: false,
      overrides: ({ origElement, origIdToDuplicateId }) => {
        const duplicateFrameId =
          origElement.frameId && origIdToDuplicateId.get(origElement.frameId);

        if (origElement.id === frame.id) {
          return {
            height: masterFrame.height,
            width: masterFrame.width,
            x: origElement.x,
            y: origElement.y + duplicateOffsetY,
            frameId: duplicateFrameId ?? origElement.frameId,
          };
        }

        return {
          x: origElement.x,
          y: origElement.y + duplicateOffsetY,
          frameId: duplicateFrameId ?? origElement.frameId,
        };
      },
    });

  const duplicatedFrameId = origIdToDuplicateId.get(frame.id);
  if (!duplicatedFrameId) {
    return null;
  }

  const elementsWithIndices = syncMovedIndices(
    elementsWithDuplicates,
    arrayToMap(duplicatedElements),
  );

  const canonicalScene = applyCanonicalFrameNames(
    elementsWithIndices,
    insertFrameIdAfter(orderedFrameIds, frame.id, duplicatedFrameId),
  );

  const duplicatedFrame = canonicalScene.elements.find(
    (element) => element.id === duplicatedFrameId,
  );

  if (!duplicatedFrame || !isNormalFrameElement(duplicatedFrame)) {
    return null;
  }

  return {
    duplicatedFrame,
    elements: canonicalScene.elements,
    origIdToDuplicateId,
    orderedFrameIds: canonicalScene.orderedFrameIds,
  };
};

export const createFrameToRightOfLastFrame = ({
  elements,
  orderedFrames,
  orderedFrameIds,
}: {
  elements: readonly ExcalidrawElement[];
  orderedFrames: readonly ExcalidrawFrameElement[];
  orderedFrameIds: readonly ExcalidrawElement["id"][];
}) => {
  const referenceFrame = orderedFrames[0];
  const lastFrame = orderedFrames.at(-1);

  if (!referenceFrame || !lastFrame) {
    return null;
  }

  const newFrame = newFrameElement({
    x:
      lastFrame.x +
      Math.max(lastFrame.width, referenceFrame.width) +
      FRAME_NAVIGATOR_SPACING,
    y: lastFrame.y,
    width: referenceFrame.width,
    height: referenceFrame.height,
    strokeColor: referenceFrame.strokeColor,
    backgroundColor: referenceFrame.backgroundColor,
    fillStyle: referenceFrame.fillStyle,
    strokeWidth: referenceFrame.strokeWidth,
    strokeStyle: referenceFrame.strokeStyle,
    roughness: referenceFrame.roughness,
    opacity: referenceFrame.opacity,
    roundness: referenceFrame.roundness,
  });

  const elementsWithNewFrame = syncInvalidIndices([...elements, newFrame]);

  const canonicalScene = applyCanonicalFrameNames(elementsWithNewFrame, [
    ...orderedFrameIds,
    newFrame.id,
  ]);

  const insertedFrame = canonicalScene.elements.find(
    (element) => element.id === newFrame.id,
  );

  if (!insertedFrame || !isNormalFrameElement(insertedFrame)) {
    return null;
  }

  return {
    elements: canonicalScene.elements,
    insertedFrame,
    orderedFrameIds: canonicalScene.orderedFrameIds,
  };
};

export const applyCanonicalFrameNames = (
  elements: readonly ExcalidrawElement[],
  preferredOrderIds?: readonly ExcalidrawElement["id"][],
) => {
  const orderedFrames = getOrderedNormalFrames(elements);
  const existingFrameIds = new Set(orderedFrames.map((frame) => frame.id));
  const nextOrderedFrameIds: ExcalidrawElement["id"][] = [];
  const seenFrameIds = new Set<ExcalidrawElement["id"]>();

  for (const frameId of preferredOrderIds || []) {
    if (existingFrameIds.has(frameId) && !seenFrameIds.has(frameId)) {
      nextOrderedFrameIds.push(frameId);
      seenFrameIds.add(frameId);
    }
  }

  for (const frame of orderedFrames) {
    if (!seenFrameIds.has(frame.id)) {
      nextOrderedFrameIds.push(frame.id);
      seenFrameIds.add(frame.id);
    }
  }

  const nextNameByFrameId = new Map(
    nextOrderedFrameIds.map((frameId, index) => {
      return [frameId, getCanonicalFrameName(index + 1)];
    }),
  );

  let didChange = false;

  const nextElements = elements.map((element) => {
    if (!isNormalFrameElement(element)) {
      return element;
    }

    const nextName = nextNameByFrameId.get(element.id);
    if (!nextName || element.name === nextName) {
      return element;
    }

    didChange = true;
    return newElementWith(element, { name: nextName });
  });

  return {
    didChange,
    elements: didChange ? nextElements : elements,
    orderedFrameIds: nextOrderedFrameIds,
  };
};