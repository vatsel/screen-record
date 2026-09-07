/* The command line: parsed, defaulted against a frame profile, and checked. Pure --
 * nothing here prints or exits, so the caller decides what a bad invocation looks like. */

import { parseArgs } from 'node:util';
import { devices } from 'playwright';
import { DESKTOP_FRAME, MOBILE_FRAME } from './constants.ts';
import type { Options } from './types.ts';

export const USAGE = [
  'usage: node record.ts --url <url> [--out out.mp4] [--fps 60] [--seconds 6] [--width] [--height] [--scale] [--mobile] [--scroll] [--hold 2] [--hover <selector>] [--focus <selector>]',
  '  --mobile  414x736 at 3x (1242x2208) with a phone user agent and touch, the most common mobile viewport width (desktop default is 1440x900 at 2x)',
  '  --scroll  pan from the top of the page to the bottom, holding still for --hold seconds at each end',
  '            how fast it pans is set by the FLICK_* constants in lib/constants.ts, not by a flag',
  '  --linear  pan at one constant speed instead: no flicks, no pauses, no drift',
  '  --hover   crop to the matching element and walk a pointer onto it, rest, and leave',
  '  --focus   crop to the matching element and give it keyboard focus, hold, release',
  '            how long each phase lasts is set by the ACTION_* constants, not by a flag',
];

// Pixel 5 is only here for its phone user agent and touch flags; the viewport and scale
// in the options are what actually decide the frame.
export function frameDevice(mobile: boolean) {
  return mobile ? devices['Pixel 5'] : {};
}

export type ParseResult =
  | { ok: true; options: Options }
  | { ok: false; errors: string[]; showUsage: boolean };

export function parseOptions(argv: string[]): ParseResult {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        url: { type: 'string' },
        out: { type: 'string', default: 'out.mp4' },
        fps: { type: 'string', default: '60' },
        seconds: { type: 'string' },
        width: { type: 'string' },
        height: { type: 'string' },
        scale: { type: 'string' },
        mobile: { type: 'boolean', default: false },
        scroll: { type: 'boolean', default: false },
        linear: { type: 'boolean', default: false },
        hold: { type: 'string', default: '2' },
        hover: { type: 'string' },
        focus: { type: 'string' },
      },
    }));
  } catch (cause) {
    return { ok: false, errors: [(cause as Error).message], showUsage: true };
  }

  if (!values.url) {
    return { ok: false, errors: [], showUsage: true };
  }

  // One element, one action. Both at once has no meaning, and panning the whole page
  // while cropped to a link even less.
  const actionSelector = values.hover ?? values.focus;
  if (values.hover && values.focus) {
    return {
      ok: false,
      errors: ['--hover and --focus are one shot each; pass one or the other'],
      showUsage: false,
    };
  }
  if (actionSelector && values.scroll) {
    return {
      ok: false,
      errors: ['--scroll pans the whole page and --hover/--focus crop to one element; pass one or the other'],
      showUsage: false,
    };
  }

  // Explicit --width/--height/--scale win over either profile.
  const profile = values.mobile ? MOBILE_FRAME : DESKTOP_FRAME;
  const numbers = {
    width: Number(values.width ?? profile.width),
    height: Number(values.height ?? profile.height),
    scale: Number(values.scale ?? profile.scale),
    fps: Number(values.fps),
    seconds: Number(values.seconds ?? 6),
    hold: Number(values.hold),
  };
  // Number('abc') is NaN, which propagates all the way to a frame count of NaN, a loop
  // that never runs and an empty mp4 with a zero exit code. Refuse it at the door.
  const nonsense = Object.entries(numbers)
    .filter(([name, value]) => !Number.isFinite(value) || (value <= 0 && name !== 'hold'))
    .map(([name]) => `--${name} must be a positive number`);
  if (nonsense.length > 0) {
    return { ok: false, errors: nonsense, showUsage: false };
  }

  return {
    ok: true,
    options: {
      url: values.url,
      out: values.out,
      fps: numbers.fps,
      stillSeconds: numbers.seconds,
      width: numbers.width,
      height: numbers.height,
      scale: numbers.scale,
      mobile: values.mobile,
      scroll: values.scroll,
      linear: values.linear,
      // --scroll spends the travel time panning, with a still --hold at each end on top
      // of that. Nothing is held still when there is no pan.
      holdFrames: values.scroll ? Math.round(numbers.fps * numbers.hold) : 0,
      hover: values.hover,
      focus: values.focus,
      actionSelector,
    },
  };
}
