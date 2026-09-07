/* The crop an action is recorded through, and the pointer's path across it. */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ACTION_LEAD_IN_SECONDS,
  ACTION_PADDING_PIXELS,
  ACTION_POINTER_CLEARANCE_PIXELS,
  ACTION_SECONDS,
  ACTION_ENGAGE_SECONDS,
} from '../lib/constants.ts';
import { computeCrop, pointerPositionAt } from '../lib/layout.ts';
import type { TargetBox } from '../lib/types.ts';

const VIEWPORT = { width: 1440, height: 900 };

function box(overrides: Partial<TargetBox> = {}): TargetBox {
  return { left: 600, top: 400, right: 800, bottom: 440, scrollX: 0, scrollY: 0, ...overrides };
}

describe('computeCrop', () => {
  test('is the element plus a margin on every side', () => {
    const { clip } = computeCrop({ target: box(), ...VIEWPORT });
    assert.equal(clip.x, 600 - ACTION_PADDING_PIXELS);
    assert.equal(clip.y, 400 - ACTION_PADDING_PIXELS);
    assert.equal(clip.width, 200 + 2 * ACTION_PADDING_PIXELS);
    assert.equal(clip.height, 40 + 2 * ACTION_PADDING_PIXELS);
  });

  test('clamps to the viewport rather than cropping off the edge of the page', () => {
    const target = box({ left: 10, top: 5, right: 1435, bottom: 895 });
    const { clip } = computeCrop({ target, ...VIEWPORT });
    assert.equal(clip.x, 0);
    assert.equal(clip.y, 0);
    assert.equal(clip.width, VIEWPORT.width);
    assert.equal(clip.height, VIEWPORT.height);
  });

  test('the clip is in page coordinates and the pointer in viewport ones', () => {
    const target = box({ scrollX: 30, scrollY: 1200 });
    const { clip, pointerOnTarget } = computeCrop({ target, ...VIEWPORT });
    assert.equal(clip.x, 600 - ACTION_PADDING_PIXELS + 30);
    assert.equal(clip.y, 400 - ACTION_PADDING_PIXELS + 1200);
    // The mouse never learns about the scroll offset.
    assert.equal(pointerOnTarget.x, 700);
    assert.equal(pointerOnTarget.y, 420);
  });

  test('clip.scale stays 1, because the device metrics override already applies --scale', () => {
    const { clip } = computeCrop({ target: box(), ...VIEWPORT });
    assert.equal(clip.scale, 1);
  });

  test('a fractional rect still gives whole-pixel frame dimensions', () => {
    const target = box({ left: 600.4, top: 400.6, right: 800.3, bottom: 440.7 });
    const { clip } = computeCrop({ target, ...VIEWPORT });
    // libx264 refuses a stream whose frames change size, so these must not depend on
    // where the element happened to land within a pixel.
    assert.equal(clip.width, Math.round(clip.width));
    assert.equal(clip.height, Math.round(clip.height));
    assert.equal(clip.x, Math.round(clip.x));
    assert.equal(clip.y, Math.round(clip.y));
  });

  test('the pointer waits below the crop when there is room for it', () => {
    const { clip, pointerHome, pointerOnTarget } = computeCrop({ target: box(), ...VIEWPORT });
    assert.ok(pointerHome.y > clip.y + clip.height, 'starts below the crop');
    assert.ok(pointerHome.x < pointerOnTarget.x, 'and off to one side');
  });

  test('and above it when the crop already reaches the bottom of the viewport', () => {
    // Chrome clamps mouse coordinates into the viewport, so a start point below the fold
    // would read as a pointer that arrived and never left.
    const target = box({ top: 820, bottom: 890 });
    const { clip, pointerHome } = computeCrop({ target, ...VIEWPORT });
    assert.ok(pointerHome.y < clip.y, 'starts above the crop');
  });

  test('the pointer always starts somewhere the mouse can actually be', () => {
    const corners = [
      box({ left: 0, top: 0, right: 40, bottom: 20 }),
      box({ left: 1400, top: 860, right: 1440, bottom: 900 }),
      box({ left: 0, top: 860, right: 30, bottom: 900 }),
    ];
    for (const target of corners) {
      const { pointerHome } = computeCrop({ target, ...VIEWPORT });
      assert.ok(pointerHome.x >= 0 && pointerHome.x <= VIEWPORT.width - 1, `x ${pointerHome.x}`);
      assert.ok(pointerHome.y >= 0 && pointerHome.y <= VIEWPORT.height - 1, `y ${pointerHome.y}`);
    }
  });

  test('the margin leaves room for the pointer to be seen arriving', () => {
    // The clearance clears the tallest system cursor; the padding is what keeps the
    // approach inside the frame rather than the pointer popping into existence.
    assert.ok(ACTION_POINTER_CLEARANCE_PIXELS > ACTION_PADDING_PIXELS);
  });
});

describe('pointerPositionAt', () => {
  const path = computeCrop({ target: box(), ...VIEWPORT });

  test('waits at home, arrives, holds, and goes back', () => {
    assert.deepEqual(pointerPositionAt(0, path), path.pointerHome);
    assert.deepEqual(pointerPositionAt(ACTION_LEAD_IN_SECONDS, path), path.pointerHome);
    const dwell = ACTION_LEAD_IN_SECONDS + ACTION_ENGAGE_SECONDS + 0.1;
    assert.deepEqual(pointerPositionAt(dwell, path), path.pointerOnTarget);
    assert.deepEqual(pointerPositionAt(ACTION_SECONDS, path), path.pointerHome);
  });

  test('never leaves the line between the two', () => {
    const { pointerHome: home, pointerOnTarget: onTarget } = path;
    for (let seconds = 0; seconds <= ACTION_SECONDS; seconds += 1 / 60) {
      const at = pointerPositionAt(seconds, path);
      assert.ok(at.x >= Math.min(home.x, onTarget.x) && at.x <= Math.max(home.x, onTarget.x));
      assert.ok(at.y >= Math.min(home.y, onTarget.y) && at.y <= Math.max(home.y, onTarget.y));
    }
  });
});
