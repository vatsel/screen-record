/*
 * Records a web page to an mp4 frame by frame on a virtual clock. The browser's time
 * only moves when a frame is captured, so a 6 second recording is exactly 6 seconds of
 * page time however long the screenshots actually take. CSS animations are held paused
 * and scrubbed to each frame's own timestamp, which is what keeps the intro from being
 * skipped during page load and stops the animation clock outrunning the video.
 *
 * Needs ffmpeg on PATH and playwright's chromium installed. Node runs the TypeScript
 * directly (type stripping, Node 22.18+); there is no build step.
 *
 *   node record.ts --url https://example.com
 *       Six seconds of the page sitting at the top, 1440x900 at 2x.
 *
 *   node record.ts --url https://example.com --mobile --scroll
 *       Phone frame, panning from the top of the page to the bottom.
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
 */

import { spawn } from 'node:child_process';
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

// Virtual milliseconds handed to page load before the first frame. Too short and
// the recording opens on a half-built page; too long only wastes wall time, since
// the animations are held at zero throughout the settle either way.
const SETTLE_MILLISECONDS = 2000;

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
  },
});

if (!values.url) {
  console.error('usage: node record.ts --url <url> [--out out.mp4] [--fps 60] [--seconds 6] [--width] [--height] [--scale] [--mobile] [--scroll] [--hold 2]');
  console.error('  --mobile  414x736 at 3x (1242x2208) with a phone user agent and touch, the most common mobile viewport width (desktop default is 1440x900 at 2x)');
  console.error('  --scroll  pan from the top of the page to the bottom, holding still for --hold seconds at each end');
  console.error('            how fast it pans is set by the FLICK_* constants at the top of the file, not by a flag');
  console.error('  --linear  pan at one constant speed instead: no flicks, no pauses, no drift');
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

// The start times pinAnimations parks on the page live on window: it runs inside the
// browser, so a module-scoped variable here would not be there.
declare global {
  interface Window {
    animationStartTimes?: WeakMap<Animation, number>;
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
  const eased = flickFraction * flickFraction * (3 - 2 * flickFraction);
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
const capture = async () => Buffer.from(
  (await cdp.send('Page.captureScreenshot', { format: 'png' })).data,
  'base64',
);

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
if (values.scroll) {
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
  // Scrolling can start reveal animations, so pin after moving to catch them at zero.
  await page.evaluate(pinAnimations, (frame * 1000) / fps);
  // Advance before capturing, not after: captureScreenshot waits for a compositor
  // frame, and a page that happens to be visually static under paused virtual time
  // never produces one. Spending the budget first guarantees the frame exists.
  await advanceVirtualTime(1000 / fps);
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
if (stalledBudgets > 0) {
  console.error(`${stalledBudgets} frames gave up waiting on the page's network after ${STALLED_BUDGET_MILLISECONDS / 1000}s; something on the page never finishes loading`);
}

await browser.close();
ffmpeg.stdin.end();
const [code] = await once(ffmpeg, 'close');
process.exit(code);

async function advanceVirtualTime(budget: number) {
  const abort = new AbortController();
  const expired = once(cdp, 'Emulation.virtualTimeBudgetExpired', { signal: abort.signal })
    .then(() => true, () => false);
  const timedOut = delay(STALLED_BUDGET_MILLISECONDS, false, { signal: abort.signal })
    .catch(() => false);

  await cdp.send('Emulation.setVirtualTimePolicy', {
    policy: 'pauseIfNetworkFetchesPending',
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
