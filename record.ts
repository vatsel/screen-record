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
 * are and how long the pan runs all follow from those. They are the ALL CAPS block in
 * lib/constants.ts, in viewports rather than pixels so a phone frame and a desktop
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
 *
 * The parts: lib/constants.ts (tuning), lib/options.ts (the command line),
 * lib/motion.ts (when things move), lib/layout.ts (where they are), lib/capture.ts
 * (one frame), lib/cursors.ts (AppKit), lib/page.ts (code that runs in the browser).
 */

import { spawn } from 'node:child_process';
import { once, type EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ACTION_SECONDS,
  PROGRESS_INTERVAL_MILLISECONDS,
  SETTLE_MILLISECONDS,
  STALLED_BUDGET_MILLISECONDS,
} from './lib/constants.ts';
import { captureFrame } from './lib/capture.ts';
import { systemCursors } from './lib/cursors.ts';
import { computeCrop, pointerPositionAt } from './lib/layout.ts';
import {
  countTravelFrames,
  derivePan,
  driftOutrunsFlicks,
  focusedAt,
  scrollOffsetAt,
} from './lib/motion.ts';
import { USAGE, frameDevice, parseOptions } from './lib/options.ts';
import * as pageScript from './lib/page.ts';
import type { CaptureState, Clip, PointerPath, VirtualTimePolicy } from './lib/types.ts';
import { chromium } from 'playwright';

const parsed = parseOptions(process.argv.slice(2));
if (!parsed.ok) {
  for (const error of parsed.errors) console.error(error);
  if (parsed.showUsage) for (const line of USAGE) console.error(line);
  process.exit(1);
}
const options = parsed.options;
const { fps, width, height, scale, actionSelector } = options;

const pan = derivePan(height, { linear: options.linear });
if (options.scroll && driftOutrunsFlicks(pan)) {
  console.error(`the speed cap (${Math.round(pan.flickMaxPixelsPerSecond)}px/s) is below the drift (${Math.round(pan.driftPixelsPerSecond)}px/s), so the flicks have no room to move`);
}

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
  options.out,
], { stdio: ['pipe', 'inherit', 'inherit'] });

const browser = await chromium.launch();
const page = await browser.newPage({
  ...frameDevice(options.mobile),
  viewport: { width, height },
  deviceScaleFactor: scale,
});
const cdp = await page.context().newCDPSession(page);
// Playwright's CDPSession is a real EventEmitter, but its published type declares only
// the subscribe half of the interface, which node's once() will not take.
const cdpEvents = cdp as unknown as EventEmitter;

// Page.captureScreenshot ignores the context's deviceScaleFactor and hands back CSS
// pixels, so state the scale where CDP will see it.
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: scale,
  mobile: options.mobile,
});

// Freeze the clock before anything runs, then let load settle on a fixed budget.
await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
await page.goto(options.url, { waitUntil: 'commit' });
await advanceVirtualTime(SETTLE_MILLISECONDS);

const target = actionSelector ? await page.evaluate(pageScript.measureTarget, actionSelector) : null;
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
let clip: Clip | undefined;
let pointerPath: PointerPath = { pointerHome: { x: 0, y: 0 }, pointerOnTarget: { x: 0, y: 0 } };
if (target) {
  ({ clip, ...pointerPath } = computeCrop({ target, width, height }));
}

const scrollableHeight = await page.evaluate(
  'Math.max(0, document.documentElement.scrollHeight - window.innerHeight)',
) as number;
// Sitting still runs for --seconds; an action runs for the sum of its phases; panning
// runs until the offset has covered the page. ponytail: the height is measured once, so
// lazy content that extends the page mid-pan makes the real pace run a couple of percent
// over -- the pan still ends exactly at the bottom.
let travelFrames = Math.round(options.stillSeconds * fps);
if (actionSelector) {
  travelFrames = Math.round(ACTION_SECONDS * fps);
} else if (options.scroll) {
  travelFrames = countTravelFrames({ pan, fps, scrollableHeight });
}
const frameCount = travelFrames + 2 * options.holdFrames;

if (options.scroll && options.linear) {
  console.error(`scrolling ${scrollableHeight}px over ${(travelFrames / fps).toFixed(1)}s at a flat ${Math.round(pan.linearPixelsPerSecond)}px/s`);
} else if (options.scroll) {
  const flicks = Math.ceil(scrollableHeight / (pan.driftPixelsPerSecond * pan.flickPeriodSeconds + pan.flickDistancePixels));
  const peak = Math.round(pan.driftPixelsPerSecond + (1.5 * pan.flickDistancePixels) / pan.flickSeconds);
  console.error(`scrolling ${scrollableHeight}px over ${(travelFrames / fps).toFixed(1)}s in ${flicks} flicks of ${Math.round(pan.flickDistancePixels)}px (${pan.flickSeconds.toFixed(1)}s each, peaking at ${peak}px/s, then resting ${(pan.flickPeriodSeconds - pan.flickSeconds).toFixed(1)}s on ${Math.round(pan.driftPixelsPerSecond)}px/s of drift)`);
}

if (actionSelector && clip) {
  const verb = options.hover ? 'hovering' : 'focusing';
  console.error(`${verb} ${actionSelector} over ${ACTION_SECONDS.toFixed(1)}s, cropped to ${clip.width}x${clip.height} css px (${clip.width * scale}x${clip.height * scale} out)`);
}

if (options.hover) {
  try {
    await page.evaluate(pageScript.addCursor, systemCursors(scale));
  } catch (cause) {
    console.error((cause as Error).message);
    await browser.close();
    ffmpeg.kill('SIGKILL');
    process.exit(1);
  }
}

// Pin before the first frame so the settle's compositor backlog lands on paused
// animations and cannot drag them forward.
await page.evaluate(pageScript.pinAnimations, 0);

// Spends the frame's virtual time and takes the picture the clock's own run draws; see
// lib/capture.ts for why those are one operation.
const captureState: CaptureState = { stillFrames: 0 };
const captureDeps = {
  screenshot: () => cdp.send('Page.captureScreenshot', { format: 'png', clip }),
  advance: advanceVirtualTime,
  frameBudgetMilliseconds: 1000 / fps,
};

// A silent multi-minute render is indistinguishable from a wedged one, and the mp4
// only grows in 256KiB lurches so its size proves nothing. Report the rate instead.
let lastReportAt = Date.now();
let lastReportFrame = -1;
let stalledBudgets = 0;

for (let frame = 0; frame < frameCount; frame++) {
  if (options.scroll) {
    const travelled = Math.min(Math.max((frame - options.holdFrames) / fps, 0), travelFrames / fps);
    // Fed through as a fraction rather than raw pixels so the pan still lands exactly
    // on the bottom when lazy content has stretched the page under us.
    await page.evaluate(pageScript.scrollToProgress, Math.min(scrollOffsetAt(pan, travelled) / scrollableHeight, 1));
  }
  if (options.hover) {
    const pointer = pointerPositionAt(frame / fps, pointerPath);
    // The mouse move is what makes :hover and the page's own handlers fire. The drawn
    // cursor only follows it, offset by the hotspot so the two agree on where it points.
    // ponytail: dispatched and not awaited. Chromium acks a queued mouse event only once
    // the renderer has run, which the paused clock gates, so awaiting the second move
    // wedges the recording at zero CPU forever. The event still lands -- hover engages a
    // frame later, 16ms at 60fps -- so the ack was never worth waiting for.
    page.mouse.move(pointer.x, pointer.y).catch(() => {});
    // Sent as the pointer's own position, not the artwork's: the offset to the artwork
    // is the hotspot of whichever cursor the page turns out to be showing there.
    await page.evaluate(pageScript.moveCursor, pointer);
  } else if (options.focus) {
    await page.evaluate(pageScript.setFocused, { selector: options.focus, focused: focusedAt(frame / fps) });
  }
  // Scrolling and hovering both start animations, so pin after acting to catch them at
  // zero.
  await page.evaluate(pageScript.pinAnimations, (frame * 1000) / fps);
  const png = await captureFrame(captureDeps, captureState);
  if (!ffmpeg.stdin.write(png)) {
    await once(ffmpeg.stdin, 'drain');
  }
  // The rate is the one since the last line rather than the average since the start: an
  // average barely moves when a render stalls late, which is the case this line is here
  // to show.
  const now = Date.now();
  if (frame === 0 || frame === frameCount - 1 || now - lastReportAt >= PROGRESS_INTERVAL_MILLISECONDS) {
    const rate = (frame - lastReportFrame) / ((now - lastReportAt) / 1000);
    process.stderr.write(`\rframe ${frame + 1}/${frameCount} at ${rate.toFixed(1)} fps`);
    lastReportAt = now;
    lastReportFrame = frame;
  }
}
process.stderr.write('\n');
if (captureState.stillFrames > 0) {
  console.error(`the page drew nothing new for the last ${captureState.stillFrames} of ${frameCount} frames, which were filled with the frame before them`);
}
if (stalledBudgets > 0) {
  console.error(`${stalledBudgets} frames gave up waiting on the page's network after ${STALLED_BUDGET_MILLISECONDS / 1000}s; something on the page never finishes loading`);
}

await browser.close();
ffmpeg.stdin.end();
const [code] = await once(ffmpeg, 'close');
process.exit(code);

async function advanceVirtualTime(budget: number, policy: VirtualTimePolicy = 'pauseIfNetworkFetchesPending') {
  const abort = new AbortController();
  const expired = once(cdpEvents, 'Emulation.virtualTimeBudgetExpired', { signal: abort.signal })
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
