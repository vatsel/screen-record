/* The shapes passed between the modules. No behaviour lives here. */

// One of macOS's own cursors, rasterized at the recording's pixel ratio. The hotspot is
// the pixel the mouse events report, which is what the artwork gets offset by.
export type SystemCursor = {
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  png: string;
};

// The measured extent of an --hover/--focus target: the union of the element and its
// descendants in viewport coordinates, plus the scroll offset that converts it to page
// coordinates for the clip.
export type TargetBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  scrollX: number;
  scrollY: number;
};

// What CDP crops each screenshot to, in page coordinates. Undefined means the whole
// viewport.
export type Clip = {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
};

export type Point = { x: number; y: number };

// Where the pointer waits, and where it lands. Both in viewport coordinates.
export type PointerPath = {
  pointerHome: Point;
  pointerOnTarget: Point;
};

// Everything --width/--height/--scale and the flick constants imply for one pan, in
// pixels rather than viewports. Derived once, then read by scrollOffsetAt.
export type PanMotion = {
  linear: boolean;
  driftPixelsPerSecond: number;
  flickDistancePixels: number;
  flickMaxPixelsPerSecond: number;
  flickPixelsPerSecond: number;
  flickSeconds: number;
  flickPeriodSeconds: number;
  linearPixelsPerSecond: number;
};

// The resolved command line: flags applied over whichever frame profile is in play.
export type Options = {
  url: string;
  out: string;
  fps: number;
  stillSeconds: number;
  width: number;
  height: number;
  scale: number;
  mobile: boolean;
  scroll: boolean;
  linear: boolean;
  holdFrames: number;
  hover?: string;
  focus?: string;
  // Whichever of hover/focus was given. One element, one action.
  actionSelector?: string;
};

// A screenshot the browser has not answered yet. Giving up on one does not cancel it --
// CDP has no cancel for captureScreenshot -- so it stays live and every later shot is
// answered behind it. Carrying it means the next frame waits on the request already in
// flight instead of adding another to the queue.
export type PendingShot = {
  promise: Promise<{ data: string } | undefined>;
  settled: boolean;
};

// What capture carries between frames: the last picture the page actually drew, how many
// frames in a row it has drawn nothing new, and any shot still outstanding.
export type CaptureState = {
  lastFrame?: Buffer;
  stillFrames: number;
  pending?: PendingShot;
};

// How CDP is told to spend the virtual clock. Playwright ships this union inside its
// Protocol namespace, which the public entry point does not re-export, so it is spelled
// out here rather than reached for through the package's internals.
export type VirtualTimePolicy = 'advance' | 'pause' | 'pauseIfNetworkFetchesPending';
