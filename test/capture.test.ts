/* One frame: the order the browser is asked in, and telling a late frame apart from a
 * page that has stopped drawing. The browser is faked -- what is under test is the
 * sequencing, not chromium. */

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { captureFrame, type CaptureDeps } from '../lib/capture.ts';
import type { CaptureState } from '../lib/types.ts';

const PNG = Buffer.from('a frame');
const DATA = PNG.toString('base64');

// A stand-in browser that writes down what it was asked and when. `frame` decides how a
// screenshot is answered: 'now', 'never', or 'on-nudge' for one that only lands once
// virtual time runs again.
function fakeBrowser({ frame = 'now' as 'now' | 'never' | 'on-nudge' } = {}) {
  const calls: string[] = [];
  const advances: (string | undefined)[] = [];
  let release: (() => void) | undefined;

  const deps: CaptureDeps = {
    screenshot: () => {
      calls.push('screenshot');
      if (frame === 'now') return Promise.resolve({ data: DATA });
      return new Promise((resolve) => {
        if (frame === 'never') return;
        release = () => resolve({ data: DATA });
      });
    },
    advance: async (budget, policy) => {
      calls.push(`advance:${policy ?? 'default'}`);
      advances.push(policy);
      // A late frame is one the compositor hands over the moment the clock runs again.
      if (frame === 'on-nudge' && policy === 'advance') release?.();
      await delay(1);
    },
    frameBudgetMilliseconds: 1000 / 60,
    stillFrameMilliseconds: 40,
    stalledBudgetMilliseconds: 120,
  };
  return { deps, calls, advances };
}

describe('a frame the page draws', () => {
  test('is asked for before the clock runs, not after', async () => {
    // Asking afterwards races the frame the compositor already drew, and loses at random.
    const { deps, calls } = fakeBrowser();
    const state: CaptureState = { stillFrames: 0 };
    await captureFrame(deps, state);
    assert.deepEqual(calls, ['screenshot', 'advance:default']);
  });

  test('comes back decoded and resets the still streak', async () => {
    const { deps } = fakeBrowser();
    const state: CaptureState = { stillFrames: 3, lastFrame: Buffer.from('old') };
    const png = await captureFrame(deps, state);
    assert.deepEqual(png, PNG);
    assert.deepEqual(state.lastFrame, PNG);
    assert.equal(state.stillFrames, 0);
  });

  test('spends exactly one frame of virtual time', async () => {
    const budgets: number[] = [];
    const { deps } = fakeBrowser();
    const spied = { ...deps, advance: async (budget: number) => { budgets.push(budget); } };
    await captureFrame(spied, { stillFrames: 0 });
    assert.deepEqual(budgets, [1000 / 60]);
  });
});

describe('a frame that is merely late', () => {
  test('is freed by one nudge, on the plain policy', async () => {
    const { deps, calls, advances } = fakeBrowser({ frame: 'on-nudge' });
    const state: CaptureState = { stillFrames: 0, lastFrame: Buffer.from('old') };
    const png = await captureFrame(deps, state);
    assert.deepEqual(png, PNG, 'the late frame was used');
    assert.equal(state.stillFrames, 0, 'and was not mistaken for a still page');
    assert.deepEqual(calls, ['screenshot', 'advance:default', 'advance:advance']);
    // pauseIfNetworkFetchesPending will not move the clock at all while a request is
    // outstanding, which is exactly when a frame gets stuck.
    assert.deepEqual(advances, [undefined, 'advance']);
  });

  test('gets the long patience on the very first frame, where there is no fallback', async () => {
    // Slower than the still-frame patience, faster than the stalled-budget one.
    const deps: CaptureDeps = {
      screenshot: () => delay(70, { data: DATA }),
      advance: async () => {},
      frameBudgetMilliseconds: 16,
      stillFrameMilliseconds: 20,
      stalledBudgetMilliseconds: 300,
    };
    const png = await captureFrame(deps, { stillFrames: 0 });
    assert.deepEqual(png, PNG);
  });
});

describe('a page that has stopped drawing', () => {
  test('has its last frame handed over again', async () => {
    const { deps } = fakeBrowser({ frame: 'never' });
    const previous = Buffer.from('previous');
    const state: CaptureState = { stillFrames: 0, lastFrame: previous };
    assert.deepEqual(await captureFrame(deps, state), previous);
    assert.equal(state.stillFrames, 1);
    assert.deepEqual(await captureFrame(deps, state), previous);
    assert.equal(state.stillFrames, 2);
  });

  test('stops being waited on once it is known to be still', async () => {
    // A static page would otherwise cost the full patience on every one of its frames.
    const { deps } = fakeBrowser({ frame: 'never' });
    const state: CaptureState = { stillFrames: 0, lastFrame: Buffer.from('previous') };

    const startedFirst = Date.now();
    await captureFrame(deps, state);
    const firstFrame = Date.now() - startedFirst;

    const startedSecond = Date.now();
    await captureFrame(deps, state);
    const secondFrame = Date.now() - startedSecond;

    // The first waits, then nudges and waits again; the second goes straight to the
    // nudge. The wait after a nudge is never shortened -- that one is the test.
    assert.ok(secondFrame < firstFrame - 15, `${secondFrame}ms vs ${firstFrame}ms`);
  });

  test('and draws again the moment it has something new', async () => {
    const { deps: still } = fakeBrowser({ frame: 'never' });
    const state: CaptureState = { stillFrames: 0, lastFrame: Buffer.from('previous') };
    await captureFrame(still, state);
    assert.equal(state.stillFrames, 1);

    const { deps: drawing } = fakeBrowser();
    assert.deepEqual(await captureFrame(drawing, state), PNG);
    assert.equal(state.stillFrames, 0);
  });
});

describe('a page that never draws at all', () => {
  test('cannot be recorded, and says so instead of writing an empty file', async () => {
    const { deps } = fakeBrowser({ frame: 'never' });
    await assert.rejects(
      () => captureFrame(deps, { stillFrames: 0 }),
      /drew no frame at all within 0\.12s/,
    );
  });

  test('is not nudged, because there is no frame in hand to compare against', async () => {
    const { deps, advances } = fakeBrowser({ frame: 'never' });
    await captureFrame(deps, { stillFrames: 0 }).catch(() => {});
    assert.deepEqual(advances, [undefined]);
  });
});
