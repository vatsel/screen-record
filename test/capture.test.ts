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

// A stand-in browser that answers screenshots the way Chromium does rather than the way
// a mock finds convenient: a request stays live until the compositor presents, and giving
// up on one does not cancel it. `present()` answers the whole backlog at once, which is
// what a real browser does when a throttled virtual clock finally lets it draw.
function queuedBrowser({ fails = false } = {}) {
  const waiting: ((frame: { data: string }) => void)[] = [];
  let issued = 0;

  const deps: CaptureDeps = {
    screenshot: () => {
      issued += 1;
      if (fails) return Promise.reject(new Error('Target closed'));
      return new Promise((resolve) => waiting.push(resolve));
    },
    advance: async () => { await delay(1); },
    frameBudgetMilliseconds: 1000 / 60,
    stillFrameMilliseconds: 40,
    stalledBudgetMilliseconds: 120,
  };
  return {
    deps,
    present: () => { for (const resolve of waiting.splice(0)) resolve({ data: DATA }); },
    get issued() { return issued; },
  };
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

  test('is still waited on in full, so one slow frame cannot latch the recording', async () => {
    // The bug this replaces: a frame following a still one used to skip the wait before
    // the nudge, so it got half the patience of a fresh frame -- and the frames most
    // likely to be slow are the ones right after a slow frame. One slow frame then
    // latched the recording into repeating its last image to the end, behind a zero exit
    // code. A shot slower than one patience but well inside two has to still land.
    const deps: CaptureDeps = {
      screenshot: () => delay(90, { data: DATA }),
      advance: async () => {},
      frameBudgetMilliseconds: 16,
      stillFrameMilliseconds: 60,
      stalledBudgetMilliseconds: 300,
    };
    const state: CaptureState = { stillFrames: 4, lastFrame: Buffer.from('previous') };

    assert.deepEqual(await captureFrame(deps, state), PNG, 'the slow frame was used');
    assert.equal(state.stillFrames, 0, 'and the streak was broken rather than latched');
  });

  test('and draws again the moment it has something new', async () => {
    const browser = queuedBrowser();
    const state: CaptureState = { stillFrames: 0, lastFrame: Buffer.from('previous') };
    await captureFrame(browser.deps, state);
    assert.equal(state.stillFrames, 1);

    // The compositor presents at last, in the gap between two frames.
    browser.present();
    assert.deepEqual(await captureFrame(browser.deps, state), PNG);
    assert.equal(state.stillFrames, 0);
  });
});

describe('a shot the browser has not answered yet', () => {
  test('is waited on again rather than asked for a second time', async () => {
    // Giving up on a captureScreenshot does not cancel it, and Chromium answers them in
    // order, so a second request just queues behind the stuck one. Asking again per frame
    // is what turned a stalled compositor into a recording frozen to the end.
    const browser = queuedBrowser();
    const state: CaptureState = { stillFrames: 0, lastFrame: Buffer.from('previous') };
    await captureFrame(browser.deps, state);
    await captureFrame(browser.deps, state);
    await captureFrame(browser.deps, state);
    assert.equal(browser.issued, 1, 'one request outstanding, not one per frame');
    assert.equal(state.stillFrames, 3);
  });

  test('is adopted on the frame it finally arrives at, however late that is', async () => {
    const browser = queuedBrowser();
    const state: CaptureState = { stillFrames: 0, lastFrame: Buffer.from('previous') };
    for (let frame = 0; frame < 5; frame++) await captureFrame(browser.deps, state);
    assert.equal(state.stillFrames, 5);

    browser.present();
    assert.deepEqual(await captureFrame(browser.deps, state), PNG, 'the late answer was used');
    assert.equal(state.stillFrames, 0, 'and the streak broken');
    assert.equal(browser.issued, 1);
  });

  test('is dropped rather than carried when the request itself failed', async () => {
    // The trap: a rejected shot resolves to "no frame", which reads exactly like a still
    // page. Carrying it would mean waiting forever on an already-settled promise and
    // never asking for another picture.
    const browser = queuedBrowser({ fails: true });
    const state: CaptureState = { stillFrames: 0, lastFrame: Buffer.from('previous') };
    assert.deepEqual(await captureFrame(browser.deps, state), Buffer.from('previous'));
    await captureFrame(browser.deps, state);
    assert.equal(browser.issued, 2, 'a fresh request each frame, not a dead one carried');
  });

  test('costs a static page one request for the whole recording', async () => {
    const browser = queuedBrowser();
    const state: CaptureState = { stillFrames: 0, lastFrame: Buffer.from('previous') };
    for (let frame = 0; frame < 10; frame++) await captureFrame(browser.deps, state);
    assert.equal(browser.issued, 1);
    assert.equal(state.stillFrames, 10);
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
