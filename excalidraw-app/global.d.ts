import "@excalidraw/excalidraw/global";
import "@excalidraw/excalidraw/css";

declare global {
  interface Window {
    __EXCALIDRAW_SHA__: string | undefined;
    EXCALIDRAW_THROTTLE_RENDER: boolean | undefined;
  }
}

export {};
