/* Everything that runs INSIDE the browser.
 *
 * These are handed to page.evaluate, which stringifies them and evals the text in the
 * page. Nothing outside a function body exists over there, so **a function here may not
 * reference a free variable**: no imports, no constants from lib/constants.ts, no shared
 * helpers. Whatever it needs is either passed in as its argument or written out again in
 * full. Type-only references are fine -- Node strips them before Playwright ever reads
 * the source. test/browser.test.ts runs every export through page.evaluate, which is
 * what catches a free variable sneaking in.
 */

import type { SystemCursor, TargetBox } from './types.ts';

// The start times pinAnimations parks on the page live on window: it runs inside the
// browser, so a module-scoped variable here would not be there.
declare global {
  interface Window {
    animationStartTimes?: WeakMap<Animation, number>;
    recordCursors?: Record<string, SystemCursor>;
  }
}

// The element is centred first so there is room on both sides for the pointer to come
// from, then measured once -- the recording cannot re-measure later, because the action
// changes the layout and ffmpeg will not take frames of differing sizes.
export function measureTarget(selector: string): TargetBox | null {
  const element = document.querySelector(selector);
  if (!element) return null;
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = element.getBoundingClientRect();
  // A hover underline, swash or glow is usually an absolutely positioned child hanging
  // outside the link's own box, and getBoundingClientRect stops at the box -- crop to
  // that and the decoration is sliced off mid-stroke. Take the union of the element and
  // everything inside it instead.
  // ponytail: descendants as they sit at rest. Decoration a script only inserts on
  // hover is still missed; measuring mid-hover needs the clock running, which is the
  // one thing this shot cannot have. Widen ACTION_PADDING_PIXELS if that is your page.
  let left = rect.left;
  let top = rect.top;
  let right = rect.right;
  let bottom = rect.bottom;
  for (const descendant of element.querySelectorAll('*')) {
    const box = descendant.getBoundingClientRect();
    // Skip the collapsed ones: a hidden or empty child would drag the crop to 0,0.
    if (box.width === 0 && box.height === 0) continue;
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.right);
    bottom = Math.max(bottom, box.bottom);
  }
  return {
    left,
    top,
    right,
    bottom,
    // The clip is in page coordinates and the mouse in viewport ones; this is what
    // converts between them.
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

// Screenshots force compositor frames stamped with the real clock, so
// document.timeline outruns virtual time -- mildly at scale 1, by more than 10x at
// scale 2 -- and every CSS animation races ahead of the video. Paused animations
// ignore the timeline, so hold them all and scrub each one to the exact frame time.
// This also fixes the intro: without it the animations burn through the load settle
// and Chrome backdates their start to the first painted frame.
export function pinAnimations(elapsed: number) {
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

// The real pointer is not in a CDP screenshot, so the system's own cursors are put into
// the page as images -- one <img> each, all of them decoded up front. Swapping which one
// is shown then costs nothing, where swapping a src would hand the frame a decode it
// cannot finish in time and drop the cursor out of it.
export async function addCursor(cursors: Record<string, SystemCursor>) {
  window.recordCursors = cursors;
  const holder = document.createElement('div');
  holder.id = 'record-cursor';
  // pointer-events none so the page never sees it, and so elementFromPoint below reads
  // through it to whatever the pointer is really over. No shadow: the system artwork
  // already carries the one macOS draws.
  holder.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none';
  document.body.append(holder);

  await Promise.all(Object.entries(cursors).map(async ([name, cursor]) => {
    const image = new Image();
    image.dataset.cursor = name;
    image.src = cursor.png;
    // Every declaration is !important because this is the page's stylesheet we are
    // landing in, and a page styles its own images. Tailwind's preflight alone
    // (`img { max-width: 100% }`, against a holder that is 0 wide) is enough to render
    // the pointer exactly zero pixels across and leave the recording looking cursorless.
    image.style.cssText = `position:absolute!important;top:0!important;left:0!important;
      width:${cursor.width}px!important;height:${cursor.height}px!important;
      max-width:none!important;max-height:none!important;min-width:0!important;
      margin:0!important;padding:0!important;border:0!important;
      opacity:1!important;visibility:visible!important;filter:none!important;
      clip-path:none!important;mask:none!important;display:none`;
    holder.append(image);
    await image.decode().catch(() => {});
  }));
}

// Which cursor to show is the page's call, not ours: whatever CSS resolves for the
// element under the pointer is what a real pointer would turn into there, the page's
// own :hover rules included. Reading it every frame is what makes the hand appear on
// the link at the same moment the hover does.
export function moveCursor(position: { x: number; y: number }) {
  const holder = document.getElementById('record-cursor');
  const cursors = window.recordCursors;
  if (!holder || !cursors) return;

  const under = document.elementFromPoint(position.x, position.y);
  // ponytail: 'auto' is reported as itself rather than resolved, and it is only a lie
  // over text, where the real pointer would be an I-beam. Everywhere else it is the
  // arrow. Map the keyword if that ever matters more than the link case does.
  const declared = under ? getComputedStyle(under).cursor : 'default';
  // A computed cursor can be a fallback list ('url(a.png) 4 4, pointer'); the keyword
  // the browser falls back to is the last entry.
  const keyword = declared.split(',').pop()!.trim();
  const cursor = cursors[keyword] ?? cursors.default;

  for (const image of holder.children) {
    if (!(image instanceof HTMLImageElement)) continue;
    const showing = image.dataset.cursor === (cursors[keyword] ? keyword : 'default');
    image.style.setProperty('display', showing ? 'block' : 'none', 'important');
    if (showing) {
      // The hotspot is the pixel the mouse events report, so the artwork is offset by
      // it -- otherwise the hand points a finger's width away from what it is clicking.
      image.style.transform = `translate(${position.x - cursor.hotspotX}px, ${position.y - cursor.hotspotY}px)`;
    }
  }
}

// focus() and blur() are both no-ops when the element is already in that state, so the
// frame loop can just say what it wants rather than tracking what it last did.
// preventScroll because the element is already centred and a scroll now would drag it
// out of a crop that was measured before the recording started.
export function setFocused({ selector, focused }: { selector: string; focused: boolean }) {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) return;
  if (focused) {
    element.focus({ preventScroll: true });
  } else {
    element.blur();
  }
}

// Scroll position is set outright rather than animated: the page's own smooth
// scrolling would run on the same untrustworthy clock the animations do, and
// scroll-driven (progress based) animations follow whatever offset we land on.
export function scrollToProgress(progress: number) {
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  window.scrollTo({ top: progress * maxScroll, behavior: 'instant' });
}
