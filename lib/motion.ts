/* When things move: the pan model, and the phases of an --hover/--focus shot. Pure. */

import {
  ACTION_DISENGAGE_SECONDS,
  ACTION_DWELL_SECONDS,
  ACTION_ENGAGE_SECONDS,
  ACTION_LEAD_IN_SECONDS,
  DRIFT_VIEWPORTS_PER_SECOND,
  FLICK_DISTANCE_IN_VIEWPORTS,
  FLICK_MAX_SPEED_IN_VIEWPORTS_PER_SECOND,
  FLICK_PAUSE_IN_SECONDS,
  LINEAR_SPEED_IN_VIEWPORTS_PER_SECOND,
  MAX_PAN_SECONDS,
} from './constants.ts';
import type { PanMotion } from './types.ts';

// Ease in and out: 0 at 0, 1 at 1, flat at both ends so nothing starts or stops with a
// jolt.
export function smoothstep(fraction: number) {
  return fraction * fraction * (3 - 2 * fraction);
}

// Scrolling is vertical, so the viewport height is the screen dimension the motion
// constants are measured against.
export function derivePan(viewportHeight: number, { linear = false } = {}): PanMotion {
  const driftPixelsPerSecond = DRIFT_VIEWPORTS_PER_SECOND * viewportHeight;
  const flickDistancePixels = FLICK_DISTANCE_IN_VIEWPORTS * viewportHeight;
  const flickMaxPixelsPerSecond = FLICK_MAX_SPEED_IN_VIEWPORTS_PER_SECOND * viewportHeight;
  const linearPixelsPerSecond = LINEAR_SPEED_IN_VIEWPORTS_PER_SECOND * viewportHeight;

  // The cap covers everything on screen and the drift is already spending part of it, so
  // the flick itself only gets what's left. Smoothstep tops out at 1.5x its own average,
  // so covering flickDistancePixels within that budget takes exactly this long.
  const flickPixelsPerSecond = Math.max(flickMaxPixelsPerSecond - driftPixelsPerSecond, 1);
  const flickSeconds = (1.5 * flickDistancePixels) / flickPixelsPerSecond;

  return {
    linear,
    driftPixelsPerSecond,
    flickDistancePixels,
    flickMaxPixelsPerSecond,
    flickPixelsPerSecond,
    flickSeconds,
    flickPeriodSeconds: flickSeconds + FLICK_PAUSE_IN_SECONDS,
    linearPixelsPerSecond,
  };
}

// The drift is spent out of the same speed cap the flicks are, so a drift at or above
// the cap leaves them nothing to move in and the pan is a flat crawl.
export function driftOutrunsFlicks(pan: PanMotion) {
  return pan.flickMaxPixelsPerSecond <= pan.driftPixelsPerSecond;
}

// Where the pan has got to, in CSS pixels, this far into the travel. The drift runs
// the whole time; each completed flick has added its distance, and the one in progress
// adds its share on a smoothstep so it eases in and out rather than snapping.
export function scrollOffsetAt(pan: PanMotion, seconds: number) {
  // --linear is the whole model: one speed, start to finish, nothing riding on top.
  if (pan.linear) {
    return pan.linearPixelsPerSecond * seconds;
  }
  const flicksDone = Math.floor(seconds / pan.flickPeriodSeconds);
  const withinPeriod = seconds - flicksDone * pan.flickPeriodSeconds;
  // Past flickSeconds the flick has landed and the rest of the period is the pause.
  const flickFraction = Math.min(withinPeriod / pan.flickSeconds, 1);
  const eased = smoothstep(flickFraction);
  return pan.driftPixelsPerSecond * seconds + pan.flickDistancePixels * (flicksDone + eased);
}

// Panning holds the pace fixed and lets the page height decide the duration. Nothing to
// solve, just step forward until the offset has covered the page. Capped so a drift and
// flick distance of both zero can't spin here forever.
export function countTravelFrames(
  { pan, fps, scrollableHeight }: { pan: PanMotion; fps: number; scrollableHeight: number },
) {
  let frames = 0;
  while (scrollOffsetAt(pan, frames / fps) < scrollableHeight && frames < fps * MAX_PAN_SECONDS) {
    frames += 1;
  }
  return frames;
}

// How far the action has got, 0 idle to 1 fully engaged, this far into the shot. Hover
// reads it as a position along the pointer's path.
export function engagementAt(seconds: number) {
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
export function focusedAt(seconds: number) {
  const focusedUntil = ACTION_LEAD_IN_SECONDS + ACTION_ENGAGE_SECONDS + ACTION_DWELL_SECONDS;
  return seconds >= ACTION_LEAD_IN_SECONDS && seconds < focusedUntil;
}
