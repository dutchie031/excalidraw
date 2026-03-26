import React from "react";

import { CODES, FONT_FAMILY } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/element";

import { copiedStyles } from "../actions/actionStyles";
import { Excalidraw } from "../index";
import { API } from "../tests/helpers/api";
import { Keyboard, Pointer, UI } from "../tests/helpers/ui";
import {
  act,
  fireEvent,
  render,
  screen,
  togglePopover,
} from "../tests/test-utils";

const { h } = window;

const mouse = new Pointer("mouse");

describe("actionStyles", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  afterEach(async () => {
    // https://github.com/floating-ui/floating-ui/issues/1908#issuecomment-1301553793
    // affects node v16+
    await act(async () => {});
  });

  it("should copy & paste styles via keyboard", async () => {
    UI.clickTool("rectangle");
    mouse.down(10, 10);
    mouse.up(20, 20);

    UI.clickTool("rectangle");
    mouse.down(10, 10);
    mouse.up(20, 20);

    // Change some styles of second rectangle
    togglePopover("Stroke");
    UI.clickOnTestId("color-red");
    togglePopover("Background");
    UI.clickOnTestId("color-blue");
    // Fill style
    fireEvent.click(screen.getByTitle("Cross-hatch"));
    // Stroke width
    fireEvent.click(screen.getByTitle("Bold"));
    // Stroke style
    fireEvent.click(screen.getByTitle("Dotted"));
    // Roughness
    fireEvent.click(screen.getByTitle("Cartoonist"));
    // Opacity
    fireEvent.change(screen.getByTestId("opacity"), {
      target: { value: "60" },
    });

    mouse.reset();

    API.setSelectedElements([h.elements[1]]);

    Keyboard.withModifierKeys({ ctrl: true, alt: true }, () => {
      Keyboard.codeDown(CODES.C);
    });
    const secondRect = JSON.parse(copiedStyles)[0];
    expect(secondRect.id).toBe(h.elements[1].id);

    mouse.reset();
    // Paste styles to first rectangle
    API.setSelectedElements([h.elements[0]]);
    Keyboard.withModifierKeys({ ctrl: true, alt: true }, () => {
      Keyboard.codeDown(CODES.V);
    });

    const firstRect = API.getSelectedElement();
    expect(firstRect.id).toBe(h.elements[0].id);
    expect(firstRect.strokeColor).toBe("#e03131");
    expect(firstRect.backgroundColor).toBe("#a5d8ff");
    expect(firstRect.fillStyle).toBe("cross-hatch");
    expect(firstRect.strokeWidth).toBe(2); // Bold: 2
    expect(firstRect.strokeStyle).toBe("dotted");
    expect(firstRect.roughness).toBe(2); // Cartoonist: 2
    expect(firstRect.opacity).toBe(60);
  });

  it("stores drawing animation defaults on new elements and updates selected elements", async () => {
    UI.clickTool("rectangle");

    fireEvent.click(screen.getByTestId("drawing-animation-style-none"));

    mouse.down(10, 10);
    mouse.up(20, 20);

    let rectangle = API.getSelectedElement();

    expect(h.state.currentItemDrawingAnimationStyle).toBe("none");
    expect(rectangle.customData?.excalidrawSyncAnimation).toEqual({
      appearance: { style: "none" },
    });

    fireEvent.click(screen.getByTestId("drawing-animation-style-draw"));
    fireEvent.change(screen.getByTestId("drawing-animation-duration"), {
      target: { value: "900" },
    });

    rectangle = API.getSelectedElement();

    expect(screen.queryByTestId("drawing-animation-delay")).toBeNull();
    expect(rectangle.customData?.excalidrawSyncAnimation).toEqual({
      appearance: {
        style: "draw",
        durationMs: 900,
      },
    });
  });

  it("does not persist draw metadata on text in mixed selections", async () => {
    const rectangle = API.createElement({
      type: "rectangle",
      x: 10,
      y: 10,
      width: 120,
      height: 80,
    });
    const text = API.createElement({
      type: "text",
      x: 200,
      y: 30,
      text: "HELLO",
      fontFamily: FONT_FAMILY.Cascadia,
    });

    API.updateScene({
      elements: [rectangle, text],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements([rectangle, text]);

    fireEvent.click(screen.getByTestId("drawing-animation-style-draw"));

    expect(
      API.getElement(rectangle).customData?.excalidrawSyncAnimation,
    ).toEqual({
      appearance: {
        style: "draw",
      },
    });
    expect(API.getElement(text).customData?.excalidrawSyncAnimation).toBe(
      undefined,
    );
  });

  it("shows text speed presets instead of a duration slider for text selections", async () => {
    const text = API.createElement({
      type: "text",
      x: 40,
      y: 40,
      text: "HELLO",
      fontFamily: FONT_FAMILY.Excalifont,
    });

    API.updateScene({
      elements: [text],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    API.setSelectedElements([text]);

    expect(screen.queryByTestId("drawing-animation-duration")).toBeNull();
    expect(screen.getByTestId("drawing-animation-speed-fast")).not.toBeNull();
    expect(screen.getByTestId("drawing-animation-speed-normal")).not.toBeNull();
    expect(screen.getByTestId("drawing-animation-speed-slow")).not.toBeNull();

    fireEvent.click(screen.getByTestId("drawing-animation-style-handwritten"));
    fireEvent.click(screen.getByTestId("drawing-animation-speed-slow"));

    expect(h.state.currentItemDrawingAnimationSpeed).toBe("slow");
    expect(API.getElement(text).customData?.excalidrawSyncAnimation).toEqual({
      appearance: {
        style: "handwritten",
        speed: "slow",
      },
    });
  });
});
