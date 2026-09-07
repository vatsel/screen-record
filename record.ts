/*
 * Records a web page to an mp4 frame by frame on a virtual clock. The browser's time
 * only moves when a frame is captured, so a 6 second recording is exactly 6 seconds of
 * page time however long the screenshots actually take. CSS animations are held paused
 * and scrubbed to each frame's own timestamp, which is what keeps the intro from being
 * skipped during page load and stops the animation clock outrunning the video.
 *
 * Needs ffmpeg on PATH and playwright's chromium installed; --hover also needs swift,
 * which is where the system cursors come from. Node runs the TypeScript
 * directly (type stripping, Node 22.18+); there is no build step.
 *
 *   node record.ts --url https://example.com
 *       Six seconds of the page sitting at the top, 1440x900 at 2x.
 *
 *   node record.ts --url https://example.com --mobile --scroll
 *       Phone frame, panning from the top of the page to the bottom.
 *
 *   node record.ts --url https://example.com --hover 'nav a' --scale 4
 *       Just that link, cropped tight, while the pointer arrives and its hover plays.
 *
 * Frame:
 *   --width --height  viewport in CSS pixels
 *   --scale           device pixel ratio; the file comes out width*scale by height*scale
 *   --mobile          414x736 at 3x (1242x2208) with a phone user agent and touch
 *   --fps             frames per second, default 60
 *   --out             output file, default out.mp4
 *
 * Sitting still (no --scroll):
 *   --seconds         how long to record, default 6
 *
 * Panning (--scroll) travels from the top of the page to the bottom and holds still at
 * each end. It is not a constant glide: a slow drift runs underneath a series of eased
 * flicks, so it reads like someone reading the page rather than a camera on a rail.
 *   --hold            seconds held still at the top and again at the bottom, default 2
 *   --linear          pan at one constant speed instead: no flicks, no pauses, no drift
 *
 * How fast it pans is not a flag. A flick moves FLICK_DISTANCE_IN_VIEWPORTS without ever
 * exceeding FLICK_MAX_SPEED_IN_VIEWPORTS_PER_SECOND, then the page rests for
 * FLICK_PAUSE_IN_SECONDS before the next one; how long a flick takes, how many there
 * are and how long the pan runs all follow from those. They are the ALL CAPS block at
 * the top of the file, in viewports rather than pixels so a phone frame and a desktop
 * frame move at the same rate to the eye.
 *
 * Acting on one element (--hover or --focus) crops the frame to that element plus a
 * margin and records it reacting: idle, engage, hold, disengage, then enough time for
 * the reaction to finish on screen. The crop covers anything nested inside the element
 * as well, so an underline or swash hanging outside its box is not sliced in half.
 * --hover walks a pointer onto it and dispatches real mouse moves, so :hover and the
 * page's own handlers fire for real; --focus focuses and blurs it and shows no pointer,
 * since keyboard focus has none. The pointer is macOS's own cursor, read out of AppKit
 * through swift (so --hover is macOS only), and which one it is at any moment is the
 * page's decision -- whatever CSS resolves under the pointer, so a link turns it into
 * the hand at the same instant the hover lands.
 *   --hover <selector>  pointer arrives, rests on the element, leaves again
 *   --focus <selector>  element takes keyboard focus, holds it, gives it up
 * --seconds does not apply: the duration is the sum of the ACTION_* constants, the same
 * way a pan's duration follows from the FLICK_* ones.
 */

import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { chromium, devices } from 'playwright';

// --- Motion -----------------------------------------------------------------
// A pan is a slow constant drift with flicks on top of it. A flick moves a set
// distance without exceeding a speed cap, then the page rests for a set pause
// before the next one; everything else -- how long a flick takes, how many there
// are, how long the whole pan runs -- falls out of those. Distances and speeds are in viewports so a phone frame and a desktop
// frame move at the same rate to the eye rather than the same rate in pixels.

// How far one flick carries the page. 0.8 is most of a screen, which is about
// what a reader moves before stopping.
const FLICK_DISTANCE_IN_VIEWPORTS = 0.8;

// How long the page rests between flicks, once one has landed and before the
// next sets off. Only the drift is running during it. The flick's own duration
// comes from its distance and the speed cap, so this doesn't affect it.
const FLICK_PAUSE_IN_SECONDS = 0.9;

// Fastest the page is allowed to move, at the midpoint of a flick. This is the
// total on screen, drift included, so it is the speed you actually watch. Lower
// means a longer, gentler flick covering the same ground, since the flick's
// duration is whatever covering its distance within the cap requires.
const FLICK_MAX_SPEED_IN_VIEWPORTS_PER_SECOND = 1.6;

// The constant creep underneath the flicks, so the page never sits completely
// still mid-pan. 0 gives dead stops between flicks.
const DRIFT_VIEWPORTS_PER_SECOND = 0.2;

// The one speed --linear runs at, flicks and drift both switched off. Set near the
// flick model's average pace so swapping modes doesn't change how long the pan takes.
const LINEAR_SPEED_IN_VIEWPORTS_PER_SECOND = 0.4;

// How long to wait on one virtual-time budget before giving up on it. Under
// pauseIfNetworkFetchesPending a single request that never settles keeps virtual time
// running forever, and the whole recording wedges at zero CPU with no error. Normal
// budgets return in milliseconds, so anything near this is already broken.
const STALLED_BUDGET_MILLISECONDS = 10000;

// How long to wait for the compositor to answer a screenshot. Anything moving answers
// within tens of milliseconds once the clock has run, so this is slack for a loaded
// machine rather than a normal cost -- and being generous is what stops a machine under
// load being mistaken for a page that has stopped drawing.
const STILL_FRAME_MILLISECONDS = 500;

// How many nudges a frame gets before the page is taken to be drawing nothing at all. A
// nudge frees a frame that was merely late every time it is tried, so a second one buys
// nothing that waiting longer would not.
const STILL_FRAME_NUDGES = 1;

// Virtual milliseconds handed to page load before the first frame. Too short and
// the recording opens on a half-built page; too long only wastes wall time, since
// the animations are held at zero throughout the settle either way.
const SETTLE_MILLISECONDS = 2000;

// --- Actions ----------------------------------------------------------------
// --hover and --focus are the same shot in five phases: the element sits idle, the
// action engages, it holds, it disengages, and the reaction is given time to finish on
// screen. Hover spends the engage and disengage phases walking the pointer in and out;
// focus lands and leaves instantly and spends them letting its transition play. Same
// numbers either way, which is why these are ACTION_ and not HOVER_.

const ACTION_LEAD_IN_SECONDS = 0.3;
const ACTION_ENGAGE_SECONDS = 0.45;
const ACTION_DWELL_SECONDS = 0.7;
const ACTION_DISENGAGE_SECONDS = 0.35;
const ACTION_LEAD_OUT_SECONDS = 0.5;
const ACTION_SECONDS = ACTION_LEAD_IN_SECONDS + ACTION_ENGAGE_SECONDS + ACTION_DWELL_SECONDS
  + ACTION_DISENGAGE_SECONDS + ACTION_LEAD_OUT_SECONDS;

// How much page to keep around the element: room for an underline to draw outside the
// text box, and for the pointer to be seen arriving rather than appearing on top of it.
const ACTION_PADDING_PIXELS = 40;

// How far outside the crop the pointer waits before it moves in, in CSS pixels. Clears
// the tallest system cursor (40) so it starts fully out of frame whichever one is up.
const ACTION_POINTER_CLEARANCE_PIXELS = 48;

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    out: { type: 'string', default: 'out.mp4' },
    fps: { type: 'string', default: '60' },
    seconds: { type: 'string' },
    width: { type: 'string' },
    height: { type: 'string' },
    scale: { type: 'string' },
    mobile: { type: 'boolean', default: false },
    scroll: { type: 'boolean', default: false },
    linear: { type: 'boolean', default: false },
    hold: { type: 'string', default: '2' },
    hover: { type: 'string' },
    focus: { type: 'string' },
  },
});

if (!values.url) {
  console.error('usage: node record.ts --url <url> [--out out.mp4] [--fps 60] [--seconds 6] [--width] [--height] [--scale] [--mobile] [--scroll] [--hold 2] [--hover <selector>] [--focus <selector>]');
  console.error('  --mobile  414x736 at 3x (1242x2208) with a phone user agent and touch, the most common mobile viewport width (desktop default is 1440x900 at 2x)');
  console.error('  --scroll  pan from the top of the page to the bottom, holding still for --hold seconds at each end');
  console.error('            how fast it pans is set by the FLICK_* constants at the top of the file, not by a flag');
  console.error('  --linear  pan at one constant speed instead: no flicks, no pauses, no drift');
  console.error('  --hover   crop to the matching element and walk a pointer onto it, rest, and leave');
  console.error('  --focus   crop to the matching element and give it keyboard focus, hold, release');
  console.error('            how long each phase lasts is set by the ACTION_* constants, not by a flag');
  process.exit(1);
}

// One element, one action. Both at once has no meaning, and panning the whole page
// while cropped to a link even less.
const actionSelector = values.hover ?? values.focus;
if (values.hover && values.focus) {
  console.error('--hover and --focus are one shot each; pass one or the other');
  process.exit(1);
}
if (actionSelector && values.scroll) {
  console.error('--scroll pans the whole page and --hover/--focus crop to one element; pass one or the other');
  process.exit(1);
}

// 414 CSS px is the most common mobile viewport width worldwide, and 414x736 is the
// real visible viewport of the iPhone Plus class -- browser chrome already subtracted,
// so the frame is 9:16 rather than the absurd 1:2.2 a raw screen resolution gives. At
// 3x that is 1242x2208, which is that hardware's actual render resolution.
// Explicit --width/--height/--scale still win over either profile.
const profile = values.mobile
  ? { width: 414, height: 736, scale: 3, device: devices['Pixel 5'] }
  : { width: 1440, height: 900, scale: 2, device: {} };
const width = Number(values.width ?? profile.width);
const height = Number(values.height ?? profile.height);
const scale = Number(values.scale ?? profile.scale);

// Scrolling is vertical, so the viewport height is the screen dimension the motion
// constants are measured against.
const driftPixelsPerSecond = DRIFT_VIEWPORTS_PER_SECOND * height;
const flickDistancePixels = FLICK_DISTANCE_IN_VIEWPORTS * height;
const flickMaxPixelsPerSecond = FLICK_MAX_SPEED_IN_VIEWPORTS_PER_SECOND * height;
const linearPixelsPerSecond = LINEAR_SPEED_IN_VIEWPORTS_PER_SECOND * height;

// The cap covers everything on screen and the drift is already spending part of it, so
// the flick itself only gets what's left. Smoothstep tops out at 1.5x its own average,
// so covering flickDistancePixels within that budget takes exactly this long.
const flickPixelsPerSecond = Math.max(flickMaxPixelsPerSecond - driftPixelsPerSecond, 1);
const flickSeconds = (1.5 * flickDistancePixels) / flickPixelsPerSecond;
const flickPeriodSeconds = flickSeconds + FLICK_PAUSE_IN_SECONDS;
if (values.scroll && flickMaxPixelsPerSecond <= driftPixelsPerSecond) {
  console.error(`the speed cap (${Math.round(flickMaxPixelsPerSecond)}px/s) is below the drift (${Math.round(driftPixelsPerSecond)}px/s), so the flicks have no room to move`);
}

const fps = Number(values.fps);
// --scroll spends the travel time panning, with a still --hold at each end on top of
// that. How long the travel lasts is only known once the page height is measured.
const holdFrames = values.scroll ? Math.round(fps * Number(values.hold)) : 0;
const stillSeconds = Number(values.seconds ?? 6);

const ffmpeg = spawn('ffmpeg', [
  '-y',
  // ponytail: the twice-a-second progress line is noise here, and it deadlocks the
  // pipe if whatever is reading our stderr stops.
  '-nostats',
  '-loglevel', 'error',
  '-f', 'image2pipe',
  '-framerate', String(fps),
  '-i', '-',
  '-c:v', 'libx264',
  '-preset', 'slow',
  '-crf', '18',
  '-pix_fmt', 'yuv420p',
  // ponytail: h264 needs even dimensions; odd viewport/scale combos would fail without this
  '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
  values.out,
], { stdio: ['pipe', 'inherit', 'inherit'] });

const browser = await chromium.launch();
const page = await browser.newPage({
  // ponytail: Pixel 5 is only here for its phone user agent and touch flags; the
  // viewport and scale below are what actually decide the frame.
  ...profile.device,
  viewport: { width, height },
  deviceScaleFactor: scale,
});
const cdp = await page.context().newCDPSession(page);

// Page.captureScreenshot ignores the context's deviceScaleFactor and hands back CSS
// pixels, so state the scale where CDP will see it.
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: scale,
  mobile: values.mobile,
});

// Freeze the clock before anything runs, then let load settle on a fixed budget.
await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
await page.goto(values.url, { waitUntil: 'commit' });
await advanceVirtualTime(SETTLE_MILLISECONDS);

// One measurement, before any frames. The action itself changes layout -- an underline
// appears, a focus ring grows the box -- and a crop that moved with it would hand ffmpeg
// frames of different sizes, which libx264 will not take. The element is centred first
// so there is room on both sides for the pointer to come from.
const target = actionSelector
  ? await page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    // A hover underline, swash or glow is usually an absolutely positioned child hanging
    // outside the link's own box, and getBoundingClientRect stops at the box -- crop to
    // that and the decoration is sliced off mid-stroke. Take the union of the element and
    // everything inside it instead.
    // ponytail: descendants as they sit at rest. Decoration a script only inserts on
    // hover is still missed; measuring mid-hover needs the clock running, which is the
    // one thing this shot cannot have. Widen ACTION_PADDING_PIXELS if that is your page.
    let left = rect.left;
    let top = rect.top;
    let right = rect.right;
    let bottom = rect.bottom;
    for (const descendant of element.querySelectorAll('*')) {
      const box = descendant.getBoundingClientRect();
      // Skip the collapsed ones: a hidden or empty child would drag the crop to 0,0.
      if (box.width === 0 && box.height === 0) continue;
      left = Math.min(left, box.left);
      top = Math.min(top, box.top);
      right = Math.max(right, box.right);
      bottom = Math.max(bottom, box.bottom);
    }
    return {
      left,
      top,
      right,
      bottom,
      // The clip is in page coordinates and the mouse in viewport ones; this is what
      // converts between them.
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
  }, actionSelector)
  : null;

if (actionSelector && !target) {
  console.error(`nothing on the page matches ${actionSelector}`);
  await browser.close();
  // SIGKILL, not the default term: ffmpeg given a term still gets far enough to complain
  // about the empty stdin it was handed, which buries the message above.
  ffmpeg.kill('SIGKILL');
  process.exit(1);
}

// Undefined outside an action, and JSON drops undefined, so the capture below is the
// whole viewport then.
let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
// Where the pointer rests before and after the shot, and where it rests on the element.
let pointerHome = { x: 0, y: 0 };
let pointerOnTarget = { x: 0, y: 0 };

if (target) {
  // Rounded before anything else: CDP floors the CSS rect before scaling it, so a
  // fractional edge quietly changes the size of every frame.
  const cropLeft = Math.max(Math.round(target.left) - ACTION_PADDING_PIXELS, 0);
  const cropTop = Math.max(Math.round(target.top) - ACTION_PADDING_PIXELS, 0);
  const cropRight = Math.min(Math.round(target.right) + ACTION_PADDING_PIXELS, width);
  const cropBottom = Math.min(Math.round(target.bottom) + ACTION_PADDING_PIXELS, height);

  clip = {
    x: cropLeft + target.scrollX,
    y: cropTop + target.scrollY,
    width: cropRight - cropLeft,
    height: cropBottom - cropTop,
    // clip.scale multiplies on top of the device metrics override, which is already
    // applying --scale. Anything but 1 here applies it twice.
    scale: 1,
  };

  pointerOnTarget = {
    x: (cropLeft + cropRight) / 2,
    y: (cropTop + cropBottom) / 2,
  };
  // The pointer waits outside the crop so it is seen arriving. Below by default, like a
  // hand coming up the page; above when the crop already reaches the bottom of the
  // viewport, since Chrome clamps mouse coordinates into the viewport and a start point
  // off-screen would read as a hover that never left.
  const roomBelowCrop = height - cropBottom > ACTION_POINTER_CLEARANCE_PIXELS;
  const restingY = roomBelowCrop
    ? cropBottom + ACTION_POINTER_CLEARANCE_PIXELS
    : cropTop - ACTION_POINTER_CLEARANCE_PIXELS;
  pointerHome = {
    x: Math.min(Math.max(pointerOnTarget.x - ACTION_POINTER_CLEARANCE_PIXELS, 0), width - 1),
    y: Math.min(Math.max(restingY, 0), height - 1),
  };
}

// The start times pinAnimations parks on the page live on window: it runs inside the
// browser, so a module-scoped variable here would not be there.
declare global {
  interface Window {
    animationStartTimes?: WeakMap<Animation, number>;
    recordCursors?: Record<string, SystemCursor>;
  }
}

// Screenshots force compositor frames stamped with the real clock, so
// document.timeline outruns virtual time -- mildly at scale 1, by more than 10x at
// scale 2 -- and every CSS animation races ahead of the video. Paused animations
// ignore the timeline, so hold them all and scrub each one to the exact frame time.
// This also fixes the intro: without it the animations burn through the load settle
// and Chrome backdates their start to the first painted frame.
function pinAnimations(elapsed: number) {
  window.animationStartTimes ??= new WeakMap();
  for (const animation of document.getAnimations()) {
    // ponytail: scroll-driven animations are progress based and follow scroll
    // position rather than the document timeline, so they are left alone.
    if (animation.timeline !== document.timeline) continue;
    if (!window.animationStartTimes.has(animation)) {
      animation.pause();
      window.animationStartTimes.set(animation, elapsed);
    }
    animation.currentTime = elapsed - window.animationStartTimes.get(animation);
  }
}

// Ease in and out: 0 at 0, 1 at 1, flat at both ends so nothing starts or stops with a
// jolt.
function smoothstep(fraction: number) {
  return fraction * fraction * (3 - 2 * fraction);
}

// How far the action has got, 0 idle to 1 fully engaged, this far into the shot. Hover
// reads it as a position along the pointer's path.
function engagementAt(seconds: number) {
  const sinceEngage = seconds - ACTION_LEAD_IN_SECONDS;
  if (sinceEngage < 0) return 0;
  if (sinceEngage < ACTION_ENGAGE_SECONDS) return smoothstep(sinceEngage / ACTION_ENGAGE_SECONDS);
  const sinceDwell = sinceEngage - ACTION_ENGAGE_SECONDS;
  if (sinceDwell < ACTION_DWELL_SECONDS) return 1;
  const sinceDisengage = sinceDwell - ACTION_DWELL_SECONDS;
  if (sinceDisengage < ACTION_DISENGAGE_SECONDS) {
    return 1 - smoothstep(sinceDisengage / ACTION_DISENGAGE_SECONDS);
  }
  return 0;
}

// Focus is not a journey: it lands at the start of the engage phase and leaves at the
// start of the disengage phase, so those two phases are the time its transition gets to
// play in either direction.
function focusedAt(seconds: number) {
  const focusedUntil = ACTION_LEAD_IN_SECONDS + ACTION_ENGAGE_SECONDS + ACTION_DWELL_SECONDS;
  return seconds >= ACTION_LEAD_IN_SECONDS && seconds < focusedUntil;
}

// Where the pointer is, in viewport pixels: resting off the crop, easing onto the
// element, holding, easing back off.
function pointerPositionAt(seconds: number) {
  const engaged = engagementAt(seconds);
  return {
    x: pointerHome.x + (pointerOnTarget.x - pointerHome.x) * engaged,
    y: pointerHome.y + (pointerOnTarget.y - pointerHome.y) * engaged,
  };
}

type SystemCursor = {
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  png: string;
};

// macOS keeps its cursors in AppKit, so this asks AppKit for them rather than drawing
// lookalikes: a hand-drawn arrow reads as fake however carefully it is traced, and a
// traced set is a set someone has to keep matching against the real one. Rasterized at
// the recording's own pixel ratio so it stays sharp at --scale 4.
//
// Run through swift on stdin rather than a file, because the repo is one script and it
// stays that way. The scale rides in on the environment since a script read from stdin
// has nowhere to take an argument.
const CURSOR_DUMPER_SWIFT = String.raw`
import AppKit

// A process that is not a GUI app gets empty images back for the cursors the window
// server owns -- the plain arrow among them -- until AppKit has been brought up.
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let scale = Int(ProcessInfo.processInfo.environment["RECORD_CURSOR_SCALE"] ?? "2") ?? 2

// The CSS keywords a page actually asks for, each paired with the cursor macOS shows
// for it. Anything not here falls back to the arrow, which is what the page would get
// from a system that has no special cursor for it either.
let cursors: [(String, NSCursor)] = [
  ("default", .arrow), ("pointer", .pointingHand), ("text", .iBeam),
  ("vertical-text", .iBeamCursorForVerticalLayout), ("crosshair", .crosshair),
  ("not-allowed", .operationNotAllowed), ("no-drop", .operationNotAllowed),
  ("grab", .openHand), ("grabbing", .closedHand), ("move", .closedHand),
  ("copy", .dragCopy), ("alias", .dragLink), ("context-menu", .contextualMenu),
  ("col-resize", .resizeLeftRight), ("ew-resize", .resizeLeftRight),
  ("row-resize", .resizeUpDown), ("ns-resize", .resizeUpDown),
]

var dumped: [String] = []
for (name, cursor) in cursors {
  let image = cursor.image
  let size = image.size
  guard size.width > 0, size.height > 0 else { continue }
  guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil,
    pixelsWide: Int(size.width) * scale, pixelsHigh: Int(size.height) * scale,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { continue }
  // The rep is sized in points while its backing store is in pixels, which is what
  // draws the vector artwork at scale rather than blowing up a small bitmap.
  rep.size = size
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  image.draw(in: NSRect(origin: .zero, size: size))
  NSGraphicsContext.restoreGraphicsState()
  guard let png = rep.representation(using: .png, properties: [:]) else { continue }
  dumped.append("{\"name\":\"" + name + "\",\"width\":\(size.width),\"height\":\(size.height)"
    + ",\"hotspotX\":\(cursor.hotSpot.x),\"hotspotY\":\(cursor.hotSpot.y)"
    + ",\"png\":\"data:image/png;base64," + png.base64EncodedString() + "\"}")
}
print("[" + dumped.joined(separator: ",") + "]")
`;

function systemCursors(pixelRatio: number): Record<string, SystemCursor> {
  let dumped: string;
  try {
    dumped = execFileSync('swift', ['-'], {
      input: CURSOR_DUMPER_SWIFT,
      env: { ...process.env, RECORD_CURSOR_SCALE: String(pixelRatio) },
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
  } catch (cause) {
    console.error('--hover draws the pointer with macOS\'s own cursors, which it reads through swift');
    console.error(`and AppKit; swift could not be run here: ${(cause as Error).message}`);
    process.exit(1);
  }

  const cursors: Record<string, SystemCursor> = {};
  for (const cursor of JSON.parse(dumped) as (SystemCursor & { name: string })[]) {
    cursors[cursor.name] = cursor;
  }
  return cursors;
}

// The real pointer is not in a CDP screenshot, so the system's own cursors are put into
// the page as images -- one <img> each, all of them decoded up front. Swapping which one
// is shown then costs nothing, where swapping a src would hand the frame a decode it
// cannot finish in time and drop the cursor out of it.
async function addCursor(cursors: Record<string, SystemCursor>) {
  window.recordCursors = cursors;
  const holder = document.createElement('div');
  holder.id = 'record-cursor';
  // pointer-events none so the page never sees it, and so elementFromPoint below reads
  // through it to whatever the pointer is really over. No shadow: the system artwork
  // already carries the one macOS draws.
  holder.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none';
  document.body.append(holder);

  await Promise.all(Object.entries(cursors).map(async ([name, cursor]) => {
    const image = new Image();
    image.dataset.cursor = name;
    image.src = cursor.png;
    // Every declaration is !important because this is the page's stylesheet we are
    // landing in, and a page styles its own images. Tailwind's preflight alone
    // (`img { max-width: 100% }`, against a holder that is 0 wide) is enough to render
    // the pointer exactly zero pixels across and leave the recording looking cursorless.
    image.style.cssText = `position:absolute!important;top:0!important;left:0!important;
      width:${cursor.width}px!important;height:${cursor.height}px!important;
      max-width:none!important;max-height:none!important;min-width:0!important;
      margin:0!important;padding:0!important;border:0!important;
      opacity:1!important;visibility:visible!important;filter:none!important;
      clip-path:none!important;mask:none!important;display:none`;
    holder.append(image);
    await image.decode().catch(() => {});
  }));
}

// Which cursor to show is the page's call, not ours: whatever CSS resolves for the
// element under the pointer is what a real pointer would turn into there, the page's
// own :hover rules included. Reading it every frame is what makes the hand appear on
// the link at the same moment the hover does.
function moveCursor(position: { x: number; y: number }) {
  const holder = document.getElementById('record-cursor');
  const cursors = window.recordCursors;
  if (!holder || !cursors) return;

  const under = document.elementFromPoint(position.x, position.y);
  // ponytail: 'auto' is reported as itself rather than resolved, and it is only a lie
  // over text, where the real pointer would be an I-beam. Everywhere else it is the
  // arrow. Map the keyword if that ever matters more than the link case does.
  const declared = under ? getComputedStyle(under).cursor : 'default';
  // A computed cursor can be a fallback list ('url(a.png) 4 4, pointer'); the keyword
  // the browser falls back to is the last entry.
  const keyword = declared.split(',').pop()!.trim();
  const cursor = cursors[keyword] ?? cursors.default;

  for (const image of holder.children) {
    if (!(image instanceof HTMLImageElement)) continue;
    const showing = image.dataset.cursor === (cursors[keyword] ? keyword : 'default');
    image.style.setProperty('display', showing ? 'block' : 'none', 'important');
    if (showing) {
      // The hotspot is the pixel the mouse events report, so the artwork is offset by
      // it -- otherwise the hand points a finger's width away from what it is clicking.
      image.style.transform = `translate(${position.x - cursor.hotspotX}px, ${position.y - cursor.hotspotY}px)`;
    }
  }
}

// focus() and blur() are both no-ops when the element is already in that state, so the
// frame loop can just say what it wants rather than tracking what it last did.
// preventScroll because the element is already centred and a scroll now would drag it
// out of a crop that was measured before the recording started.
function setFocused({ selector, focused }: { selector: string; focused: boolean }) {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) return;
  if (focused) {
    element.focus({ preventScroll: true });
  } else {
    element.blur();
  }
}

// Where the pan has got to, in CSS pixels, this far into the travel. The drift runs
// the whole time; each completed flick has added its distance, and the one in progress
// adds its share on a smoothstep so it eases in and out rather than snapping.
function scrollOffsetAt(seconds: number) {
  // --linear is the whole model: one speed, start to finish, nothing riding on top.
  if (values.linear) {
    return linearPixelsPerSecond * seconds;
  }
  const flicksDone = Math.floor(seconds / flickPeriodSeconds);
  const withinPeriod = seconds - flicksDone * flickPeriodSeconds;
  // Past flickSeconds the flick has landed and the rest of the period is the pause.
  const flickFraction = Math.min(withinPeriod / flickSeconds, 1);
  const eased = smoothstep(flickFraction);
  return driftPixelsPerSecond * seconds + flickDistancePixels * (flicksDone + eased);
}

// Scroll position is set outright rather than animated: the page's own smooth
// scrolling would run on the same untrustworthy clock the animations do, and
// scroll-driven (progress based) animations follow whatever offset we land on.
function scrollToProgress(progress: number) {
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  window.scrollTo({ top: progress * maxScroll, behavior: 'instant' });
}

// ponytail: page.screenshot() waits for the page to look stable and hangs once the
// animations are pinned, so go straight to CDP, which just grabs the surface.
//
// A screenshot is answered by the next frame the compositor draws, so the request has to
// be in flight *before* the clock runs, not after it has already stopped -- asking
// afterwards is a race the recording loses at random, and loses outright on a machine
// busy enough that the frame lands first. Spending the frame's budget is therefore part
// of taking the picture, which is why the advance lives in here.
//
// A page that draws nothing never answers at all, and that is not a failure: nothing was
// redrawn because nothing changed, so the frame already in hand is still what the page
// looks like. Handing that one to ffmpeg again is the honest answer, and the only one
// available -- a page with no animation, no scrolling and no pointer on it produces
// exactly one frame however long it is recorded for.
let lastFrame: Buffer | undefined;
let stillFrames = 0;

// Waits for the compositor to answer, or gives up and says so.
const settle = async (shot: Promise<{ data: string }>, patience: number) => {
  const abort = new AbortController();
  const drawn = await Promise.race([
    shot.then((frame) => frame, () => undefined),
    delay(patience, undefined, { signal: abort.signal }).then(() => undefined, () => undefined),
  ]);
  abort.abort();
  return drawn;
};

const capture = async () => {
  const shot = cdp.send('Page.captureScreenshot', { format: 'png', clip });
  // A shot that is given up on still settles later, against a session that may be
  // closed by then; nothing is waiting on it to notice.
  shot.catch(() => {});

  await advanceVirtualTime(1000 / fps);

  // A frame that has not arrived is either late or was never drawn, and waiting longer
  // cannot tell those apart -- on a loaded machine a real frame is simply slow, and on
  // a still page no amount of patience produces one. Nudging the clock does tell them
  // apart: a late frame lands the moment virtual time runs again, every time, while a
  // page with nothing to redraw stays silent however often it is asked. Plain advance
  // for the nudge, since pauseIfNetworkFetchesPending will not move the clock at all
  // while the page has a request outstanding, which is when wedges tend to happen.
  // A page already known to be drawing nothing goes straight to the nudge rather than
  // waiting first, which is what keeps a recording of a static page down to seconds a
  // frame. The wait *after* a nudge is never shortened: that one is the test, and
  // cutting it short is how a loaded machine gets mistaken for a still page and the
  // recording quietly freezes.
  const patience = stillFrames > 0 ? 0 : STILL_FRAME_MILLISECONDS;
  let drawn = await settle(shot, lastFrame ? patience : STALLED_BUDGET_MILLISECONDS);
  for (let nudge = 0; !drawn && lastFrame && nudge < STILL_FRAME_NUDGES; nudge++) {
    await advanceVirtualTime(1000 / fps, 'advance');
    drawn = await settle(shot, STILL_FRAME_MILLISECONDS);
  }

  if (drawn) {
    stillFrames = 0;
    lastFrame = Buffer.from(drawn.data, 'base64');
    return lastFrame;
  }
  if (!lastFrame) {
    // Nothing to fall back on: the first frame is the one the whole recording is built
    // from, and a page that cannot draw it once cannot be recorded at all.
    throw new Error(`the page drew no frame at all within ${STALLED_BUDGET_MILLISECONDS / 1000}s, so there is nothing to record`);
  }
  // Nothing was drawn because nothing changed, so the frame already in hand is still
  // what the page looks like. ponytail: the count is the streak rather than the total,
  // which is all the closing line needs it for.
  stillFrames += 1;
  return lastFrame;
};

// Panning holds the pace fixed and lets the page height decide the duration;
// --seconds fixes the duration of a still recording instead. ponytail: the height is
// measured once, so lazy content that extends the page mid-pan makes the real pace
// run a couple of percent over -- the pan still ends exactly at the bottom.
const scrollableHeight = await page.evaluate(
  'Math.max(0, document.documentElement.scrollHeight - window.innerHeight)',
);
// Sitting still runs for --seconds. Panning runs until the offset has covered the
// page -- nothing to solve, just step forward until it has. Capped so a drift and
// flick distance of both zero can't spin here forever.
let travelFrames = Math.round(stillSeconds * fps);
if (actionSelector) {
  travelFrames = Math.round(ACTION_SECONDS * fps);
} else if (values.scroll) {
  travelFrames = 0;
  while (scrollOffsetAt(travelFrames / fps) < scrollableHeight && travelFrames < fps * 600) {
    travelFrames += 1;
  }
}
const frameCount = travelFrames + 2 * holdFrames;

if (values.scroll && values.linear) {
  console.error(`scrolling ${scrollableHeight}px over ${(travelFrames / fps).toFixed(1)}s at a flat ${Math.round(linearPixelsPerSecond)}px/s`);
} else if (values.scroll) {
  const flicks = Math.ceil(scrollableHeight / (driftPixelsPerSecond * flickPeriodSeconds + flickDistancePixels));
  const peak = Math.round(driftPixelsPerSecond + (1.5 * flickDistancePixels) / flickSeconds);
  console.error(`scrolling ${scrollableHeight}px over ${(travelFrames / fps).toFixed(1)}s in ${flicks} flicks of ${Math.round(flickDistancePixels)}px (${flickSeconds.toFixed(1)}s each, peaking at ${peak}px/s, then resting ${FLICK_PAUSE_IN_SECONDS}s on ${Math.round(driftPixelsPerSecond)}px/s of drift)`);
}

if (actionSelector && clip) {
  const verb = values.hover ? 'hovering' : 'focusing';
  console.error(`${verb} ${actionSelector} over ${ACTION_SECONDS.toFixed(1)}s, cropped to ${clip.width}x${clip.height} css px (${clip.width * scale}x${clip.height * scale} out)`);
}

if (values.hover) {
  await page.evaluate(addCursor, systemCursors(scale));
}

// Pin before the first frame so the settle's compositor backlog lands on paused
// animations and cannot drag them forward.
await page.evaluate(pinAnimations, 0);

// A silent multi-minute render is indistinguishable from a wedged one, and the mp4
// only grows in 256KiB lurches so its size proves nothing. Report the rate instead.
const startedAt = Date.now();
let stalledBudgets = 0;

for (let frame = 0; frame < frameCount; frame++) {
  if (values.scroll) {
    const travelled = Math.min(Math.max((frame - holdFrames) / fps, 0), travelFrames / fps);
    // Fed through as a fraction rather than raw pixels so the pan still lands exactly
    // on the bottom when lazy content has stretched the page under us.
    await page.evaluate(scrollToProgress, Math.min(scrollOffsetAt(travelled) / scrollableHeight, 1));
  }
  if (values.hover) {
    const pointer = pointerPositionAt(frame / fps);
    // The mouse move is what makes :hover and the page's own handlers fire. The drawn
    // cursor only follows it, offset by the hotspot so the two agree on where it points.
    // ponytail: dispatched and not awaited. Chromium acks a queued mouse event only once
    // the renderer has run, which the paused clock gates, so awaiting the second move
    // wedges the recording at zero CPU forever. The event still lands -- hover engages a
    // frame later, 16ms at 60fps -- so the ack was never worth waiting for.
    page.mouse.move(pointer.x, pointer.y).catch(() => {});
    // Sent as the pointer's own position, not the artwork's: the offset to the artwork
    // is the hotspot of whichever cursor the page turns out to be showing there.
    await page.evaluate(moveCursor, pointer);
  } else if (values.focus) {
    await page.evaluate(setFocused, { selector: values.focus, focused: focusedAt(frame / fps) });
  }
  // Scrolling and hovering both start animations, so pin after acting to catch them at
  // zero.
  await page.evaluate(pinAnimations, (frame * 1000) / fps);
  // Spends this frame's virtual time and takes the picture the clock's own run draws.
  const png = await capture();
  if (!ffmpeg.stdin.write(png)) {
    await once(ffmpeg.stdin, 'drain');
  }
  if (frame % fps === 0 || frame === frameCount - 1) {
    const rate = (frame + 1) / ((Date.now() - startedAt) / 1000);
    process.stderr.write(`\rframe ${frame + 1}/${frameCount} at ${rate.toFixed(1)} fps`);
  }
}
process.stderr.write('\n');
if (stillFrames > 0) {
  console.error(`the page drew nothing new for the last ${stillFrames} of ${frameCount} frames, which were filled with the frame before them`);
}
if (stalledBudgets > 0) {
  console.error(`${stalledBudgets} frames gave up waiting on the page's network after ${STALLED_BUDGET_MILLISECONDS / 1000}s; something on the page never finishes loading`);
}

await browser.close();
ffmpeg.stdin.end();
const [code] = await once(ffmpeg, 'close');
process.exit(code);

async function advanceVirtualTime(budget: number, policy = 'pauseIfNetworkFetchesPending') {
  const abort = new AbortController();
  const expired = once(cdp, 'Emulation.virtualTimeBudgetExpired', { signal: abort.signal })
    .then(() => true, () => false);
  const timedOut = delay(STALLED_BUDGET_MILLISECONDS, false, { signal: abort.signal })
    .catch(() => false);

  await cdp.send('Emulation.setVirtualTimePolicy', {
    policy,
    budget,
    maxVirtualTimeTaskStarvationCount: 10000,
  });
  const finished = await Promise.race([expired, timedOut]);
  abort.abort();

  // A request that never settles would otherwise hang here forever. Stop the clock by
  // hand and carry on: the animations are re-pinned every frame, so they resync.
  if (!finished) {
    stalledBudgets += 1;
    await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
  }
}
