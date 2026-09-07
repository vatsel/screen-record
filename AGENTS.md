# screen-record

Records a web page to an mp4. No build step: Node runs the TypeScript directly
via type stripping (Node 22.18+), so every file is executed as-is. `tsconfig.json`
is `noEmit` and exists only so the editor and `pnpm run typecheck` see the same
thing Node does.

```
record.ts          the entry: the flags, the ffmpeg pipe, the browser, the frame loop
lib/constants.ts   the ALL-CAPS tuning block, FLICK_* and ACTION_*
lib/types.ts       the shapes passed between the modules
lib/options.ts     the command line, resolved and checked
lib/motion.ts      when things move: the pan model and the action phases
lib/layout.ts      where they are: the crop, and the pointer's path across it
lib/capture.ts     one frame, and telling a late one from a page that has stopped
lib/cursors.ts     the swift snippet that reads macOS's cursors out of AppKit
lib/page.ts        code that runs INSIDE the browser
test/              node --test; test/fixtures/page.html is a page that moves
tsconfig.json      typechecking only; no emit, no build
```

Everything under `lib/` except `page.ts` and `cursors.ts` is pure and has a test
file of its own. Keep it that way: logic that can only be reached by launching a
browser is logic nothing checks.

## Running it

```
node record.ts --url https://example.com
node record.ts --url https://example.com --mobile --scroll
node record.ts --url https://example.com --hover 'nav a' --scale 4
```

```
pnpm test           everything, about 25s
pnpm run test:unit  the pure suites only, under a second
pnpm run typecheck  tsc --noEmit, no build output
```

Needs `ffmpeg` on PATH and playwright's chromium (`pnpm exec playwright install chromium`).
Package manager is pnpm.

## How it works

The browser runs on a **virtual clock** (CDP `Emulation.setVirtualTimePolicy`).
Time only moves when the script spends a budget, so a 6-second recording is
exactly 6 seconds of page time no matter how slow the screenshots are. Two
consequences that dictate most of the code:

- **CSS animations are pinned.** Screenshots force compositor frames stamped
  with the *real* clock, so `document.timeline` outruns virtual time. Every
  document-timeline animation is paused and scrubbed by hand to the frame's
  timestamp (`pinAnimations`).
- **Ask for the frame, then run the clock.** `captureScreenshot` is answered by the
  next frame the compositor draws, so the request has to be in flight *before* the
  budget is spent -- asking afterwards races the frame and loses at random, and loses
  outright on a busy machine. This is what `capture()` does, which is why it owns the
  advance rather than the frame loop.
- **Screenshot requests are not independent, and giving up on one does not cancel it.**
  CDP has no cancel for `captureScreenshot`; an abandoned request stays live, and Chromium
  answers them in order, so every later request queues behind a stuck one. Measured on a
  real site: 25 abandoned shots all answered in the same instant, in FIFO order, ages
  spaced one frame apart. That is why `captureFrame` **carries** an unanswered shot in
  `CaptureState.pending` and waits on it again next frame instead of asking twice. Asking
  once per frame is what turned a compositor that was merely slow into a recording frozen
  to the end. It also means a static page costs one request for the whole recording rather
  than one per frame.
- **An unanswered shot means a loaded machine, not a still page.** `Page.captureScreenshot`
  resolves whether or not the page drew anything: measured on a static `data:` page with a
  paused clock, three consecutive shots all came back in ~33ms, and across 138 frames of a
  real site clipped at scale 2 the answer time was p50 33ms, p99 65ms, max 77ms, with none
  over 500ms. So a shot that has not landed is late, and every frame waits the same
  `STILL_FRAME_MILLISECONDS` for it before nudging -- **never a shorter wait for a frame
  that follows a still one.** That shortcut used to exist and it was a latch: it halved the
  patience of exactly the frames most likely to be slow, so a single slow frame froze the
  rest of the recording into a repeat of its last image behind a zero exit code. The
  repeat-last-frame fallback is still there, but reaching it is now the rare case it was
  always meant to be. `pauseIfNetworkFetchesPending` is no good for the nudge: it refuses
  to move the clock while a request is outstanding, which is exactly when wedges happen.

Screenshots go through raw CDP, not `page.screenshot()` — the latter waits for
visual stability and hangs once animations are pinned. PNGs are piped straight
into an `ffmpeg` stdin pipe; nothing touches disk except the output.

`--hover` and `--focus` crop the frame to one element and record it reacting to the
user. A CDP screenshot contains no cursor, so one is put into the page as an `<img>` --
**macOS's own cursor artwork**, read out of AppKit by a swift snippet on stdin
(`systemCursors`), which is why `--hover` is macOS only. Which cursor shows is read from
the page every frame (`getComputedStyle(elementFromPoint(...)).cursor`), so the arrow
becomes the hand exactly when the page's own CSS says it would. The actual `:hover`
comes from real mouse moves dispatched alongside it. The images are styled `!important`
throughout: they land in the page's own stylesheet, and Tailwind's preflight
(`img { max-width: 100% }`) alone is enough to render the pointer zero pixels wide. Two things about the crop that are easy to get backwards: CDP's
`clip.scale` multiplies on top of the device scale factor rather than replacing it, so
it stays at 1, and `clip` is in page coordinates while the mouse is in viewport ones.
The element is measured once, before any frame, because the action changes its layout
and ffmpeg will not take frames of differing sizes. That measurement is the union of the
element and its descendants, not its own box: hover decoration is usually an absolutely
positioned child hanging outside the box, and cropping to the box alone slices it off
mid-stroke.

Scroll motion (`--scroll`) is a constant drift with eased "flicks" on top, so it
reads like a person reading rather than a camera on a rail. Its tuning lives in
the ALL-CAPS constants in `lib/constants.ts`, in *viewports* rather than pixels
so phone and desktop frames move at the same apparent rate. Action timings are the
`ACTION_*` block, shared by both `--hover` and `--focus`. Those constants are
deliberately not flags.

## Don't rebuild what the platform already has

**Never hand-roll a replica of something the OS, the browser, or an installed
dependency already provides.** A traced copy of a system asset or a reimplementation of
a native behaviour is never mistaken for the real thing: it is wrong in the details from
day one, and it stays wrong as the real one moves. The tell is code that *describes*
something the platform owns — SVG paths for a system cursor, a hand-written easing table
where CSS has one, a date formatter, a colour-space conversion.

The recorder previously drew two cursors as inline SVG paths. They looked uncanny, and
worse, the shape was chosen once for the whole recording — so the pointer never changed
on hover, which is exactly what makes a video read as fake. The fix was not a better
path: it was asking AppKit for the real cursor and asking the page which one it wanted.

When something looks like it needs recreating:

1. Ask the platform for it (`NSCursor`, `getComputedStyle`, `Intl`, CDP).
2. If the API exists but is awkward to reach (a different language, a subprocess, a
   plist), reach it anyway — a 20-line swift snippet beats a traced asset.
3. Only if it genuinely does not exist, build it — and say in a comment what you looked
   for and why it wasn't there.

The same rule applies to behaviour: let the source of truth decide. The cursor shape is
read from the page every frame rather than guessed once, because CSS already knows the
answer and will keep knowing it after the page changes.

## Editing rules

- The header comment block in `record.ts` is the user documentation. Change a
  flag or a constant, change the header in the same edit.
- New tuning knobs go in `lib/constants.ts`, not in `parseOptions`. Flags are for
  what changes per-recording (size, duration, output); constants are for what
  defines the house style of the motion.
- Everything in `lib/page.ts` is stringified by `page.evaluate` and evaluated in
  the browser, where nothing outside the function body exists. **No free
  variables** — no imports, no constants, no shared helpers; whatever it needs is
  passed in as its argument. A type-only reference is fine, since stripping
  erases it. `test/browser.test.ts` runs every one of them through
  `page.evaluate`, which is what catches a slip.
- `ponytail:` comments mark deliberate shortcuts and name their ceiling. Don't
  "fix" one without reading it — it's a decision, not an oversight.
- A change to the pan model, the crop, the option handling or the still-frame
  logic changes an assertion somewhere in `test/`. If it doesn't, the assertion
  was missing.

## Dependencies

- Playwright
- ffmpeg (subprocess)
- swift + AppKit (subprocess, `--hover` only) for the system cursors


## Verifying a change (for agents)

`pnpm test` first. It covers the pan maths, the crop geometry, the option
handling and the still-frame state machine on their own; the chromium
assumptions this file spends its length on (virtual time, pinned animations,
`clip.scale`, the cursor the page asks for) against a real browser; and the
whole pipeline end to end against `test/fixtures/page.html`, which is a local
file, so the suite runs offline.

The suite does not watch the video. Record a real page and look at it:

```
node record.ts --url <a page that actually animates> --scroll --out /tmp/check.mp4
```

Check that the intro animation actually plays (not skipped during load), that
the pan ends at the bottom of the page, and that the frame-rate line on stderr
doesn't stall. Then **look at the frames**, not just the exit code — several failures
here produce a perfectly valid mp4 of the wrong thing:

```
ffmpeg -i /tmp/check.mp4 -vf "select='eq(n\,75)'" -fps_mode passthrough /tmp/f_%d.png
```

A recording that ends with "the page drew nothing new for the last N frames" is
reporting frozen output; N should be 0 on any page that moves. That line only counts the
*final* streak, so it understates the damage -- count the frames carrying real picture
instead, which is what `substantialFrames` does in `test/record.e2e.test.ts`:

```
ffprobe -v error -select_streams v:0 -show_entries packet=size -of csv=p=0 /tmp/check.mp4 \
  | awk '{n++; if($1>60) s++} END {printf "substantial=%d/%d\n", s+0, n}'
```

An action shot parks the pointer for its lead-in, dwell and lead-out, so roughly half
repeated frames is healthy; a handful out of hundreds means the capture stalled. Don't use
`example.com` as the check: nothing on it moves or scrolls, so it says very little. It is
worth one run as a floor, though -- `--hover 'a' --scale 4 --seconds 3` on it records in
about 7s with no still frames at all. It used to take ~73s and report 95 frozen frames,
which is the clearest single measure of what carrying the shot bought.

One thing the tests found that the recorder relies on without saying so: a scroll
issued as the very first evaluate after the load settle wedges the renderer. The
recorder measures the page height first, so it never does that -- keep any new work
in that order.
