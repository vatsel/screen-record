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
import type { CaptureState, VirtualTimePolicy } from './types.ts';

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

// Waits for the compositor to answer, or gives up and says so.
async function settle(shot: Promise<{ data: string }>, patience: number) {
  const abort = new AbortController();
  const drawn = await Promise.race([
    shot.then((frame) => frame, () => undefined),
    delay(patience, undefined, { signal: abort.signal }).then(() => undefined, () => undefined),
  ]);
  abort.abort();
  return drawn;
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
// A page that draws nothing never answers at all, and that is not a failure: nothing was
// redrawn because nothing changed, so the frame already in hand is still what the page
// looks like. Handing that one to ffmpeg again is the honest answer, and the only one
// available -- a page with no animation, no scrolling and no pointer on it produces
// exactly one frame however long it is recorded for.
export async function captureFrame(deps: CaptureDeps, state: CaptureState): Promise<Buffer> {
  const stillPatience = deps.stillFrameMilliseconds ?? STILL_FRAME_MILLISECONDS;
  const stalledPatience = deps.stalledBudgetMilliseconds ?? STALLED_BUDGET_MILLISECONDS;
  const nudges = deps.nudges ?? STILL_FRAME_NUDGES;

  const shot = deps.screenshot();
  // A shot that is given up on still settles later, against a session that may be
  // closed by then; nothing is waiting on it to notice.
  shot.catch(() => {});

  await deps.advance(deps.frameBudgetMilliseconds);

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
  const patience = state.stillFrames > 0 ? 0 : stillPatience;
  let drawn = await settle(shot, state.lastFrame ? patience : stalledPatience);
  for (let nudge = 0; !drawn && state.lastFrame && nudge < nudges; nudge++) {
    await deps.advance(deps.frameBudgetMilliseconds, 'advance');
    drawn = await settle(shot, stillPatience);
  }

  if (drawn) {
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
