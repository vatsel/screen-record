# screen-record

One script, `record.js`, that records a web page to an mp4. Everything else is
`package.json` and lockfile. Keep it that way — no `src/`, no config file, no
build step.

## Running it

```
node record.js --url https://example.com
node record.js --url https://example.com --mobile --scroll
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
- **Advance, then capture.** `captureScreenshot` waits for a compositor frame;
  a visually static page under a paused clock never produces one.

Screenshots go through raw CDP, not `page.screenshot()` — the latter waits for
visual stability and hangs once animations are pinned. PNGs are piped straight
into an `ffmpeg` stdin pipe; nothing touches disk except the output.

Scroll motion (`--scroll`) is a constant drift with eased "flicks" on top, so it
reads like a person reading rather than a camera on a rail. Its tuning lives in
the ALL-CAPS constants at the top of the file, in *viewports* rather than pixels
so phone and desktop frames move at the same apparent rate. Those constants are
deliberately not flags.

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


## Verifying a change (for agents)

There are no tests. Record a real page and watch it:

```
node record.js --url https://example.com --scroll --out /tmp/check.mp4
```

Check that the intro animation actually plays (not skipped during load), that
the pan ends at the bottom of the page, and that the frame-rate line on stderr
doesn't stall. A wedged recording sits at 0% CPU with no error — that's what
`STALLED_BUDGET_MILLISECONDS` is guarding against.
