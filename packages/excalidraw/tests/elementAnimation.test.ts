import { FONT_FAMILY } from "@excalidraw/common";

import {
  buildElementDrawingAnimation,
  getDefaultDrawingAnimationStyleForElement,
  getElementTextRevealSpeed,
  getTextRevealSpeedForDuration,
  normalizeAnimationMetadata,
  resolveDrawingAnimationStyleForElement,
} from "../elementAnimation";

describe("elementAnimation", () => {
  it("maps automatic text defaults from font family", () => {
    expect(
      getDefaultDrawingAnimationStyleForElement({
        elementType: "text",
        fontFamily: FONT_FAMILY.Excalifont,
      }),
    ).toBe("handwritten");

    expect(
      getDefaultDrawingAnimationStyleForElement({
        elementType: "text",
        fontFamily: FONT_FAMILY.Cascadia,
      }),
    ).toBe("typewriter");

    expect(
      getDefaultDrawingAnimationStyleForElement({
        elementType: "rectangle",
      }),
    ).toBe("draw");
  });

  it("keeps explicit overrides and omits default automatic metadata", () => {
    expect(
      buildElementDrawingAnimation({
        choice: "automatic",
        elementType: "rectangle",
      }),
    ).toBeNull();

    expect(
      buildElementDrawingAnimation({
        choice: "none",
        elementType: "rectangle",
      }),
    ).toEqual({ style: "none" });

    expect(
      buildElementDrawingAnimation({
        choice: "automatic",
        durationMs: 900,
        elementType: "text",
        fontFamily: FONT_FAMILY.Helvetica,
      }),
    ).toEqual({ speed: "slow" });
  });

  it("normalizes unsupported text draw choices back to text defaults", () => {
    expect(
      buildElementDrawingAnimation({
        choice: "draw",
        elementType: "text",
        fontFamily: FONT_FAMILY.Helvetica,
      }),
    ).toBeNull();

    expect(
      buildElementDrawingAnimation({
        choice: "draw",
        durationMs: 900,
        elementType: "text",
        fontFamily: FONT_FAMILY.Helvetica,
      }),
    ).toEqual({ speed: "slow" });

    expect(
      resolveDrawingAnimationStyleForElement({
        choice: "draw",
        elementType: "text",
        fontFamily: FONT_FAMILY.Excalifont,
      }),
    ).toBe("handwritten");

    expect(
      resolveDrawingAnimationStyleForElement({
        choice: "draw",
        elementType: "text",
        fontFamily: FONT_FAMILY.Cascadia,
      }),
    ).toBe("typewriter");
  });

  it("preserves frame reveal delay metadata while stripping legacy appearance fields", () => {
    expect(
      normalizeAnimationMetadata({
        appearance: {
          delayMs: 120,
          durationMs: 900,
          order: 3,
          speed: "slow",
          style: "handwritten",
        } as any,
        revealDelayMs: 250,
      }),
    ).toEqual({
      appearance: {
        durationMs: 900,
        speed: "slow",
        style: "handwritten",
      },
      revealDelayMs: 250,
    });
  });

  it("maps legacy text durations to speed presets for compatibility", () => {
    expect(getTextRevealSpeedForDuration(200)).toBe("fast");
    expect(getTextRevealSpeedForDuration(600)).toBe("normal");
    expect(getTextRevealSpeedForDuration(900)).toBe("slow");

    expect(
      getElementTextRevealSpeed({
        type: "text",
        customData: {
          excalidrawSyncAnimation: {
            appearance: {
              speed: "fast",
            },
          },
        },
      } as any),
    ).toBe("fast");

    expect(
      getElementTextRevealSpeed({
        type: "text",
        customData: {
          excalidrawSyncAnimation: {
            appearance: {
              durationMs: 900,
            },
          },
        },
      } as any),
    ).toBe("slow");
  });
});