/* Taking one frame, and telling a late frame apart from a page that has stopped drawing.
 *
 * The browser is reached through injected callbacks rather than a CDP session, because
 * the whole subtlety here is the *order* of the two calls and how long each is waited
 * on, and that is worth being able to test without a browser.
 */

import { setTimeout as delay } from 'node:timers/promises';
import {
  STALLED_BUDGET_MILLISECONDS,
  STILL_FRAME_MILLISECONDS,
  STILL_FRAME_NUDGES,
} from './constants.ts';
import type { CaptureState, PendingShot, VirtualTimePolicy } from './types.ts';

export type CaptureDeps = {
  // Asks the compositor for a picture. Answered by the next frame it draws.
  screenshot: () => Promise<{ data: string }>;
  // Spends virtual time. The policy is the one the recording normally runs on unless a
  // nudge overrides it.
  advance: (budget: number, policy?: VirtualTimePolicy) => Promise<void>;
  frameBudgetMilliseconds: number;
  stillFrameMilliseconds?: number;
  stalledBudgetMilliseconds?: number;
  nudges?: number;
};

// Waits for the compositor to answer, or gives up and says so. Giving up here does not
// end the request -- see PendingShot.
async function settle(shot: PendingShot, patience: number) {
  const abort = new AbortController();
  const drawn = await Promise.race([
    shot.promise,
    delay(patience, undefined, { signal: abort.signal }).then(() => undefined, () => undefined),
  ]);
  abort.abort();
  return drawn;
}

// Asks for a picture, and tracks whether that request is still outstanding. A rejection
// reads as "no frame" rather than throwing: a CDP error and a page that drew nothing get
// the same fallback, and the recording carries on.
function issueShot(deps: CaptureDeps): PendingShot {
  const pending: PendingShot = {
    settled: false,
    promise: deps.screenshot().then(
      (frame) => { pending.settled = true; return frame; },
      () => { pending.settled = true; return undefined; },
    ),
  };
  return pending;
}

// ponytail: page.screenshot() waits for the page to look stable and hangs once the
// animations are pinned, so the caller goes straight to CDP, which just grabs the
// surface.
//
// A screenshot is answered by the next frame the compositor draws, so the request has to
// be in flight *before* the clock runs, not after it has already stopped -- asking
// afterwards is a race the recording loses at random, and loses outright on a machine
// busy enough that the frame lands first. Spending the frame's budget is therefore part
// of taking the picture, which is why the advance lives in here.
//
// If a shot goes unanswered anyway, the frame already in hand is handed to ffmpeg again.
// That is a fallback, not the normal path: measured against Chromium 1.63, a static page
// with no animation, no network and a paused clock still answers every screenshot in
// ~33ms. An earlier version of this file assumed the opposite -- that a page drawing
// nothing never answers -- and shortened the wait for any frame following a still one.
// That halved the patience of exactly the frames most likely to be slow, so one slow
// frame latched the recording into repeating its last image to the end, at 500ms a frame,
// behind a zero exit code. Every frame now gets the same full wait. If you are tempted to
// make a still page cheaper by waiting less, measure first: the saving is imaginary
// because the shot resolves, and the freeze is real.
export async function captureFrame(deps: CaptureDeps, state: CaptureState): Promise<Buffer> {
  const stillPatience = deps.stillFrameMilliseconds ?? STILL_FRAME_MILLISECONDS;
  const stalledPatience = deps.stalledBudgetMilliseconds ?? STALLED_BUDGET_MILLISECONDS;
  const nudges = deps.nudges ?? STILL_FRAME_NUDGES;

  // A shot still outstanding from an earlier frame is waited on again rather than
  // replaced. Every frame asks for the identical picture -- clip and format are fixed
  // before the loop -- so an answer requested at an earlier frame is a valid picture for
  // this one, taken at whatever moment the compositor finally presented. Issuing a second
  // request instead is what used to turn a stalled compositor into a permanent freeze.
  // A shot is kept until its answer has been used, not until it resolves -- one that lands
  // in the gap between two frames still holds a picture nobody has taken yet.
  const shot = state.pending ?? issueShot(deps);
  state.pending = shot;

  await deps.advance(deps.frameBudgetMilliseconds);

  // A frame that has not arrived is nearly always just late, so it gets the full wait --
  // the same wait whether or not the frame before it was still. Then one nudge, since a
  // late frame lands the moment virtual time runs again. Plain advance for the nudge,
  // since pauseIfNetworkFetchesPending will not move the clock at all while the page has
  // a request outstanding, which is when wedges tend to happen.
  let drawn = await settle(shot, state.lastFrame ? stillPatience : stalledPatience);
  for (let nudge = 0; !drawn && state.lastFrame && nudge < nudges; nudge++) {
    await deps.advance(deps.frameBudgetMilliseconds, 'advance');
    drawn = await settle(shot, stillPatience);
  }

  // A shot that settled without a frame -- a CDP error reaching the rejection arm of
  // issueShot -- must be dropped, or every later frame waits on a promise already
  // resolved to nothing and no screenshot is ever asked for again.
  if (shot.settled && !drawn) {
    state.pending = undefined;
  }

  if (drawn) {
    state.pending = undefined;
    state.stillFrames = 0;
    state.lastFrame = Buffer.from(drawn.data, 'base64');
    return state.lastFrame;
  }
  if (!state.lastFrame) {
    // Nothing to fall back on: the first frame is the one the whole recording is built
    // from, and a page that cannot draw it once cannot be recorded at all.
    throw new Error(`the page drew no frame at all within ${stalledPatience / 1000}s, so there is nothing to record`);
  }
  // Nothing was drawn because nothing changed, so the frame already in hand is still
  // what the page looks like. ponytail: the count is the streak rather than the total,
  // which is all the closing line needs it for.
  state.stillFrames += 1;
  return state.lastFrame;
}
