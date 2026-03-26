import clsx from "clsx";
import { Fragment, useEffect, useMemo, useState, type DragEvent } from "react";

import {
  CaptureUpdateAction,
  newElementWith,
  type CaptureUpdateActionType,
} from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
} from "@excalidraw/element/types";

import { useUIAppState } from "../../context/ui-appState";
import {
  FRAME_ASPECT_RATIO_PRESETS,
  applyCanonicalFrameNames,
  createFrameToRightOfLastFrame,
  duplicateFrameUnderneath,
  getFrameHeightForAspectRatio,
  getCanonicalFrameName,
  getMasterNormalFrame,
  getOrderedNormalFrames,
  reorderFrameIds,
  selectAndFocusFrame,
  syncNormalFramesToMasterSize,
  type FrameDropPosition,
} from "../../frameNavigator";
import { t } from "../../i18n";
import {
  useApp,
  useExcalidrawElements,
  useExcalidrawSetAppState,
} from "../App";
import {
  CloseIcon,
  DuplicateIcon,
  PlusIcon,
  frameToolIcon,
  resizeIcon,
} from "../icons";

import "./FramesNavigator.scss";

import type {
  App as ExcalidrawApp,
  FramesNavigatorModeDefinition,
  FramesNavigatorModeRenderContext,
} from "../../types";

const FRAMES_WINDOW_MIN_WIDTH = 320;
const FRAMES_WINDOW_MIN_HEIGHT = 280;
const FRAMES_WINDOW_DEFAULT_WIDTH = 360;
const FRAMES_WINDOW_DEFAULT_HEIGHT = 460;
const FRAMES_WINDOW_MARGIN = 16;
const FRAMES_WINDOW_DEFAULT_MODE_ID = "frames";

type FramesWindowBounds = {
  width: number;
  height: number;
};

type FramesWindowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type FramesWindowInteraction =
  | {
      type: "drag";
      originRect: FramesWindowRect;
      startClientX: number;
      startClientY: number;
    }
  | {
      type: "resize";
      originRect: FramesWindowRect;
      startClientX: number;
      startClientY: number;
    }
  | null;

const getFramesWindowBounds = (): FramesWindowBounds => {
  if (typeof window === "undefined") {
    return { width: 1200, height: 800 };
  }

  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
};

export const clampFramesWindowRect = (
  rect: FramesWindowRect,
  bounds: FramesWindowBounds,
): FramesWindowRect => {
  const width = Math.min(
    Math.max(rect.width, FRAMES_WINDOW_MIN_WIDTH),
    Math.max(FRAMES_WINDOW_MIN_WIDTH, bounds.width - FRAMES_WINDOW_MARGIN * 2),
  );
  const height = Math.min(
    Math.max(rect.height, FRAMES_WINDOW_MIN_HEIGHT),
    Math.max(
      FRAMES_WINDOW_MIN_HEIGHT,
      bounds.height - FRAMES_WINDOW_MARGIN * 2,
    ),
  );

  return {
    width,
    height,
    x: Math.min(
      Math.max(rect.x, FRAMES_WINDOW_MARGIN),
      Math.max(
        FRAMES_WINDOW_MARGIN,
        bounds.width - width - FRAMES_WINDOW_MARGIN,
      ),
    ),
    y: Math.min(
      Math.max(rect.y, FRAMES_WINDOW_MARGIN),
      Math.max(
        FRAMES_WINDOW_MARGIN,
        bounds.height - height - FRAMES_WINDOW_MARGIN,
      ),
    ),
  };
};

export const getDefaultFramesWindowRect = (
  bounds: FramesWindowBounds,
): FramesWindowRect => {
  return clampFramesWindowRect(
    {
      x: bounds.width - FRAMES_WINDOW_DEFAULT_WIDTH - FRAMES_WINDOW_MARGIN,
      y: 72,
      width: FRAMES_WINDOW_DEFAULT_WIDTH,
      height: Math.min(
        FRAMES_WINDOW_DEFAULT_HEIGHT,
        bounds.height - FRAMES_WINDOW_MARGIN * 2,
      ),
    },
    bounds,
  );
};

const getDropPosition = (
  event: DragEvent<HTMLDivElement>,
): FrameDropPosition => {
  const { top, height } = event.currentTarget.getBoundingClientRect();
  return event.clientY >= top + height / 2 ? "after" : "before";
};

const setDataTransferValue = (
  dataTransfer: DataTransfer,
  key: "effectAllowed" | "dropEffect",
  value: "move",
) => {
  try {
    dataTransfer[key] = value;
  } catch {
    // jsdom exposes these properties as read-only.
  }
};

export const FramesNavigator = () => {
  const app = useApp() as ExcalidrawApp;
  const elements = useExcalidrawElements();
  const appState = useUIAppState();
  const setAppState = useExcalidrawSetAppState();
  const customModes = useMemo<readonly FramesNavigatorModeDefinition[]>(() => {
    return app.props.frameNavigatorModes || [];
  }, [app.props.frameNavigatorModes]);

  const orderedFrames = useMemo(() => {
    return getOrderedNormalFrames(elements);
  }, [elements]);

  const orderedFrameIds = orderedFrames.map((frame) => frame.id);
  const masterFrame = orderedFrames[0] || null;

  const [isOpen, setIsOpen] = useState(false);
  const [draggedFrameId, setDraggedFrameId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    frameId: string;
    position: FrameDropPosition;
  } | null>(null);
  const initialRect = useMemo(() => {
    return getDefaultFramesWindowRect(getFramesWindowBounds());
  }, []);
  const [rect, setRect] = useState<FramesWindowRect>(initialRect);
  const [interaction, setInteraction] = useState<FramesWindowInteraction>(null);
  const [activeModeId, setActiveModeId] = useState(
    FRAMES_WINDOW_DEFAULT_MODE_ID,
  );

  useEffect(() => {
    if (activeModeId === FRAMES_WINDOW_DEFAULT_MODE_ID) {
      return;
    }

    if (customModes.some((mode) => mode.id === activeModeId)) {
      return;
    }

    setActiveModeId(FRAMES_WINDOW_DEFAULT_MODE_ID);
  }, [activeModeId, customModes]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleResize = () => {
      setRect((currentRect) => {
        return clampFramesWindowRect(currentRect, getFramesWindowBounds());
      });
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!interaction || !isOpen) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const deltaX = event.clientX - interaction.startClientX;
      const deltaY = event.clientY - interaction.startClientY;
      const bounds = getFramesWindowBounds();

      setRect(() => {
        if (interaction.type === "drag") {
          return clampFramesWindowRect(
            {
              ...interaction.originRect,
              x: interaction.originRect.x + deltaX,
              y: interaction.originRect.y + deltaY,
            },
            bounds,
          );
        }

        return clampFramesWindowRect(
          {
            ...interaction.originRect,
            width: interaction.originRect.width + deltaX,
            height: interaction.originRect.height + deltaY,
          },
          bounds,
        );
      });
    };

    const handlePointerUp = () => {
      setInteraction(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [interaction, isOpen]);

  const clearDragState = () => {
    setDraggedFrameId(null);
    setDropTarget(null);
  };

  const commitSceneElements = (
    nextElements: readonly ExcalidrawElement[],
    captureUpdate: CaptureUpdateActionType = CaptureUpdateAction.IMMEDIATELY,
  ) => {
    app.updateScene({
      elements: nextElements,
      captureUpdate,
    });
  };

  const selectAndFocusElementIds = (
    elementIds: readonly ExcalidrawElement["id"][],
    options?: {
      fitToViewport?: boolean;
    },
  ) => {
    const uniqueElementIds = [...new Set(elementIds)];
    const elementsMap = app.scene.getNonDeletedElementsMap();
    const selectedElements = uniqueElementIds.flatMap((elementId) => {
      const element = elementsMap.get(elementId);
      return element ? [element] : [];
    });

    if (!selectedElements.length) {
      return;
    }

    setAppState({
      selectedElementIds: Object.fromEntries(
        selectedElements.map((element) => [element.id, true]),
      ),
      selectedGroupIds: {},
    });

    app.scrollToContent(
      selectedElements.length === 1 ? selectedElements[0] : selectedElements,
      {
        fitToViewport: options?.fitToViewport ?? true,
        animate: true,
        canvasOffsets: app.getEditorUIOffsets(),
      },
    );
  };

  const activeCustomMode =
    customModes.find((mode) => mode.id === activeModeId) || null;

  const modeContext: FramesNavigatorModeRenderContext = {
    activeModeId,
    appState,
    closeWindow: () => setIsOpen(false),
    commitSceneElements,
    elements: app.scene.getElementsIncludingDeleted(),
    notify: (message: string) => {
      app.setToast({ message });
    },
    orderedFrameIds,
    orderedFrames,
    selectAndFocusElementIds,
    selectAndFocusFrame: (frame: ExcalidrawFrameElement) => {
      selectAndFocusFrame({
        app,
        frame,
        setAppState,
      });
    },
    setActiveMode: setActiveModeId,
  };

  const customModeActions = customModes.flatMap((mode) => {
    if (!mode.renderWindowAction) {
      return [];
    }

    const action = mode.renderWindowAction(modeContext);
    return action ? [<Fragment key={mode.id}>{action}</Fragment>] : [];
  });

  const handleCreateFrame = () => {
    const nextScene = createFrameToRightOfLastFrame({
      elements: app.scene.getElementsIncludingDeleted(),
      orderedFrames,
      orderedFrameIds,
    });

    if (!nextScene) {
      return;
    }

    commitSceneElements(nextScene.elements);
  };

  const handleDuplicateFrame = (frame: ExcalidrawFrameElement) => {
    const prevElements = app.scene.getElementsIncludingDeleted();
    const nextScene = duplicateFrameUnderneath({
      elements: prevElements,
      frame,
      orderedFrameIds,
    });

    if (!nextScene) {
      return;
    }

    let nextElements = nextScene.elements;

    if (app.props.onFrameDuplicate) {
      const mappedElements = app.props.onFrameDuplicate({
        duplicatedFrame: nextScene.duplicatedFrame,
        nextElements,
        origIdToDuplicateId: nextScene.origIdToDuplicateId,
        prevElements,
        sourceFrame: frame,
      });

      if (mappedElements) {
        nextElements = mappedElements;
      }
    }

    commitSceneElements(nextElements);
  };

  const handleApplyFrameAspectRatio = (
    presetId: typeof FRAME_ASPECT_RATIO_PRESETS[number]["id"],
  ) => {
    const currentMasterFrame = getMasterNormalFrame(
      app.scene.getElementsIncludingDeleted(),
    );

    if (!currentMasterFrame) {
      return;
    }

    const sceneElements = app.scene.getElementsIncludingDeleted();
    const nextHeight = getFrameHeightForAspectRatio(
      currentMasterFrame.width,
      presetId,
    );
    const nextElements = syncNormalFramesToMasterSize({
      elements: sceneElements.map((element) => {
        if (element.id !== currentMasterFrame.id || element.type !== "frame") {
          return element;
        }

        return newElementWith(element, {
          height: nextHeight,
        });
      }),
      masterFrameId: currentMasterFrame.id,
      referenceElements: sceneElements,
    });

    if (nextElements === sceneElements) {
      return;
    }

    commitSceneElements(nextElements);
  };

  const handleDrop = (frameId: string, position: FrameDropPosition) => {
    if (!draggedFrameId) {
      clearDragState();
      return;
    }

    const nextOrderedFrameIds = reorderFrameIds(
      orderedFrameIds,
      draggedFrameId,
      frameId,
      position,
    );

    const nextElements = applyCanonicalFrameNames(
      app.scene.getElementsIncludingDeleted(),
      nextOrderedFrameIds,
    );

    if (nextElements.didChange) {
      commitSceneElements(nextElements.elements);
    }

    clearDragState();
  };

  return (
    <>
      <button
        type="button"
        className="frames-navigator__trigger"
        title={t("frameNavigator.title")}
        aria-label={t("frameNavigator.title")}
        aria-pressed={isOpen}
        data-testid="frames-window-trigger"
        onClick={() => setIsOpen((open) => !open)}
      >
        <span className="frames-navigator__trigger-icon">{frameToolIcon}</span>
        <span>{t("frameNavigator.title")}</span>
      </button>

      {isOpen && (
        <div
          className="frames-window"
          data-testid="frames-window"
          role="dialog"
          aria-label={t("frameNavigator.title")}
          style={{
            left: `${rect.x}px`,
            top: `${rect.y}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          }}
        >
          <div
            className="frames-window__header"
            data-testid="frames-window-header"
            onPointerDown={(event) => {
              if ((event.target as HTMLElement).closest("button")) {
                return;
              }

              event.preventDefault();
              setInteraction({
                type: "drag",
                originRect: rect,
                startClientX: event.clientX,
                startClientY: event.clientY,
              });
            }}
          >
            <div className="frames-sidebar__title">
              <span className="frames-sidebar__title-icon">
                {frameToolIcon}
              </span>
              <span>{t("frameNavigator.title")}</span>
            </div>
            <div className="frames-window__header-buttons">
              <button
                type="button"
                className="frames-window__header-button"
                data-testid="frames-window-close"
                aria-label={t("buttons.close")}
                title={t("buttons.close")}
                onClick={() => setIsOpen(false)}
              >
                {CloseIcon}
              </button>
            </div>
          </div>

          <div className="frames-window__body">
            <div className="frames-sidebar" data-testid="frames-sidebar">
              {customModes.length ? (
                <div className="frames-window__mode-switcher" role="toolbar">
                  <button
                    type="button"
                    className={clsx("frames-window__mode-button", {
                      "is-active":
                        activeModeId === FRAMES_WINDOW_DEFAULT_MODE_ID,
                    })}
                    data-testid="frames-window-mode-frames"
                    onClick={() =>
                      setActiveModeId(FRAMES_WINDOW_DEFAULT_MODE_ID)
                    }
                  >
                    {t("frameNavigator.title")}
                  </button>
                  {customModes.map((mode) => {
                    return (
                      <button
                        key={mode.id}
                        type="button"
                        className={clsx("frames-window__mode-button", {
                          "is-active": activeModeId === mode.id,
                        })}
                        data-testid={`frames-window-mode-${mode.id}`}
                        onClick={() => setActiveModeId(mode.id)}
                      >
                        {mode.label}
                      </button>
                    );
                  })}
                  {customModeActions.length ? (
                    <div className="frames-window__mode-actions">
                      {customModeActions}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {activeCustomMode ? (
                <div
                  className="frames-window__mode-content"
                  data-testid={`frames-window-mode-panel-${activeCustomMode.id}`}
                >
                  {activeCustomMode.render(modeContext)}
                </div>
              ) : (
                <>
                  <div className="frames-sidebar__toolbar">
                    <button
                      type="button"
                      className="frames-sidebar__primary-action"
                      data-testid="new-frame-button"
                      onClick={handleCreateFrame}
                      disabled={!orderedFrames.length}
                    >
                      <span className="frames-sidebar__primary-action-icon">
                        {PlusIcon}
                      </span>
                      <span>{t("frameNavigator.newFrame")}</span>
                    </button>

                    <div className="frames-sidebar__ratio-toolbar">
                      <span className="frames-sidebar__ratio-label">
                        {t("frameNavigator.aspectRatios")}
                      </span>
                      <div
                        className="frames-sidebar__ratio-buttons"
                        role="toolbar"
                        aria-label={t("frameNavigator.aspectRatios")}
                      >
                        {FRAME_ASPECT_RATIO_PRESETS.map((preset) => {
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              className="frames-sidebar__ratio-button"
                              data-testid={`frame-ratio-${preset.id.replace(
                                ":",
                                "-",
                              )}`}
                              onClick={() =>
                                handleApplyFrameAspectRatio(preset.id)
                              }
                              disabled={!masterFrame}
                            >
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {orderedFrames.length ? (
                    <div className="frames-sidebar__list" role="list">
                      {orderedFrames.map((frame, index) => {
                        const isDropTarget = dropTarget?.frameId === frame.id;
                        const frameLabel =
                          frame.name || getCanonicalFrameName(index + 1);

                        return (
                          <div
                            key={frame.id}
                            role="listitem"
                            className={clsx("frames-sidebar__row", {
                              "is-active":
                                !!appState.selectedElementIds[frame.id],
                              "is-dragging": draggedFrameId === frame.id,
                            })}
                            data-drop-position={
                              isDropTarget ? dropTarget?.position : undefined
                            }
                            data-frame-id={frame.id}
                            data-testid={`frame-row-${frame.id}`}
                            draggable={orderedFrames.length > 1}
                            onDragStart={(event) => {
                              setDataTransferValue(
                                event.dataTransfer,
                                "effectAllowed",
                                "move",
                              );
                              event.dataTransfer.setData(
                                "text/plain",
                                frame.id,
                              );
                              setDraggedFrameId(frame.id);
                              setDropTarget(null);
                            }}
                            onDragEnd={clearDragState}
                            onDragLeave={() => {
                              setDropTarget((currentTarget) => {
                                return currentTarget?.frameId === frame.id
                                  ? null
                                  : currentTarget;
                              });
                            }}
                            onDragOver={(event) => {
                              if (!draggedFrameId) {
                                return;
                              }

                              event.preventDefault();
                              setDataTransferValue(
                                event.dataTransfer,
                                "dropEffect",
                                "move",
                              );

                              const position = getDropPosition(event);
                              setDropTarget((currentTarget) => {
                                if (
                                  currentTarget?.frameId === frame.id &&
                                  currentTarget?.position === position
                                ) {
                                  return currentTarget;
                                }

                                return {
                                  frameId: frame.id,
                                  position,
                                };
                              });
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              handleDrop(frame.id, getDropPosition(event));
                            }}
                          >
                            <button
                              type="button"
                              className="frames-sidebar__row-main"
                              aria-current={
                                appState.selectedElementIds[frame.id] ||
                                undefined
                              }
                              onClick={() => {
                                selectAndFocusFrame({
                                  app,
                                  frame,
                                  setAppState,
                                });
                              }}
                              title={frameLabel}
                            >
                              <span className="frames-sidebar__row-icon">
                                {frameToolIcon}
                              </span>
                              <span className="frames-sidebar__row-label">
                                {frameLabel}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="frames-sidebar__row-action"
                              data-testid={`duplicate-frame-${frame.id}`}
                              onClick={() => handleDuplicateFrame(frame)}
                              title={t("labels.duplicateSelection")}
                              aria-label={`${t(
                                "labels.duplicateSelection",
                              )} ${frameLabel}`}
                            >
                              <span className="frames-sidebar__row-action-icon">
                                {DuplicateIcon}
                              </span>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="frames-sidebar__empty">
                      {t("frameNavigator.empty")}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          <button
            type="button"
            className="frames-window__resize-handle"
            data-testid="frames-window-resize"
            aria-label={t("frameNavigator.resize")}
            title={t("frameNavigator.resize")}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setInteraction({
                type: "resize",
                originRect: rect,
                startClientX: event.clientX,
                startClientY: event.clientY,
              });
            }}
          >
            {resizeIcon}
          </button>
        </div>
      )}
    </>
  );
};
