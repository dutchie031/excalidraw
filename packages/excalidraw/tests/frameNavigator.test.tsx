import {
  HANDWRITTEN_TEXT_OUTLINE_PREVIEW_CUSTOM_DATA_KEY,
  newElement,
  newFrameElement,
  newMagicFrameElement,
  newTextElement,
  CaptureUpdateAction,
} from "@excalidraw/element";
import { StrictMode } from "react";

import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  ExcalidrawTextElement,
} from "@excalidraw/element/types";

import { Excalidraw } from "../index";
import {
  buildAdjacentPlaybackCursor,
  createFrameAnimationModes,
  getAdjacentPlaybackTransition,
} from "../frame-animation";
import {
  clampFramesWindowRect,
  getDefaultFramesWindowRect,
} from "../components/footer/FramesNavigator";
import {
  applyCanonicalFrameNames,
  createFrameToRightOfLastFrame,
  duplicateFrameUnderneath,
  getFrameHeightForAspectRatio,
  FRAME_NAVIGATOR_SPACING,
  getCanonicalFrameName,
  getOrderedNormalFrames,
  insertFrameIdAfter,
  reorderFrameIds,
  selectAndFocusFrame,
  shouldApplyCanonicalFrameNames,
  syncNormalFramesToMasterSize,
} from "../frameNavigator";

import { API } from "./helpers/api";
import {
  act,
  fireEvent,
  mockBoundingClientRect,
  render,
  restoreOriginalGetBoundingClientRect,
  screen,
  waitFor,
} from "./test-utils";

import type { AppState } from "../types";

type TestHook = {
  elements: readonly ExcalidrawElement[];
  state: AppState;
  app: {
    scrollToContent: (...args: unknown[]) => void;
  };
};

const h = (window as typeof window & { h: TestHook }).h;
let restoreMatchMedia: (() => void) | null = null;

const getFrameRow = (frameId: string) => {
  return screen.getByTestId(`frame-row-${frameId}`);
};

const mockPresenterPointerCapabilities = (matches: boolean) => {
  const originalMatchMedia = window.matchMedia;

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => {
      return {
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn().mockReturnValue(false),
        matches,
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      } as unknown as MediaQueryList;
    }),
    writable: true,
  });

  restoreMatchMedia = () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
      writable: true,
    });
    restoreMatchMedia = null;
  };
};

const getElementName = (elementId: string) => {
  const element = h.elements.find((candidate) => candidate.id === elementId);
  return element && "name" in element ? element.name : null;
};

const getSceneElement = <T extends ExcalidrawElement>(elementId: string) => {
  return h.elements.find((candidate) => candidate.id === elementId) as
    | T
    | undefined;
};

const openPresentationMode = () => {
  fireEvent.click(screen.getByTestId("frames-window-trigger"));
  fireEvent.click(screen.getByTestId("frames-window-mode-presentation"));
  return screen.getByTestId("frames-window-mode-panel-presentation");
};

const setPresentationAutomation = (checked: boolean) => {
  const toggle = screen.getByTestId(
    "frames-presentation-automation",
  ) as HTMLInputElement;

  if (toggle.checked !== checked) {
    fireEvent.click(toggle);
  }

  return toggle;
};

const advancePresentationTime = async (playbackMs: number) => {
  await act(async () => {
    vi.advanceTimersByTime(playbackMs);
    await Promise.resolve();
  });
};

async function advancePresentationUntil<T>(
  getValue: () => T,
  predicate: (value: T) => boolean,
  {
    maxAdvanceMs,
    stepMs = 15,
  }: {
    maxAdvanceMs: number;
    stepMs?: number;
  },
): Promise<T> {
  let value = getValue();

  if (predicate(value)) {
    return value;
  }

  let advancedMs = 0;

  while (advancedMs < maxAdvanceMs) {
    await advancePresentationTime(stepMs);
    advancedMs += stepMs;
    value = getValue();

    if (predicate(value)) {
      return value;
    }
  }

  return value;
}

const withFrameAnimationMetadata = (
  frame: ExcalidrawFrameElement,
  metadata: Record<string, unknown>,
): ExcalidrawFrameElement => {
  return withAnimationMetadata(frame, metadata);
};

const withAnimationMetadata = <T extends ExcalidrawElement>(
  element: T,
  metadata: Record<string, unknown>,
): T => {
  return {
    ...element,
    customData: {
      ...(element.customData || {}),
      excalidrawSyncAnimation: metadata,
    },
  } as T;
};

describe("frameNavigator", () => {
  it("orders unnamed frames by canvas position before assigning canonical names", () => {
    const lowerFrame = newFrameElement({ x: 0, y: 200 });
    const upperFrame = newFrameElement({ x: 0, y: 50 });
    const orderedFrames = getOrderedNormalFrames([lowerFrame, upperFrame]);

    expect(
      orderedFrames.map((frame: ExcalidrawFrameElement) => frame.id),
    ).toEqual([upperFrame.id, lowerFrame.id]);
  });

  it("renames only normal frames and ignores magicframes", () => {
    const firstFrame = newFrameElement({ x: 0, y: 0, name: "Frame_4" });
    const secondFrame = newFrameElement({ x: 0, y: 120 });
    const magicFrame = newMagicFrameElement({ x: 0, y: 240, name: "Magic" });

    const nextScene = applyCanonicalFrameNames([
      firstFrame,
      secondFrame,
      magicFrame,
    ]);

    expect(nextScene.didChange).toBe(true);
    expect(nextScene.orderedFrameIds).toEqual([firstFrame.id, secondFrame.id]);
    expect(nextScene.elements[0]).toEqual(
      expect.objectContaining({ name: getCanonicalFrameName(1) }),
    );
    expect(nextScene.elements[1]).toEqual(
      expect.objectContaining({ name: getCanonicalFrameName(2) }),
    );
    expect(nextScene.elements[2]).toEqual(
      expect.objectContaining({ name: "Magic" }),
    );
  });

  it("inserts dragged ids before or after the target", () => {
    expect(reorderFrameIds(["A", "B", "C"], "C", "A", "before")).toEqual([
      "C",
      "A",
      "B",
    ]);
    expect(reorderFrameIds(["A", "B", "C"], "A", "B", "after")).toEqual([
      "B",
      "A",
      "C",
    ]);
  });

  it("inserts a frame id after the requested source frame", () => {
    expect(insertFrameIdAfter(["A", "B", "C"], "B", "D")).toEqual([
      "A",
      "B",
      "D",
      "C",
    ]);
    expect(insertFrameIdAfter(["A", "B", "C"], "missing", "D")).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
  });

  it("selects a frame and requests zoom-to-fit when asked to focus it", () => {
    const frame = newFrameElement({ x: 0, y: 0, width: 240, height: 180 });
    const setAppState = vi.fn();
    const app = {
      getEditorUIOffsets: vi.fn(() => ({
        bottom: 4,
        left: 1,
        right: 3,
        top: 2,
      })),
      scrollToContent: vi.fn(),
    };

    selectAndFocusFrame({
      app,
      frame,
      setAppState,
    });

    expect(setAppState).toHaveBeenCalledWith({
      selectedElementIds: { [frame.id]: true },
      selectedGroupIds: {},
    });
    expect(app.scrollToContent).toHaveBeenCalledWith(
      frame,
      expect.objectContaining({
        animate: true,
        fitToViewport: true,
        canvasOffsets: {
          bottom: 4,
          left: 1,
          right: 3,
          top: 2,
        },
      }),
    );
  });

  it("skips canonical renaming while an interactive scene change is in progress", () => {
    expect(
      shouldApplyCanonicalFrameNames({
        editingFrame: null,
        editingTextElement: null,
        multiElement: null,
        newElement: newFrameElement({ x: 0, y: 0, width: 1, height: 1 }),
        resizingElement: null,
        selectedElementsAreBeingDragged: false,
        selectionElement: null,
      }),
    ).toBe(false);

    expect(
      shouldApplyCanonicalFrameNames({
        editingFrame: null,
        editingTextElement: null,
        multiElement: null,
        newElement: null,
        resizingElement: newFrameElement({ x: 0, y: 0, width: 1, height: 1 }),
        selectedElementsAreBeingDragged: false,
        selectionElement: null,
      }),
    ).toBe(false);

    expect(
      shouldApplyCanonicalFrameNames({
        editingFrame: null,
        editingTextElement: null,
        multiElement: null,
        newElement: null,
        resizingElement: null,
        selectedElementsAreBeingDragged: true,
        selectionElement: null,
      }),
    ).toBe(false);

    expect(
      shouldApplyCanonicalFrameNames({
        editingFrame: null,
        editingTextElement: null,
        multiElement: null,
        newElement: null,
        resizingElement: null,
        selectedElementsAreBeingDragged: false,
        selectionElement: null,
      }),
    ).toBe(true);
  });

  it("creates a new frame to the right of the last frame using Frame_1 dimensions", () => {
    const firstFrame = newFrameElement({
      x: 0,
      y: 0,
      width: 240,
      height: 180,
      name: "Frame_1",
    });
    const lastFrame = newFrameElement({
      x: 600,
      y: 300,
      width: 400,
      height: 260,
      name: "Frame_2",
    });

    const nextScene = createFrameToRightOfLastFrame({
      elements: [firstFrame, lastFrame],
      orderedFrames: [firstFrame, lastFrame],
      orderedFrameIds: [firstFrame.id, lastFrame.id],
    });

    expect(nextScene).not.toBeNull();
    expect(nextScene?.insertedFrame.x).toBe(
      lastFrame.x + lastFrame.width + FRAME_NAVIGATOR_SPACING,
    );
    expect(nextScene?.insertedFrame.y).toBe(lastFrame.y);
    expect(nextScene?.insertedFrame.width).toBe(firstFrame.width);
    expect(nextScene?.insertedFrame.height).toBe(firstFrame.height);
    expect(nextScene?.insertedFrame.name).toBe("Frame_3");
  });

  it("duplicates a frame below the source and inserts it after the source order", () => {
    const sourceFrame = newFrameElement({
      x: 0,
      y: 0,
      width: 240,
      height: 180,
      name: "Frame_1",
    });
    const child = {
      ...newElement({
        type: "rectangle",
        x: 24,
        y: 36,
        width: 60,
        height: 40,
        frameId: sourceFrame.id,
      }),
      seed: 2468,
    };
    const siblingFrame = newFrameElement({
      x: 0,
      y: 320,
      width: 240,
      height: 180,
      name: "Frame_2",
    });

    const nextScene = duplicateFrameUnderneath({
      elements: [sourceFrame, child, siblingFrame],
      frame: sourceFrame,
      orderedFrameIds: [sourceFrame.id, siblingFrame.id],
    });

    expect(nextScene).not.toBeNull();
    expect(nextScene?.duplicatedFrame.x).toBe(sourceFrame.x);
    expect(nextScene?.duplicatedFrame.y).toBe(
      sourceFrame.y + sourceFrame.height + FRAME_NAVIGATOR_SPACING,
    );
    expect(nextScene?.duplicatedFrame.name).toBe("Frame_2");
    expect(nextScene?.orderedFrameIds).toEqual([
      sourceFrame.id,
      nextScene?.duplicatedFrame.id,
      siblingFrame.id,
    ]);

    const duplicatedChild = nextScene?.elements.find(
      (element) => element.id !== child.id && element.type === "rectangle",
    );

    expect(duplicatedChild).toEqual(
      expect.objectContaining({
        frameId: nextScene?.duplicatedFrame.id,
        seed: child.seed,
        x: child.x,
        y: child.y + sourceFrame.height + FRAME_NAVIGATOR_SPACING,
      }),
    );
    expect(nextScene?.duplicatedFrame.seed).toBe(sourceFrame.seed);
  });

  it("syncs normal frames to the master frame size and reflows frame children", () => {
    const firstFrame = newFrameElement({
      x: 0,
      y: 0,
      width: 240,
      height: 180,
      name: "Frame_1",
    });
    const rightFrame = newFrameElement({
      x: 270,
      y: 0,
      width: 180,
      height: 120,
      name: "Frame_2",
    });
    const lowerFrame = newFrameElement({
      x: 0,
      y: 210,
      width: 180,
      height: 120,
      name: "Frame_3",
    });
    const child = newElement({
      type: "rectangle",
      x: rightFrame.x + 24,
      y: rightFrame.y + 36,
      width: 60,
      height: 40,
      frameId: rightFrame.id,
    });
    const resizedMaster = {
      ...firstFrame,
      x: 40,
      y: 50,
      width: 320,
      height: 200,
    };

    const nextElements = syncNormalFramesToMasterSize({
      elements: [resizedMaster, rightFrame, lowerFrame, child],
      masterFrameId: firstFrame.id,
      referenceElements: [firstFrame, rightFrame, lowerFrame, child],
    });

    const nextRightFrame = nextElements.find(
      (element) => element.id === rightFrame.id,
    ) as ExcalidrawFrameElement;
    const nextLowerFrame = nextElements.find(
      (element) => element.id === lowerFrame.id,
    ) as ExcalidrawFrameElement;
    const nextChild = nextElements.find((element) => element.id === child.id);

    expect(nextRightFrame).toEqual(
      expect.objectContaining({
        x: 390,
        y: 50,
        width: 320,
        height: 200,
      }),
    );
    expect(nextLowerFrame).toEqual(
      expect.objectContaining({
        x: 40,
        y: 280,
        width: 320,
        height: 200,
      }),
    );
    expect(nextChild).toEqual(
      expect.objectContaining({
        x: 414,
        y: 86,
      }),
    );
  });

  it("derives frame heights from aspect-ratio presets using the master width", () => {
    expect(getFrameHeightForAspectRatio(320, "16:9")).toBe(180);
    expect(getFrameHeightForAspectRatio(320, "4:3")).toBe(240);
    expect(getFrameHeightForAspectRatio(320, "1:1")).toBe(320);
  });

  it("clamps the frames window rect within viewport bounds", () => {
    expect(
      clampFramesWindowRect(
        {
          x: -100,
          y: -50,
          width: 900,
          height: 700,
        },
        {
          width: 640,
          height: 480,
        },
      ),
    ).toEqual({
      x: 16,
      y: 16,
      width: 608,
      height: 448,
    });
  });

  it("positions the frames window near the right edge by default", () => {
    expect(
      getDefaultFramesWindowRect({
        width: 1280,
        height: 720,
      }),
    ).toEqual({
      x: 904,
      y: 72,
      width: 360,
      height: 460,
    });
  });

  it("reuses the earlier frame transition metadata when stepping backward", () => {
    const firstFrame = withFrameAnimationMetadata(
      newFrameElement({ x: 0, y: 0, width: 240, height: 180, name: "Frame_1" }),
      {
        transition: {
          durationMs: 500,
          easing: "ease-in",
          fallback: "cut",
        },
      },
    );
    const secondFrame = withFrameAnimationMetadata(
      newFrameElement({
        x: 0,
        y: 220,
        width: 240,
        height: 180,
        name: "Frame_2",
      }),
      {
        transition: {
          durationMs: 1200,
          easing: "ease-out",
          fallback: "fade",
        },
      },
    );

    const backwardTransition = getAdjacentPlaybackTransition({
      direction: "backward",
      orderedFrames: [firstFrame, secondFrame],
      sourceFrameIndex: 1,
    });

    expect(backwardTransition).toEqual(
      expect.objectContaining({
        direction: "backward",
        sourceFrameIndex: 1,
        targetFrameIndex: 0,
        transitionOwnerFrameIndex: 0,
        transition: {
          durationMs: 500,
          easing: "ease-in",
          fallback: "cut",
        },
      }),
    );
    expect(backwardTransition?.sourceFrame.id).toBe(secondFrame.id);
    expect(backwardTransition?.targetFrame.id).toBe(firstFrame.id);
    expect(backwardTransition?.transitionOwnerFrame.id).toBe(firstFrame.id);
  });

  it("time-reverses easing for backward adjacent playback", () => {
    const firstFrame = withFrameAnimationMetadata(
      newFrameElement({ x: 0, y: 0, width: 240, height: 180, name: "Frame_1" }),
      {
        transition: {
          durationMs: 500,
          easing: "ease-in",
          fallback: "fade",
        },
      },
    );
    const secondFrame = newFrameElement({
      x: 0,
      y: 220,
      width: 240,
      height: 180,
      name: "Frame_2",
    });

    const forwardTransition = getAdjacentPlaybackTransition({
      direction: "forward",
      orderedFrames: [firstFrame, secondFrame],
      sourceFrameIndex: 0,
    });
    const backwardTransition = getAdjacentPlaybackTransition({
      direction: "backward",
      orderedFrames: [firstFrame, secondFrame],
      sourceFrameIndex: 1,
    });

    expect(forwardTransition).not.toBeNull();
    expect(backwardTransition).not.toBeNull();

    const forwardCursor = buildAdjacentPlaybackCursor(forwardTransition!, 125);
    const backwardCursor = buildAdjacentPlaybackCursor(
      backwardTransition!,
      125,
    );

    expect(forwardCursor.direction).toBe("forward");
    expect(backwardCursor.direction).toBe("backward");
    expect(forwardCursor.easedProgress).toBeCloseTo(0.0625);
    expect(backwardCursor.easedProgress).toBeCloseTo(0.4375);
    expect(backwardCursor.frame.id).toBe(secondFrame.id);
    expect(backwardCursor.nextFrame?.id).toBe(firstFrame.id);
    expect(backwardCursor.transitionOwnerFrame?.id).toBe(firstFrame.id);
  });
});

describe("Frames navigator", () => {
  beforeAll(() => {
    mockBoundingClientRect({ width: 1200, height: 800 });
  });

  afterEach(() => {
    restoreMatchMedia?.();
  });

  afterAll(() => {
    restoreOriginalGetBoundingClientRect();
  });

  it("stays open on outside clicks and closes explicitly", async () => {
    await render(<Excalidraw />);

    fireEvent.click(screen.getByTestId("frames-window-trigger"));

    const framesWindow = await screen.findByTestId("frames-window");

    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);

    expect(screen.getByTestId("frames-window")).toBe(framesWindow);

    fireEvent.click(screen.getByTestId("frames-window-trigger"));

    await waitFor(() => {
      expect(screen.queryByTestId("frames-window")).toBeNull();
    });
  });

  it("renders custom frame window modes inside the shared shell", async () => {
    await render(
      <Excalidraw
        frameNavigatorModes={[
          {
            id: "repair",
            label: "Repair",
            render: () => (
              <div data-testid="custom-frame-repair">Repair mode</div>
            ),
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByTestId("frames-window-trigger"));

    await screen.findByTestId("frames-window");

    fireEvent.click(screen.getByTestId("frames-window-mode-repair"));

    expect(screen.getByTestId("custom-frame-repair").textContent).toContain(
      "Repair mode",
    );
  });

  it("lets custom frame window modes focus elements without zooming to fit", async () => {
    await render(
      <Excalidraw
        frameNavigatorModes={[
          {
            id: "repair",
            label: "Repair",
            render: (context) => (
              <button
                data-testid="custom-frame-focus-preserve-zoom"
                onClick={() => {
                  context.selectAndFocusElementIds(
                    [context.orderedFrameIds[0]],
                    {
                      fitToViewport: false,
                    },
                  );
                }}
              >
                Focus without zoom
              </button>
            ),
          },
        ]}
      />,
    );

    const sourceFrame = newFrameElement({
      x: 0,
      y: 0,
      width: 240,
      height: 180,
      name: "Frame_1",
    });

    API.updateScene({
      elements: [sourceFrame],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    const scrollToContentSpy = vi.spyOn(h.app, "scrollToContent");

    fireEvent.click(screen.getByTestId("frames-window-trigger"));
    fireEvent.click(screen.getByTestId("frames-window-mode-repair"));
    fireEvent.click(screen.getByTestId("custom-frame-focus-preserve-zoom"));

    expect(scrollToContentSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: sourceFrame.id }),
      expect.objectContaining({
        animate: true,
        fitToViewport: false,
      }),
    );

    scrollToContentSpy.mockRestore();
  });

  it("canonicalizes frame names, excludes magicframes, lets the list reorder frames, and supports new and duplicate actions", async () => {
    await render(<Excalidraw />);

    const lowerFrame = newFrameElement({
      x: 0,
      y: 300,
      width: 240,
      height: 180,
    });
    const upperFrame = newFrameElement({
      x: 0,
      y: 0,
      width: 240,
      height: 180,
    });
    const farFrame = newFrameElement({
      x: 1800,
      y: 0,
      width: 240,
      height: 180,
    });
    const magicFrame = newMagicFrameElement({
      x: 0,
      y: 600,
      width: 240,
      height: 180,
    });

    API.updateScene({
      elements: [lowerFrame, upperFrame, farFrame, magicFrame],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    await waitFor(() => {
      expect(getElementName(upperFrame.id)).toBe("Frame_1");
      expect(getElementName(farFrame.id)).toBe("Frame_2");
      expect(getElementName(lowerFrame.id)).toBe("Frame_3");
      expect(getElementName(magicFrame.id)).toBeNull();
    });

    fireEvent.click(screen.getByTestId("frames-window-trigger"));

    await waitFor(() => {
      expect(screen.getByTestId("frames-sidebar")).not.toBeNull();
      expect(getFrameRow(upperFrame.id).textContent).toContain("Frame_1");
      expect(getFrameRow(farFrame.id).textContent).toContain("Frame_2");
      expect(getFrameRow(lowerFrame.id).textContent).toContain("Frame_3");
      expect(screen.queryByTestId(`frame-row-${magicFrame.id}`)).toBeNull();
    });

    fireEvent.click(screen.getByTestId("new-frame-button"));

    let appendedFrameId: string | null = null;

    await waitFor(() => {
      const appendedFrame = h.elements.find(
        (element) =>
          element.type === "frame" &&
          element.id !== upperFrame.id &&
          element.id !== farFrame.id &&
          element.id !== lowerFrame.id &&
          "name" in element &&
          element.name === "Frame_4",
      );

      expect(appendedFrame).not.toBeUndefined();

      appendedFrameId = appendedFrame?.id || null;
      expect(appendedFrame).toEqual(
        expect.objectContaining({
          x: lowerFrame.x + lowerFrame.width + FRAME_NAVIGATOR_SPACING,
          y: lowerFrame.y,
          width: upperFrame.width,
          height: upperFrame.height,
        }),
      );
    });

    expect(appendedFrameId).not.toBeNull();

    fireEvent.click(screen.getByTestId(`duplicate-frame-${upperFrame.id}`));

    let duplicatedFrameId: string | null = null;

    await waitFor(() => {
      const duplicatedFrame = h.elements.find(
        (element) =>
          element.type === "frame" &&
          element.id !== upperFrame.id &&
          element.id !== farFrame.id &&
          element.id !== lowerFrame.id &&
          element.id !== appendedFrameId &&
          "name" in element &&
          element.name === "Frame_2",
      );

      expect(duplicatedFrame).not.toBeUndefined();
      duplicatedFrameId = duplicatedFrame?.id || null;

      expect(duplicatedFrame).toEqual(
        expect.objectContaining({
          x: upperFrame.x,
          y: upperFrame.y + upperFrame.height + FRAME_NAVIGATOR_SPACING,
          width: upperFrame.width,
          height: upperFrame.height,
        }),
      );

      expect(getElementName(farFrame.id)).toBe("Frame_3");
      expect(getElementName(lowerFrame.id)).toBe("Frame_4");
      expect(appendedFrameId && getElementName(appendedFrameId)).toBe(
        "Frame_5",
      );
    });

    expect(duplicatedFrameId).not.toBeNull();
    expect(getFrameRow(duplicatedFrameId!).textContent).toContain("Frame_2");

    const dragData = {
      effectAllowed: "move",
      dropEffect: "move",
      setData: () => {},
      getData: () => "",
      clearData: () => {},
    };

    fireEvent.dragStart(getFrameRow(farFrame.id), {
      dataTransfer: dragData,
    });
    fireEvent.dragOver(getFrameRow(upperFrame.id), {
      dataTransfer: dragData,
      clientY: 1,
    });
    fireEvent.drop(getFrameRow(upperFrame.id), {
      dataTransfer: dragData,
      clientY: 1,
    });

    await waitFor(() => {
      expect(getElementName(farFrame.id)).toBe("Frame_1");
      expect(getElementName(upperFrame.id)).toBe("Frame_2");
      expect(getElementName(lowerFrame.id)).toBe("Frame_4");
      expect(duplicatedFrameId && getElementName(duplicatedFrameId)).toBe(
        "Frame_3",
      );
      expect(appendedFrameId && getElementName(appendedFrameId)).toBe(
        "Frame_5",
      );
    });
  });

  it("applies onFrameDuplicate results before committing the duplicated frame scene", async () => {
    await render(
      <Excalidraw
        onFrameDuplicate={({ duplicatedFrame, nextElements, sourceFrame }) => {
          return nextElements.map((element) => {
            if (element.id !== duplicatedFrame.id) {
              return element;
            }

            return {
              ...element,
              customData: {
                ...(element.customData || {}),
                duplicatedFromFrame: sourceFrame.id,
              },
            };
          });
        }}
      />,
    );

    const sourceFrame = newFrameElement({
      x: 0,
      y: 0,
      width: 240,
      height: 180,
      name: "Frame_1",
    });

    API.updateScene({
      elements: [sourceFrame],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    fireEvent.click(screen.getByTestId("frames-window-trigger"));
    fireEvent.click(screen.getByTestId(`duplicate-frame-${sourceFrame.id}`));

    await waitFor(() => {
      const duplicatedFrame = h.elements.find(
        (element) =>
          element.type === "frame" &&
          element.id !== sourceFrame.id &&
          "customData" in element &&
          element.customData?.duplicatedFromFrame === sourceFrame.id,
      );

      expect(duplicatedFrame).not.toBeUndefined();
    });
  });

  it("applies aspect ratio buttons to all normal frames using Frame_1 width", async () => {
    await render(<Excalidraw />);

    const firstFrame = newFrameElement({
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      name: "Frame_1",
    });
    const lowerFrame = newFrameElement({
      x: 0,
      y: 210,
      width: 240,
      height: 140,
      name: "Frame_2",
    });
    const lowerChild = newElement({
      type: "rectangle",
      x: lowerFrame.x + 20,
      y: lowerFrame.y + 30,
      width: 60,
      height: 40,
      frameId: lowerFrame.id,
    });

    API.updateScene({
      elements: [firstFrame, lowerFrame, lowerChild],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    await waitFor(() => {
      expect(getElementName(firstFrame.id)).toBe("Frame_1");
      expect(getElementName(lowerFrame.id)).toBe("Frame_2");
    });

    fireEvent.click(screen.getByTestId("frames-window-trigger"));
    fireEvent.click(screen.getByTestId("frame-ratio-1-1"));

    await waitFor(() => {
      expect(getSceneElement<ExcalidrawFrameElement>(firstFrame.id)).toEqual(
        expect.objectContaining({
          x: 0,
          y: 0,
          width: 320,
          height: 320,
        }),
      );
      expect(getSceneElement<ExcalidrawFrameElement>(lowerFrame.id)).toEqual(
        expect.objectContaining({
          x: 0,
          y: 350,
          width: 320,
          height: 320,
        }),
      );
      expect(getSceneElement(lowerChild.id)).toEqual(
        expect.objectContaining({
          x: 20,
          y: 380,
        }),
      );
    });
  });

  it("opens the presenter overlay and navigates with arrow keys", async () => {
    await render(
      <Excalidraw frameNavigatorModes={createFrameAnimationModes()} />,
    );

    const firstFrame = withFrameAnimationMetadata(
      newFrameElement({
        x: 0,
        y: 0,
        width: 240,
        height: 180,
        name: "Frame_1",
      }),
      {
        transition: {
          durationMs: 0,
          easing: "linear",
          fallback: "cut",
        },
      },
    );
    const secondFrame = newFrameElement({
      x: 0,
      y: 240,
      width: 240,
      height: 180,
      name: "Frame_2",
    });

    API.updateScene({
      elements: [firstFrame, secondFrame],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    fireEvent.click(screen.getByTestId("frames-window-trigger"));
    fireEvent.click(screen.getByTestId("frames-window-mode-presentation"));
    fireEvent.click(screen.getByTestId("frames-presentation-present"));

    await screen.findByRole("dialog", {
      name: /presenting frame_1\. frame 1 of 2\./i,
    });

    fireEvent.keyDown(document, { key: "ArrowRight" });

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", {
          name: /presenting frame_2\. frame 2 of 2\./i,
        }),
      ).not.toBeNull();
    });

    fireEvent.keyDown(document, { key: "ArrowLeft" });

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", {
          name: /presenting frame_1\. frame 1 of 2\./i,
        }),
      ).not.toBeNull();
    });

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByTestId("frames-presenter")).toBeNull();
      expect(
        screen.queryByTestId("frames-window-mode-panel-presentation"),
      ).toBeNull();
      expect(screen.getByTestId("new-frame-button")).not.toBeNull();
      expect(
        screen
          .getByTestId("frames-window-mode-frames")
          .classList.contains("is-active"),
      ).toBe(true);
    });
  });

  it("renders presenter stage zones and supports slideshow keys", async () => {
    await render(
      <Excalidraw frameNavigatorModes={createFrameAnimationModes()} />,
    );

    const firstFrame = withFrameAnimationMetadata(
      newFrameElement({
        x: 0,
        y: 0,
        width: 240,
        height: 180,
        name: "Frame_1",
      }),
      {
        transition: {
          durationMs: 0,
          easing: "linear",
          fallback: "cut",
        },
      },
    );
    const secondFrame = newFrameElement({
      x: 0,
      y: 240,
      width: 240,
      height: 180,
      name: "Frame_2",
    });

    API.updateScene({
      elements: [firstFrame, secondFrame],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    openPresentationMode();
    fireEvent.click(screen.getByTestId("frames-presentation-present"));

    const presenter = await screen.findByRole("dialog", {
      name: /presenting frame_1\. frame 1 of 2\./i,
    });

    expect(
      screen.getByTestId("frames-presenter-stage-previous"),
    ).not.toBeNull();
    expect(screen.getByTestId("frames-presenter-stage-next")).not.toBeNull();
    expect(screen.getByTestId("frames-presenter-close")).not.toBeNull();
    expect(screen.queryByTestId("frames-presenter-fullscreen")).toBeNull();
    expect(presenter.querySelector(".frames-presenter__header")).toBeNull();
    expect(presenter.querySelector(".frames-presenter__footer")).toBeNull();
    expect(
      presenter.querySelector(".frames-presenter__stage-center"),
    ).toBeNull();

    fireEvent.keyDown(document, { key: "Enter" });

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", {
          name: /presenting frame_2\. frame 2 of 2\./i,
        }),
      ).not.toBeNull();
    });

    fireEvent.keyDown(document, { key: "Backspace" });

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", {
          name: /presenting frame_1\. frame 1 of 2\./i,
        }),
      ).not.toBeNull();
    });
  });

  it("renders a presenter fullscreen button only when configured and reports fullscreen requests", async () => {
    mockPresenterPointerCapabilities(false);

    const onPresenterFullscreenRequest = vi.fn();

    await render(
      <Excalidraw
        frameNavigatorModes={createFrameAnimationModes({
          onPresenterFullscreenRequest,
        })}
      />,
    );

    const firstFrame = withFrameAnimationMetadata(
      newFrameElement({
        x: 0,
        y: 0,
        width: 240,
        height: 180,
        name: "Frame_1",
      }),
      {
        transition: {
          durationMs: 0,
          easing: "linear",
          fallback: "cut",
        },
      },
    );
    const secondFrame = newFrameElement({
      x: 0,
      y: 240,
      width: 240,
      height: 180,
      name: "Frame_2",
    });

    API.updateScene({
      elements: [firstFrame, secondFrame],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    openPresentationMode();
    fireEvent.click(screen.getByTestId("frames-presentation-present"));

    await screen.findByRole("dialog", {
      name: /presenting frame_1\. frame 1 of 2\./i,
    });

    const controls = screen.getByTestId("frames-presenter-controls");

    expect(controls.getAttribute("data-controls-visible")).toBe("true");
    expect(screen.getByTestId("frames-presenter-fullscreen")).not.toBeNull();

    fireEvent.click(screen.getByTestId("frames-presenter-fullscreen"));

    expect(onPresenterFullscreenRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        currentFrame: expect.objectContaining({ id: firstFrame.id }),
        currentFrameIndex: 0,
        presenterElement: expect.any(HTMLDivElement),
        totalFrames: 2,
      }),
    );
  });

  it("reveals presenter controls only near the top-right hotspot for mouse users", async () => {
    mockPresenterPointerCapabilities(true);

    await render(
      <Excalidraw
        frameNavigatorModes={createFrameAnimationModes({
          onPresenterFullscreenRequest: vi.fn(),
        })}
      />,
    );

    const firstFrame = withFrameAnimationMetadata(
      newFrameElement({
        x: 0,
        y: 0,
        width: 240,
        height: 180,
        name: "Frame_1",
      }),
      {
        transition: {
          durationMs: 0,
          easing: "linear",
          fallback: "cut",
        },
      },
    );
    const secondFrame = newFrameElement({
      x: 0,
      y: 240,
      width: 240,
      height: 180,
      name: "Frame_2",
    });

    API.updateScene({
      elements: [firstFrame, secondFrame],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    openPresentationMode();
    fireEvent.click(screen.getByTestId("frames-presentation-present"));

    await screen.findByRole("dialog", {
      name: /presenting frame_1\. frame 1 of 2\./i,
    });

    const controls = screen.getByTestId("frames-presenter-controls");
    const surface = screen.getByTestId("frames-presenter-surface");

    expect(controls.getAttribute("data-controls-visible")).toBe("false");

    fireEvent.pointerMove(surface, {
      clientX: 24,
      clientY: 24,
      pointerType: "mouse",
    });

    expect(controls.getAttribute("data-controls-visible")).toBe("false");

    fireEvent.pointerMove(surface, {
      clientX: window.innerWidth - 16,
      clientY: 24,
      pointerType: "mouse",
    });

    expect(controls.getAttribute("data-controls-visible")).toBe("true");

    fireEvent.pointerMove(surface, {
      clientX: 40,
      clientY: 220,
      pointerType: "mouse",
    });

    expect(controls.getAttribute("data-controls-visible")).toBe("false");
  });

  it("keeps the present action visible across frames window modes", async () => {
    await render(
      <Excalidraw frameNavigatorModes={createFrameAnimationModes()} />,
    );

    const firstFrame = withFrameAnimationMetadata(
      newFrameElement({
        x: 0,
        y: 0,
        width: 240,
        height: 180,
        name: "Frame_1",
      }),
      {
        transition: {
          durationMs: 0,
          easing: "linear",
          fallback: "cut",
        },
      },
    );
    const secondFrame = newFrameElement({
      x: 0,
      y: 240,
      width: 240,
      height: 180,
      name: "Frame_2",
    });

    API.updateScene({
      elements: [firstFrame, secondFrame],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    fireEvent.click(screen.getByTestId("frames-window-trigger"));

    await screen.findByTestId("frames-presentation-present");

    fireEvent.click(screen.getByTestId("frames-window-mode-repair"));

    expect(screen.getByTestId("frames-presentation-present")).not.toBeNull();

    fireEvent.click(screen.getByTestId("frames-presentation-present"));

    await screen.findByRole("dialog", {
      name: /presenting frame_1\. frame 1 of 2\./i,
    });
  });

  it("hides frame chrome when presenting directly from the frames view", async () => {
    await render(
      <StrictMode>
        <Excalidraw frameNavigatorModes={createFrameAnimationModes()} />
      </StrictMode>,
    );

    const firstFrame = withFrameAnimationMetadata(
      newFrameElement({
        x: 0,
        y: 0,
        width: 240,
        height: 180,
        name: "Frame_1",
      }),
      {
        transition: {
          durationMs: 0,
          easing: "linear",
          fallback: "cut",
        },
      },
    );
    const secondFrame = newFrameElement({
      x: 1200,
      y: 900,
      width: 240,
      height: 180,
      name: "Frame_2",
    });

    API.updateScene({
      elements: [firstFrame, secondFrame],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setAppState({
      scrollX: -4000,
      scrollY: -2600,
      selectedElementIds: { [secondFrame.id]: true },
      selectedGroupIds: {},
    });

    const initialScrollX = h.state.scrollX;
    const initialScrollY = h.state.scrollY;
    const initialFrameRendering = h.state.frameRendering;
    const initialSelectedElementIds = h.state.selectedElementIds;
    const initialSelectedGroupIds = h.state.selectedGroupIds;

    fireEvent.click(screen.getByTestId("frames-window-trigger"));

    await screen.findByTestId("frames-presentation-present");

    fireEvent.click(screen.getByTestId("frames-presentation-present"));

    await screen.findByRole("dialog", {
      name: /presenting frame_2\. frame 2 of 2\./i,
    });

    await waitFor(() => {
      expect(h.state.scrollX).not.toBe(initialScrollX);
      expect(h.state.scrollY).not.toBe(initialScrollY);
      expect(h.state.selectedElementIds).toEqual({});
      expect(h.state.selectedGroupIds).toEqual({});
      expect(document.body.classList.contains("excalidraw--presenting")).toBe(
        true,
      );
      expect(h.state.frameRendering).toEqual(
        expect.objectContaining({
          enabled: true,
          clip: true,
          name: false,
          outline: false,
        }),
      );
    });

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByTestId("frames-presenter")).toBeNull();
      expect(
        screen.queryByTestId("frames-window-mode-panel-presentation"),
      ).toBeNull();
      expect(screen.getByTestId("new-frame-button")).not.toBeNull();
      expect(
        screen
          .getByTestId("frames-window-mode-frames")
          .classList.contains("is-active"),
      ).toBe(true);
      expect(h.state.scrollX).toBe(initialScrollX);
      expect(h.state.scrollY).toBe(initialScrollY);
      expect(h.state.selectedElementIds).toEqual(initialSelectedElementIds);
      expect(h.state.selectedGroupIds).toEqual(initialSelectedGroupIds);
      expect(document.body.classList.contains("excalidraw--presenting")).toBe(
        false,
      );
      expect(h.state.frameRendering).toEqual(initialFrameRendering);
    });
  });

  it("focuses presenter on the active presented stage and restores the prior viewport on exit", async () => {
    await render(
      <Excalidraw frameNavigatorModes={createFrameAnimationModes()} />,
    );

    const firstFrame = withFrameAnimationMetadata(
      newFrameElement({
        x: 0,
        y: 0,
        width: 240,
        height: 180,
        name: "Frame_1",
      }),
      {
        holdMs: 100,
        transition: {
          durationMs: 0,
          easing: "linear",
          fallback: "cut",
        },
      },
    );
    const secondFrame = newFrameElement({
      x: 1200,
      y: 900,
      width: 240,
      height: 180,
      name: "Frame_2",
    });
    API.updateScene({
      elements: [firstFrame, secondFrame],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setAppState({
      scrollX: -4000,
      scrollY: -2600,
      selectedElementIds: { [secondFrame.id]: true },
      selectedGroupIds: {},
    });

    openPresentationMode();

    const initialScrollX = h.state.scrollX;
    const initialScrollY = h.state.scrollY;
    const initialFrameRendering = h.state.frameRendering;
    const initialSelectedElementIds = h.state.selectedElementIds;
    const initialSelectedGroupIds = h.state.selectedGroupIds;
    fireEvent.click(screen.getByTestId("frames-presentation-present"));

    await screen.findByTestId("frames-presenter");

    await waitFor(() => {
      expect(getSceneElement<ExcalidrawFrameElement>(secondFrame.id)).toEqual(
        expect.objectContaining({
          x: secondFrame.x,
          y: secondFrame.y,
        }),
      );
      expect(h.state.scrollX).not.toBe(initialScrollX);
      expect(h.state.scrollY).not.toBe(initialScrollY);
      expect(h.state.selectedElementIds).toEqual({});
      expect(h.state.selectedGroupIds).toEqual({});
      expect(document.body.classList.contains("excalidraw--presenting")).toBe(
        true,
      );
      expect(h.state.frameRendering).toEqual(
        expect.objectContaining({
          enabled: true,
          clip: true,
          name: false,
          outline: false,
        }),
      );
    });

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByTestId("frames-presenter")).toBeNull();
      expect(
        screen.queryByTestId("frames-window-mode-panel-presentation"),
      ).toBeNull();
      expect(screen.getByTestId("new-frame-button")).not.toBeNull();
      expect(
        screen
          .getByTestId("frames-window-mode-frames")
          .classList.contains("is-active"),
      ).toBe(true);
      expect(h.state.scrollX).toBe(initialScrollX);
      expect(h.state.scrollY).toBe(initialScrollY);
      expect(h.state.selectedElementIds).toEqual(initialSelectedElementIds);
      expect(h.state.selectedGroupIds).toEqual(initialSelectedGroupIds);
      expect(document.body.classList.contains("excalidraw--presenting")).toBe(
        false,
      );
      expect(h.state.frameRendering).toEqual(initialFrameRendering);
      expect(getSceneElement<ExcalidrawFrameElement>(secondFrame.id)).toEqual(
        expect.objectContaining({
          x: secondFrame.x,
          y: secondFrame.y,
        }),
      );
    });
  });

  it("clears a selected frame during presenter mode and restores it on exit", async () => {
    await render(
      <Excalidraw frameNavigatorModes={createFrameAnimationModes()} />,
    );

    const firstFrame = withFrameAnimationMetadata(
      newFrameElement({
        x: 0,
        y: 0,
        width: 240,
        height: 180,
        name: "Frame_1",
      }),
      {
        transition: {
          durationMs: 0,
          easing: "linear",
          fallback: "cut",
        },
      },
    );
    const secondFrame = newFrameElement({
      x: 0,
      y: 240,
      width: 240,
      height: 180,
      name: "Frame_2",
    });

    API.updateScene({
      elements: [firstFrame, secondFrame],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setAppState({
      selectedElementIds: { [secondFrame.id]: true },
      selectedGroupIds: {},
    });

    openPresentationMode();

    const initialSelectedElementIds = h.state.selectedElementIds;

    fireEvent.click(screen.getByTestId("frames-presentation-present"));

    await screen.findByRole("dialog", {
      name: /presenting frame_2\. frame 2 of 2\./i,
    });

    await waitFor(() => {
      expect(h.state.selectedElementIds).toEqual({});
      expect(h.state.selectedGroupIds).toEqual({});
    });

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByTestId("frames-presenter")).toBeNull();
      expect(h.state.selectedElementIds).toEqual(initialSelectedElementIds);
      expect(h.state.selectedGroupIds).toEqual({});
    });
  });

  it("shows the current frame settled when manual presentation starts", async () => {
    await render(
      <Excalidraw frameNavigatorModes={createFrameAnimationModes()} />,
    );

    const frame = withFrameAnimationMetadata(
      newFrameElement({
        x: 0,
        y: 0,
        width: 240,
        height: 180,
        name: "Frame_1",
      }),
      {
        holdMs: 50,
      },
    );
    const text = withAnimationMetadata(
      newTextElement({
        text: "HELLO",
        x: frame.x + 40,
        y: frame.y + 50,
        frameId: frame.id,
      }),
      {
        appearance: {
          durationMs: 150,
          style: "typewriter",
        },
      },
    );

    API.updateScene({
      elements: [frame, text],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    openPresentationMode();
    fireEvent.click(screen.getByTestId("frames-presentation-present"));

    await screen.findByRole("dialog", {
      name: /presenting frame_1\. frame 1 of 1\./i,
    });

    await waitFor(() => {
      const previewText = getSceneElement<ExcalidrawTextElement>(text.id);

      expect(previewText?.text).toBe("HELLO");
      expect(previewText?.opacity).toBe(100);
    });
  });

  it("animates the target frame reveal after stepping forward in manual presentation mode", async () => {
    vi.useFakeTimers();

    try {
      await render(
        <Excalidraw frameNavigatorModes={createFrameAnimationModes()} />,
      );

      const firstFrame = withFrameAnimationMetadata(
        newFrameElement({
          x: 0,
          y: 0,
          width: 240,
          height: 180,
          name: "Frame_1",
        }),
        {
          holdMs: 0,
          transition: {
            durationMs: 60,
            easing: "linear",
            fallback: "fade",
          },
        },
      );
      const secondFrame = withFrameAnimationMetadata(
        newFrameElement({
          x: 0,
          y: 240,
          width: 240,
          height: 180,
          name: "Frame_2",
        }),
        {
          holdMs: 50,
        },
      );
      const secondText = withAnimationMetadata(
        newTextElement({
          text: "NEXT",
          x: secondFrame.x + 40,
          y: secondFrame.y + 50,
          frameId: secondFrame.id,
        }),
        {
          appearance: {
            durationMs: 150,
            style: "typewriter",
          },
        },
      );

      API.updateScene({
        elements: [firstFrame, secondFrame, secondText],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });

      openPresentationMode();
      fireEvent.click(screen.getByTestId("frames-presentation-present"));

      await screen.findByRole("dialog", {
        name: /presenting frame_1\. frame 1 of 2\./i,
      });

      fireEvent.keyDown(document, { key: "Enter" });

      await advancePresentationTime(90);

      await waitFor(() => {
        expect(
          screen.getByRole("dialog", {
            name: /presenting frame_2\. frame 2 of 2\./i,
          }),
        ).not.toBeNull();

        const previewText = getSceneElement<ExcalidrawTextElement>(
          secondText.id,
        );

        expect(previewText?.text.length || 0).toBeGreaterThan(0);
        expect(previewText?.text.length || 0).toBeLessThan(
          secondText.text.length,
        );
      });

      await advancePresentationTime(120);

      await waitFor(() => {
        const previewText = getSceneElement<ExcalidrawTextElement>(
          secondText.id,
        );

        expect(previewText?.text).toBe("NEXT");
        expect(previewText?.opacity).toBe(100);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reveals handwritten text without opacity fade and pauses at punctuation and line breaks", async () => {
    vi.useFakeTimers();

    try {
      await render(
        <Excalidraw frameNavigatorModes={createFrameAnimationModes()} />,
      );

      const firstFrame = withFrameAnimationMetadata(
        newFrameElement({
          x: 0,
          y: 0,
          width: 240,
          height: 180,
          name: "Frame_1",
        }),
        {
          holdMs: 0,
          transition: {
            durationMs: 60,
            easing: "linear",
            fallback: "fade",
          },
        },
      );
      const secondFrame = withFrameAnimationMetadata(
        newFrameElement({
          x: 0,
          y: 240,
          width: 240,
          height: 180,
          name: "Frame_2",
        }),
        {
          holdMs: 50,
        },
      );
      const secondText = withAnimationMetadata(
        newTextElement({
          text: "A,\nB",
          x: secondFrame.x + 40,
          y: secondFrame.y + 50,
          frameId: secondFrame.id,
        }),
        {
          appearance: {
            speed: "fast",
            style: "handwritten",
          },
        },
      );

      API.updateScene({
        elements: [firstFrame, secondFrame, secondText],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });

      openPresentationMode();
      fireEvent.click(screen.getByTestId("frames-presentation-present"));

      await screen.findByRole("dialog", {
        name: /presenting frame_1\. frame 1 of 2\./i,
      });

      fireEvent.keyDown(document, { key: "Enter" });

      let previewText = await advancePresentationUntil(
        () => getSceneElement<ExcalidrawTextElement>(secondText.id),
        (candidate) =>
          candidate?.text === "A" &&
          typeof (
            candidate.customData?.[
              HANDWRITTEN_TEXT_OUTLINE_PREVIEW_CUSTOM_DATA_KEY
            ] as { tailProgress?: number } | undefined
          )?.tailProgress === "number",
        {
          maxAdvanceMs: 600,
        },
      );

      expect(previewText?.text).toBe("A");
      expect(previewText?.opacity).toBe(100);
      expect(
        previewText?.customData?.[
          HANDWRITTEN_TEXT_OUTLINE_PREVIEW_CUSTOM_DATA_KEY
        ],
      ).toEqual(
        expect.objectContaining({
          progress: expect.any(Number),
          tailProgress: expect.any(Number),
        }),
      );
      expect(
        (
          previewText?.customData?.[
            HANDWRITTEN_TEXT_OUTLINE_PREVIEW_CUSTOM_DATA_KEY
          ] as { tailProgress: number }
        ).tailProgress,
      ).toBeLessThan(1);

      previewText = await advancePresentationUntil(
        () => getSceneElement<ExcalidrawTextElement>(secondText.id),
        (candidate) => candidate?.text === "A,",
        {
          maxAdvanceMs: 600,
        },
      );

      expect(previewText?.text).toBe("A,");
      expect(previewText?.opacity).toBe(100);
      expect(
        previewText?.customData?.[
          HANDWRITTEN_TEXT_OUTLINE_PREVIEW_CUSTOM_DATA_KEY
        ],
      ).toEqual(
        expect.objectContaining({
          progress: expect.any(Number),
        }),
      );
      expect(
        (
          previewText?.customData?.[
            HANDWRITTEN_TEXT_OUTLINE_PREVIEW_CUSTOM_DATA_KEY
          ] as { progress: number }
        ).progress,
      ).toBeLessThan(1);

      previewText = await advancePresentationUntil(
        () => getSceneElement<ExcalidrawTextElement>(secondText.id),
        (candidate) => candidate?.text === "A,\n",
        {
          maxAdvanceMs: 240,
        },
      );

      expect(previewText?.text).toBe("A,\n");
      expect(previewText?.opacity).toBe(100);

      previewText = await advancePresentationUntil(
        () => getSceneElement<ExcalidrawTextElement>(secondText.id),
        (candidate) => candidate?.text === "A,\nB",
        {
          maxAdvanceMs: 240,
        },
      );

      expect(previewText?.text).toBe("A,\nB");
      expect(previewText?.opacity).toBe(100);
      expect(
        previewText?.customData?.[
          HANDWRITTEN_TEXT_OUTLINE_PREVIEW_CUSTOM_DATA_KEY
        ],
      ).toEqual(
        expect.objectContaining({
          progress: expect.any(Number),
        }),
      );

      previewText = await advancePresentationUntil(
        () => getSceneElement<ExcalidrawTextElement>(secondText.id),
        (candidate) =>
          candidate?.text === "A,\nB" &&
          (
            candidate.customData?.[
              HANDWRITTEN_TEXT_OUTLINE_PREVIEW_CUSTOM_DATA_KEY
            ] as { progress?: number } | undefined
          )?.progress === 1,
        {
          maxAdvanceMs: 240,
        },
      );

      expect(previewText?.text).toBe("A,\nB");
      expect(previewText?.opacity).toBe(100);
      expect(
        previewText?.customData?.[
          HANDWRITTEN_TEXT_OUTLINE_PREVIEW_CUSTOM_DATA_KEY
        ],
      ).toEqual({ progress: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the Presentation mode without playback preview controls", async () => {
    await render(
      <Excalidraw frameNavigatorModes={createFrameAnimationModes()} />,
    );

    fireEvent.click(screen.getByTestId("frames-window-trigger"));

    expect(screen.queryByTestId("frames-window-mode-playback")).toBeNull();

    fireEvent.click(screen.getByTestId("frames-window-mode-presentation"));

    expect(
      screen.getByTestId("frames-window-mode-panel-presentation"),
    ).not.toBeNull();
    expect(screen.queryByTestId("frames-playback-range")).toBeNull();
    expect(screen.queryByTestId("frames-playback-diagnostics")).toBeNull();
  });

  it("defaults the automation toggle to unchecked and waits for input before advancing", async () => {
    vi.useFakeTimers();

    try {
      await render(
        <Excalidraw frameNavigatorModes={createFrameAnimationModes()} />,
      );

      const firstFrame = withFrameAnimationMetadata(
        newFrameElement({
          x: 0,
          y: 0,
          width: 240,
          height: 180,
          name: "Frame_1",
        }),
        {
          holdMs: 200,
          transition: {
            durationMs: 100,
            easing: "linear",
            fallback: "fade",
          },
        },
      );
      const secondFrame = newFrameElement({
        x: 0,
        y: 240,
        width: 240,
        height: 180,
        name: "Frame_2",
      });

      API.updateScene({
        elements: [firstFrame, secondFrame],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });

      openPresentationMode();
      const toggle = setPresentationAutomation(false);

      expect(toggle.checked).toBe(false);

      fireEvent.click(screen.getByTestId("frames-presentation-present"));

      await screen.findByRole("dialog", {
        name: /presenting frame_1\. frame 1 of 2\./i,
      });

      await advancePresentationTime(500);

      expect(
        screen.getByRole("dialog", {
          name: /presenting frame_1\. frame 1 of 2\./i,
        }),
      ).not.toBeNull();

      fireEvent.keyDown(document, { key: "Enter" });

      await advancePresentationTime(125);

      await waitFor(() => {
        expect(
          screen.getByRole("dialog", {
            name: /presenting frame_2\. frame 2 of 2\./i,
          }),
        ).not.toBeNull();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-advances through authored hold and transition timing when enabled", async () => {
    vi.useFakeTimers();

    try {
      await render(
        <Excalidraw frameNavigatorModes={createFrameAnimationModes()} />,
      );

      const firstFrame = withFrameAnimationMetadata(
        newFrameElement({
          x: 0,
          y: 0,
          width: 240,
          height: 180,
          name: "Frame_1",
        }),
        {
          holdMs: 100,
          transition: {
            durationMs: 100,
            easing: "linear",
            fallback: "fade",
          },
        },
      );
      const secondFrame = newFrameElement({
        x: 0,
        y: 240,
        width: 240,
        height: 180,
        name: "Frame_2",
      });

      API.updateScene({
        elements: [firstFrame, secondFrame],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });

      openPresentationMode();
      const toggle = setPresentationAutomation(true);

      expect(toggle.checked).toBe(true);

      fireEvent.click(screen.getByTestId("frames-presentation-present"));

      await screen.findByRole("dialog", {
        name: /presenting frame_1\. frame 1 of 2\./i,
      });

      await advancePresentationTime(260);

      await waitFor(() => {
        expect(
          screen.getByRole("dialog", {
            name: /presenting frame_2\. frame 2 of 2\./i,
          }),
        ).not.toBeNull();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes linked presentation seeds to the earliest linked frame element", async () => {
    vi.useFakeTimers();

    try {
      await render(
        <Excalidraw frameNavigatorModes={createFrameAnimationModes()} />,
      );

      const firstFrame = withFrameAnimationMetadata(
        newFrameElement({
          x: 0,
          y: 0,
          width: 240,
          height: 180,
          name: "Frame_1",
        }),
        {
          holdMs: 0,
          transition: {
            durationMs: 100,
            easing: "linear",
            fallback: "fade",
          },
        },
      );
      const secondFrame = withFrameAnimationMetadata(
        newFrameElement({
          x: 1200,
          y: 900,
          width: 240,
          height: 180,
          name: "Frame_2",
        }),
        {
          holdMs: 100,
        },
      );
      const firstRect = withAnimationMetadata(
        {
          ...newElement({
            type: "rectangle",
            x: firstFrame.x + 20,
            y: firstFrame.y + 30,
            width: 70,
            height: 50,
            frameId: firstFrame.id,
          }),
          seed: 111,
        },
        {
          linkId: "stable-render-seed",
        },
      );
      const secondRect = withAnimationMetadata(
        {
          ...newElement({
            type: "rectangle",
            x: secondFrame.x + 40,
            y: secondFrame.y + 60,
            width: 100,
            height: 60,
            frameId: secondFrame.id,
          }),
          seed: 999,
        },
        {
          linkId: "stable-render-seed",
        },
      );

      API.updateScene({
        elements: [firstFrame, secondFrame, firstRect, secondRect],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });

      openPresentationMode();
      fireEvent.click(screen.getByTestId("frames-presentation-present"));

      await screen.findByRole("dialog", {
        name: /presenting frame_1\. frame 1 of 2\./i,
      });

      fireEvent.keyDown(document, { key: "Enter" });

      await advancePresentationTime(120);

      await waitFor(() => {
        const previewRect = getSceneElement(secondRect.id);

        expect(
          screen.getByRole("dialog", {
            name: /presenting frame_2\. frame 2 of 2\./i,
          }),
        ).not.toBeNull();
        expect(previewRect?.seed).toBe(firstRect.seed);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps linked elements stationary during presenter transitions when local positions match", async () => {
    vi.useFakeTimers();

    try {
      await render(
        <Excalidraw frameNavigatorModes={createFrameAnimationModes()} />,
      );

      const firstFrame = withFrameAnimationMetadata(
        newFrameElement({
          x: 0,
          y: 0,
          width: 240,
          height: 180,
          name: "Frame_1",
        }),
        {
          holdMs: 0,
          transition: {
            durationMs: 400,
            easing: "linear",
            fallback: "fade",
          },
        },
      );
      const secondFrame = newFrameElement({
        x: 1200,
        y: 900,
        width: 240,
        height: 180,
        name: "Frame_2",
      });
      const sourceRect = withAnimationMetadata(
        newElement({
          type: "rectangle",
          x: firstFrame.x + 20,
          y: firstFrame.y + 30,
          width: 40,
          height: 40,
          frameId: firstFrame.id,
        }),
        {
          linkId: "rect-link-static",
        },
      );
      const targetRect = withAnimationMetadata(
        newElement({
          type: "rectangle",
          x: secondFrame.x + 20,
          y: secondFrame.y + 30,
          width: 40,
          height: 40,
          frameId: secondFrame.id,
        }),
        {
          linkId: "rect-link-static",
        },
      );

      API.updateScene({
        elements: [firstFrame, secondFrame, sourceRect, targetRect],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });

      openPresentationMode();
      fireEvent.click(screen.getByTestId("frames-presentation-present"));

      await screen.findByRole("dialog", {
        name: /presenting frame_1\. frame 1 of 2\./i,
      });

      fireEvent.keyDown(document, { key: "Enter" });

      await advancePresentationTime(160);

      const previewRect = getSceneElement(sourceRect.id);
      expect(previewRect).toEqual(
        expect.objectContaining({
          x: firstFrame.x + 20,
          y: firstFrame.y + 30,
          width: 40,
          height: 40,
          opacity: 100,
          isDeleted: false,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("interpolates linked generic elements during presenter transitions", async () => {
    vi.useFakeTimers();

    try {
      await render(
        <Excalidraw frameNavigatorModes={createFrameAnimationModes()} />,
      );

      const firstFrame = withFrameAnimationMetadata(
        newFrameElement({
          x: 0,
          y: 0,
          width: 240,
          height: 180,
          name: "Frame_1",
        }),
        {
          holdMs: 0,
          transition: {
            durationMs: 400,
            easing: "linear",
            fallback: "fade",
          },
        },
      );
      const secondFrame = newFrameElement({
        x: 1200,
        y: 900,
        width: 240,
        height: 180,
        name: "Frame_2",
      });
      const sourceRect = withAnimationMetadata(
        newElement({
          type: "rectangle",
          x: firstFrame.x + 20,
          y: firstFrame.y + 30,
          width: 40,
          height: 40,
          frameId: firstFrame.id,
        }),
        {
          linkId: "rect-link",
        },
      );
      const targetRect = withAnimationMetadata(
        newElement({
          type: "rectangle",
          x: secondFrame.x + 80,
          y: secondFrame.y + 90,
          width: 100,
          height: 60,
          frameId: secondFrame.id,
        }),
        {
          linkId: "rect-link",
        },
      );

      API.updateScene({
        elements: [firstFrame, secondFrame, sourceRect, targetRect],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });

      openPresentationMode();
      fireEvent.click(screen.getByTestId("frames-presentation-present"));

      await screen.findByRole("dialog", {
        name: /presenting frame_1\. frame 1 of 2\./i,
      });

      fireEvent.keyDown(document, { key: "Enter" });

      await advancePresentationTime(160);

      const previewRect = getSceneElement(sourceRect.id);
      expect(previewRect?.x).toBeCloseTo(44, 0);
      expect(previewRect?.y).toBeCloseTo(54, 0);
      expect(previewRect?.width).toBeCloseTo(64, 0);
      expect(previewRect?.height).toBeCloseTo(48, 0);
      expect(previewRect?.opacity).toBe(100);
      expect(previewRect?.isDeleted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
