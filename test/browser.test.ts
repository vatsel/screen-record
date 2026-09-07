/* The assumptions about chromium the recorder is built on. These need a real browser --
 * that is the point of them: a fake DOM would agree with whatever we believed. */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, describe, test, type TestContext } from 'node:test';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright';
import { systemCursors } from '../lib/cursors.ts';
import * as pageScript from '../lib/page.ts';
import type { SystemCursor } from '../lib/types.ts';

const FIXTURE = pathToFileURL(fileURLToPath(new URL('./fixtures/page.html', import.meta.url))).href;

// One transparent pixel each: what is under test is which image is shown and where, not
// what it looks like. Sized and hotspotted differently so the two are told apart.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const CURSORS: Record<string, SystemCursor> = {
  default: { width: 24, height: 24, hotspotX: 4, hotspotY: 4, png: PIXEL },
  pointer: { width: 20, height: 26, hotspotX: 6, hotspotY: 2, png: PIXEL },
};

let browser: Browser;
before(async () => {
  browser = await chromium.launch();
}, { timeout: 60000 });
after(async () => browser?.close());

// The recorder's own setup, minus ffmpeg: a frozen clock, the fixture loaded, and the
// load settled on a fixed budget.
async function openFixture(t: TestContext, { scale = 1, frozen = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: scale });
  // Registered before anything can throw: a page left open holds a frozen clock and a
  // running animation, and the next test inherits the mess.
  t.after(() => page.close());
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 800, height: 600, deviceScaleFactor: scale, mobile: false,
  });
  const advance = async (budget: number, policy = 'pauseIfNetworkFetchesPending') => {
    const expired = once(cdp, 'Emulation.virtualTimeBudgetExpired');
    await cdp.send('Emulation.setVirtualTimePolicy', { policy, budget, maxVirtualTimeTaskStarvationCount: 10000 });
    await expired;
  };
  if (frozen) await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
  await page.goto(FIXTURE, { waitUntil: frozen ? 'commit' : 'load' });
  if (frozen) await advance(2000);
  return { page, cdp, advance };
}

// Width and height live in the IHDR chunk, at a fixed offset in every PNG.
function pngSize(png: Buffer) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function centreOf(page: Page, selector: string) {
  return page.evaluate((s) => {
    const rect = document.querySelector(s)!.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  }, selector);
}

describe('the virtual clock', () => {
  test('does not move until a budget is spent, and then moves by exactly it', async (t) => {
    const { page, advance } = await openFixture(t);
    const before = await page.evaluate(() => Date.now());
    // Plenty of wall time, none of it virtual.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await page.evaluate(() => Date.now()), before, 'the page saw wall time pass');

    await advance(1000);
    const after = await page.evaluate(() => Date.now());
    assert.ok(Math.abs(after - before - 1000) <= 50, `moved ${after - before}ms`);
  });
});

describe('pinAnimations', () => {
  test('holds every document-timeline animation and scrubs it to the frame time', async (t) => {
    const { page } = await openFixture(t);
    const states = () => page.evaluate(() => document.getAnimations()
      .filter((a) => a.timeline === document.timeline)
      .map((a) => ({ state: a.playState, time: Number(a.currentTime) })));

    await page.evaluate(pageScript.pinAnimations, 0);
    const pinned = await states();
    assert.ok(pinned.length >= 2, 'the fixture has animations to pin');
    for (const animation of pinned) {
      assert.equal(animation.state, 'paused');
      assert.equal(animation.time, 0);
    }

    await page.evaluate(pageScript.pinAnimations, 500);
    for (const animation of await states()) {
      assert.equal(animation.time, 500, 'scrubbed to the frame it was asked for');
    }
  });

  test('leaves the animation clock where it is put, whatever wall time does', async (t) => {
    // Screenshots force compositor frames stamped with the real clock, which is what
    // used to run document.timeline ahead of the video.
    const { page } = await openFixture(t);
    await page.evaluate(pageScript.pinAnimations, 0);
    await page.evaluate(pageScript.pinAnimations, 250);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const times = await page.evaluate(() => document.getAnimations()
      .filter((a) => a.timeline === document.timeline)
      .map((a) => Number(a.currentTime)));
    assert.deepEqual(times, times.map(() => 250));
  });

  test('starts an animation at the frame it first appears in, not before it', async (t) => {
    // The intro is what this is really about: without pinning, the animations burn
    // through the load settle and Chrome backdates their start to the first painted
    // frame, so the recording opens on an intro that has already played.
    const { page } = await openFixture(t);
    await page.evaluate(pageScript.pinAnimations, 1500);
    const times = await page.evaluate(() => document.getAnimations()
      .filter((a) => a.timeline === document.timeline)
      .map((a) => Number(a.currentTime)));
    assert.deepEqual(times, times.map(() => 0), 'an animation first seen at 1.5s starts at 0');
  });

  test('leaves scroll-driven animations alone, since they follow the scroll not the clock', async (t) => {
    const { page } = await openFixture(t);
    await page.evaluate(pageScript.pinAnimations, 0);
    const scrollDriven = await page.evaluate(() => document.getAnimations()
      .filter((a) => a.timeline !== document.timeline)
      .map((a) => a.playState));
    assert.ok(scrollDriven.length > 0, 'the fixture has a scroll-driven animation');
    assert.ok(!scrollDriven.includes('paused'), 'a scroll-driven animation was paused');
  });
});

describe('measureTarget', () => {
  test('takes in decoration hanging outside the element it is cropping to', async (t) => {
    const { page } = await openFixture(t);
    const measured = (await page.evaluate(pageScript.measureTarget, '#link'))!;
    const own = await page.evaluate(() => document.querySelector('#link')!.getBoundingClientRect().toJSON());
    // The underline is an absolutely positioned child sitting below and outside the box.
    assert.ok(measured.bottom > own.bottom, `${measured.bottom} vs ${own.bottom}`);
    assert.ok(measured.left < own.left, `${measured.left} vs ${own.left}`);
  });

  test('is not dragged to the corner by a hidden child', async (t) => {
    const { page } = await openFixture(t);
    const measured = (await page.evaluate(pageScript.measureTarget, '#link'))!;
    // The fixture's link contains a display:none span, whose rect is 0x0 at 0,0.
    assert.ok(measured.top > 100, `top ${measured.top}`);
    assert.ok(measured.left > 0, `left ${measured.left}`);
  });

  test('centres the element first, and reports the scroll that took', async (t) => {
    const { page } = await openFixture(t);
    const measured = (await page.evaluate(pageScript.measureTarget, 'section:nth-child(4) h2'))!;
    assert.ok(measured.scrollY > 0, 'the page was scrolled to reach it');
    assert.ok(measured.top > 100 && measured.bottom < 500, 'and the element is near the middle');
  });

  test('reports nothing rather than guessing when the selector matches nothing', async (t) => {
    const { page } = await openFixture(t);
    assert.equal(await page.evaluate(pageScript.measureTarget, '#not-here'), null);
  });
});

describe('the drawn cursor', () => {
  // What the frame would show: which cursor image is displayed, and where it sits.
  const shown = (page: Page) => page.evaluate(() => {
    const images = [...document.querySelectorAll('#record-cursor img')] as HTMLImageElement[];
    const visible = images.filter((image) => getComputedStyle(image).display !== 'none');
    return visible.map((image) => ({
      name: image.dataset.cursor,
      transform: image.style.transform,
      width: image.getBoundingClientRect().width,
      height: image.getBoundingClientRect().height,
    }));
  });

  async function withCursor(t: TestContext) {
    const opened = await openFixture(t);
    await opened.page.evaluate(pageScript.addCursor, CURSORS);
    return opened;
  }

  test('is whichever one the page asks for under the pointer', async (t) => {
    const { page } = await withCursor(t);
    await page.evaluate(pageScript.moveCursor, await centreOf(page, '#link'));
    assert.deepEqual((await shown(page)).map((c) => c.name), ['pointer'], 'a link shows the hand');

    await page.evaluate(pageScript.moveCursor, await centreOf(page, '#plain'));
    assert.deepEqual((await shown(page)).map((c) => c.name), ['default'], 'plain text does not');
  });

  test('reads the last keyword of a fallback list', async (t) => {
    const { page } = await withCursor(t);
    // 'url(nothing-here.png) 4 4, pointer' -- the keyword is what the browser falls
    // back to, and the only part we have artwork for.
    await page.evaluate(pageScript.moveCursor, await centreOf(page, '#fallback'));
    assert.deepEqual((await shown(page)).map((c) => c.name), ['pointer']);
  });

  test('falls back to the arrow for a keyword there is no cursor for', async (t) => {
    const { page } = await withCursor(t);
    await page.evaluate(pageScript.moveCursor, await centreOf(page, '#unmapped'));
    assert.deepEqual((await shown(page)).map((c) => c.name), ['default']);
  });

  test('is offset by its hotspot, so it points at what the mouse reports', async (t) => {
    const { page } = await withCursor(t);
    const at = await centreOf(page, '#link');
    await page.evaluate(pageScript.moveCursor, at);
    const [cursor] = await shown(page);
    const { hotspotX, hotspotY } = CURSORS.pointer;
    assert.equal(cursor.transform, `translate(${at.x - hotspotX}px, ${at.y - hotspotY}px)`);
  });

  test('survives the page styling images out of existence', async (t) => {
    // The fixture carries Tailwind preflight's `img { max-width: 100% }`, and the holder
    // is 0 wide: without !important throughout, the pointer renders zero pixels across
    // and the recording comes out looking cursorless.
    const { page } = await withCursor(t);
    await page.evaluate(pageScript.moveCursor, await centreOf(page, '#link'));
    const [cursor] = await shown(page);
    assert.equal(cursor.width, CURSORS.pointer.width);
    assert.equal(cursor.height, CURSORS.pointer.height);
  });

  test('never lets the page see it', async (t) => {
    const { page } = await withCursor(t);
    const at = await centreOf(page, '#link');
    // elementFromPoint has to read through the cursor to what is really underneath, or
    // every frame would resolve the cursor of the cursor.
    const under = await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.id, at);
    assert.equal(under, 'link');
  });
});

describe('setFocused', () => {
  test('focuses and blurs without scrolling the page out from under the crop', async (t) => {
    const { page } = await openFixture(t);
    // Measured before the page is moved, the way the recorder measures the page height
    // before its first pan. A scroll issued as the very first thing after the settle
    // wedges the renderer, which is why neither this test nor the recorder does that.
    const maxScroll = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    assert.ok(maxScroll > 400);
    await page.evaluate(pageScript.scrollToProgress, 400 / maxScroll);

    await page.evaluate(pageScript.setFocused, { selector: '#field', focused: true });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'field');
    // preventScroll: the element was centred before the recording started and the crop
    // was measured there.
    assert.equal(await page.evaluate(() => Math.round(window.scrollY)), 400, 'focus scrolled the page');

    await page.evaluate(pageScript.setFocused, { selector: '#field', focused: false });
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'field');
  });
});

describe('scrollToProgress', () => {
  test('1 is the bottom of the page whatever the page turns out to be', async (t) => {
    const { page } = await openFixture(t);
    const maxScroll = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    await page.evaluate(pageScript.scrollToProgress, 1);
    assert.equal(await page.evaluate(() => window.scrollY), maxScroll);

    await page.evaluate(pageScript.scrollToProgress, 0.5);
    assert.equal(await page.evaluate(() => window.scrollY), maxScroll / 2);
  });
});

describe('CDP screenshots', () => {
  test('clip.scale multiplies on top of the device scale rather than replacing it', async (t) => {
    // clip.scale is 1 in the recorder for exactly this reason: anything else applies
    // --scale twice and the frame comes out the wrong size.
    const { page, cdp } = await openFixture(t, { scale: 2, frozen: false });
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 100, height: 50, scale: 1 },
    });
    assert.deepEqual(pngSize(Buffer.from(shot.data, 'base64')), { width: 200, height: 100 });

    const doubled = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 100, height: 50, scale: 2 },
    });
    assert.deepEqual(pngSize(Buffer.from(doubled.data, 'base64')), { width: 400, height: 200 });
  });
});

describe('lib/page.ts', () => {
  test('is all serializable: no function reaches for a variable the page does not have', async (t) => {
    // page.evaluate stringifies these and evals them over there, so a free variable is a
    // ReferenceError at the far end and nowhere else.
    const { page } = await openFixture(t);
    const calls: [Function, unknown][] = [
      [pageScript.measureTarget, '#link'],
      [pageScript.pinAnimations, 0],
      [pageScript.addCursor, CURSORS],
      [pageScript.moveCursor, { x: 10, y: 10 }],
      [pageScript.setFocused, { selector: '#field', focused: true }],
      [pageScript.scrollToProgress, 0],
    ];
    assert.equal(calls.length, Object.keys(pageScript).length, 'a page function is untested');
    for (const [fn, arg] of calls) {
      await page.evaluate(fn as never, arg as never);
    }
  });
});

describe('the system cursors', { skip: process.platform !== 'darwin' && 'macOS only' }, () => {
  test('come from AppKit, rasterized at the recording\'s own pixel ratio', async () => {
    const cursors = systemCursors(3);
    for (const name of ['default', 'pointer', 'text']) {
      assert.ok(cursors[name], `${name} is missing`);
      assert.ok(cursors[name].width > 0 && cursors[name].height > 0);
    }
    // The artwork is drawn at the ratio rather than a small bitmap being blown up.
    const arrow = cursors.default;
    const png = pngSize(Buffer.from(arrow.png.split(',')[1], 'base64'));
    assert.equal(png.width, Math.round(arrow.width) * 3);
    assert.equal(png.height, Math.round(arrow.height) * 3);
  });
});
