# screen-record

One script, `record.ts`, that records a web page to an mp4. Everything else is
`package.json` and lockfile. Keep it that way — no `src/`, no config file, no
build step. Node runs the TypeScript directly via type stripping
(Node 22.18+), so `record.ts` is executed as-is.

## Running it

```
node record.ts --url https://example.com
node record.ts --url https://example.com --mobile --scroll
node record.ts --url https://example.com --hover 'nav a' --scale 4
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
- **A late frame and a still page look identical, and only a nudge tells them apart.**
  When a shot goes unanswered, running the clock again with plain `advance` frees it
  every time it was merely late (measured 100%), and never frees it when the page drew
  nothing. That is the test -- never a longer timeout, which just mistakes a loaded
  machine for a still page and silently freezes the recording. `pauseIfNetworkFetchesPending`
  is no good for the nudge: it refuses to move the clock while a request is outstanding,
  which is exactly when wedges happen.

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
the ALL-CAPS constants at the top of the file, in *viewports* rather than pixels
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

This file previously drew two cursors as inline SVG paths. They looked uncanny, and
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

- The header comment block is the user documentation. Change a flag or a
  constant, change the header in the same edit.
- New tuning knobs go in the ALL-CAPS block, not in `parseArgs`. Flags are for
  what changes per-recording (size, duration, output); constants are for what
  defines the house style of the motion.
- comments mark deliberate shortcuts and name their ceiling. Don't
  "fix" one without reading it — it's a decision, not an oversight.

## Dependencies

- Playwright
- ffmpeg (subprocess)
- swift + AppKit (subprocess, `--hover` only) for the system cursors


## Verifying a change (for agents)

There are no tests. Record a real page and watch it:

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
reporting frozen output; N should be 0 on any page that moves. Don't use
`example.com` as the check: nothing on it moves or scrolls, so it exercises only the
still path and takes ~40s to say so.
