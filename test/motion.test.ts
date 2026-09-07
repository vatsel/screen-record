/* The pan model and the phases of an action shot. */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as C from '../lib/constants.ts';
import {
  countTravelFrames,
  derivePan,
  driftOutrunsFlicks,
  engagementAt,
  focusedAt,
  scrollOffsetAt,
  smoothstep,
} from '../lib/motion.ts';

const HEIGHT = 900;

describe('smoothstep', () => {
  test('runs 0 to 1 and is symmetric about its midpoint', () => {
    assert.equal(smoothstep(0), 0);
    assert.equal(smoothstep(1), 1);
    assert.equal(smoothstep(0.5), 0.5);
    for (let f = 0; f <= 0.5; f += 0.05) {
      assert.ok(Math.abs(smoothstep(f) + smoothstep(1 - f) - 1) < 1e-12);
    }
  });

  test('never goes backwards', () => {
    let previous = -1;
    for (let f = 0; f <= 1; f += 0.01) {
      const value = smoothstep(f);
      assert.ok(value >= previous, `${value} < ${previous} at ${f}`);
      previous = value;
    }
  });

  test('is flat at both ends, so nothing starts or stops with a jolt', () => {
    // The slope over the first and last hundredth is a fraction of the slope at the
    // middle; a linear ramp would make these equal.
    const startSlope = smoothstep(0.01) - smoothstep(0);
    const middleSlope = smoothstep(0.51) - smoothstep(0.5);
    const endSlope = smoothstep(1) - smoothstep(0.99);
    assert.ok(startSlope < middleSlope / 10);
    assert.ok(endSlope < middleSlope / 10);
  });
});

describe('derivePan', () => {
  test('a flick peaks at exactly the speed cap, drift included', () => {
    const pan = derivePan(HEIGHT);
    // Smoothstep's peak rate is 1.5x its average, and the drift is running underneath.
    const peak = pan.driftPixelsPerSecond + (1.5 * pan.flickDistancePixels) / pan.flickSeconds;
    assert.ok(Math.abs(peak - pan.flickMaxPixelsPerSecond) < 1e-9, `peak ${peak}`);
    assert.equal(pan.flickMaxPixelsPerSecond, C.FLICK_MAX_SPEED_IN_VIEWPORTS_PER_SECOND * HEIGHT);
  });

  test('a viewport twice as tall covers twice the pixels in the same time', () => {
    const small = derivePan(400);
    const large = derivePan(800);
    assert.equal(large.flickSeconds, small.flickSeconds);
    assert.equal(large.flickPeriodSeconds, small.flickPeriodSeconds);
    assert.equal(large.flickDistancePixels, small.flickDistancePixels * 2);
    assert.equal(scrollOffsetAt(large, 1.7), scrollOffsetAt(small, 1.7) * 2);
  });

  test('the pause between flicks is the period less the flick', () => {
    const pan = derivePan(HEIGHT);
    assert.ok(Math.abs(pan.flickPeriodSeconds - pan.flickSeconds - C.FLICK_PAUSE_IN_SECONDS) < 1e-12);
  });

  test('reports when the drift has eaten the whole speed cap', () => {
    assert.equal(driftOutrunsFlicks(derivePan(HEIGHT)), false);
    const starved = { ...derivePan(HEIGHT), driftPixelsPerSecond: 1e6 };
    assert.equal(driftOutrunsFlicks(starved), true);
  });
});

describe('scrollOffsetAt', () => {
  const pan = derivePan(HEIGHT);

  test('starts at the top', () => {
    assert.equal(scrollOffsetAt(pan, 0), 0);
  });

  test('never scrolls backwards', () => {
    let previous = -1;
    for (let seconds = 0; seconds < 30; seconds += 1 / 60) {
      const offset = scrollOffsetAt(pan, seconds);
      assert.ok(offset >= previous, `${offset} < ${previous} at ${seconds}s`);
      previous = offset;
    }
  });

  test('one whole period is one flick plus the drift that ran through it', () => {
    const covered = scrollOffsetAt(pan, pan.flickPeriodSeconds) - scrollOffsetAt(pan, 0);
    const expected = pan.flickDistancePixels + pan.driftPixelsPerSecond * pan.flickPeriodSeconds;
    assert.ok(Math.abs(covered - expected) < 1e-9);
  });

  test('only the drift moves during the pause', () => {
    const landed = scrollOffsetAt(pan, pan.flickSeconds);
    const later = scrollOffsetAt(pan, pan.flickSeconds + 0.5);
    assert.ok(Math.abs(later - landed - pan.driftPixelsPerSecond * 0.5) < 1e-9);
  });

  test('never exceeds the speed cap', () => {
    const step = 1 / 240;
    for (let seconds = 0; seconds < 12; seconds += step) {
      const speed = (scrollOffsetAt(pan, seconds + step) - scrollOffsetAt(pan, seconds)) / step;
      assert.ok(speed <= pan.flickMaxPixelsPerSecond + 1, `${speed}px/s at ${seconds}s`);
    }
  });

  test('--linear is one flat speed with nothing riding on it', () => {
    const flat = derivePan(HEIGHT, { linear: true });
    for (const seconds of [0, 0.5, 3, 11.25]) {
      assert.equal(scrollOffsetAt(flat, seconds), flat.linearPixelsPerSecond * seconds);
    }
  });
});

describe('countTravelFrames', () => {
  const pan = derivePan(HEIGHT);

  test('stops on the first frame that has covered the page, not before', () => {
    const scrollableHeight = 4000;
    const frames = countTravelFrames({ pan, fps: 60, scrollableHeight });
    assert.ok(scrollOffsetAt(pan, frames / 60) >= scrollableHeight);
    assert.ok(scrollOffsetAt(pan, (frames - 1) / 60) < scrollableHeight);
  });

  test('an unscrollable page needs no travel at all', () => {
    assert.equal(countTravelFrames({ pan, fps: 60, scrollableHeight: 0 }), 0);
  });

  test('a pan that never moves hits the cap instead of spinning forever', () => {
    const stuck = { ...pan, driftPixelsPerSecond: 0, flickDistancePixels: 0 };
    const frames = countTravelFrames({ pan: stuck, fps: 30, scrollableHeight: 5000 });
    assert.equal(frames, 30 * C.MAX_PAN_SECONDS);
  });
});

describe('action phases', () => {
  const engageStart = C.ACTION_LEAD_IN_SECONDS;
  const dwellStart = engageStart + C.ACTION_ENGAGE_SECONDS;
  const disengageStart = dwellStart + C.ACTION_DWELL_SECONDS;
  const leadOutStart = disengageStart + C.ACTION_DISENGAGE_SECONDS;

  test('ACTION_SECONDS is the five phases and nothing else', () => {
    assert.equal(C.ACTION_SECONDS, leadOutStart + C.ACTION_LEAD_OUT_SECONDS);
  });

  test('engagement is idle, rises, holds, falls, idle', () => {
    assert.equal(engagementAt(0), 0);
    assert.equal(engagementAt(engageStart - 0.01), 0);
    assert.equal(engagementAt(engageStart), 0);
    assert.ok(engagementAt(engageStart + C.ACTION_ENGAGE_SECONDS / 2) > 0.4);
    assert.equal(engagementAt(dwellStart), 1);
    assert.equal(engagementAt(disengageStart - 0.01), 1);
    assert.ok(engagementAt(disengageStart + C.ACTION_DISENGAGE_SECONDS / 2) < 0.6);
    assert.equal(engagementAt(leadOutStart), 0);
    assert.equal(engagementAt(C.ACTION_SECONDS), 0);
  });

  test('engagement has no jumps at the phase boundaries', () => {
    const step = 1e-4;
    let previous = engagementAt(0);
    for (let seconds = step; seconds <= C.ACTION_SECONDS; seconds += step) {
      const value = engagementAt(seconds);
      assert.ok(Math.abs(value - previous) < 0.01, `jump to ${value} at ${seconds}s`);
      previous = value;
    }
  });

  test('focus lands when the engage phase opens and leaves when it closes', () => {
    assert.equal(focusedAt(0), false);
    assert.equal(focusedAt(engageStart - 0.01), false);
    assert.equal(focusedAt(engageStart), true);
    assert.equal(focusedAt(dwellStart), true);
    assert.equal(focusedAt(disengageStart - 0.01), true);
    assert.equal(focusedAt(disengageStart), false);
    assert.equal(focusedAt(C.ACTION_SECONDS), false);
  });
});
