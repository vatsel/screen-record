/* The command line: what each flag resolves to, and which invocations are refused. */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DESKTOP_FRAME, MOBILE_FRAME } from '../lib/constants.ts';
import { USAGE, frameDevice, parseOptions } from '../lib/options.ts';
import type { Options } from '../lib/types.ts';

function ok(argv: string[]): Options {
  const parsed = parseOptions(argv);
  assert.ok(parsed.ok, `expected ${argv.join(' ')} to parse`);
  return parsed.options;
}

function rejected(argv: string[]) {
  const parsed = parseOptions(argv);
  assert.ok(!parsed.ok, `expected ${argv.join(' ')} to be refused`);
  return parsed;
}

describe('defaults', () => {
  test('a bare --url is a desktop frame, six seconds, 60fps, out.mp4', () => {
    const options = ok(['--url', 'https://example.com']);
    assert.equal(options.url, 'https://example.com');
    assert.equal(options.out, 'out.mp4');
    assert.equal(options.fps, 60);
    assert.equal(options.stillSeconds, 6);
    assert.equal(options.width, DESKTOP_FRAME.width);
    assert.equal(options.height, DESKTOP_FRAME.height);
    assert.equal(options.scale, DESKTOP_FRAME.scale);
    assert.equal(options.scroll, false);
    assert.equal(options.actionSelector, undefined);
  });

  test('--mobile is a 9:16 phone frame at 3x', () => {
    const options = ok(['--url', 'https://example.com', '--mobile']);
    assert.equal(options.width, MOBILE_FRAME.width);
    assert.equal(options.height, MOBILE_FRAME.height);
    assert.equal(options.scale, MOBILE_FRAME.scale);
    assert.equal(options.width * options.scale, 1242);
    assert.equal(options.height * options.scale, 2208);
  });

  test('and brings a phone user agent and touch with it', () => {
    const phone = frameDevice(true) as { userAgent: string; hasTouch: boolean; isMobile: boolean };
    assert.match(phone.userAgent, /Android|Mobile/);
    assert.equal(phone.hasTouch, true);
    assert.deepEqual(frameDevice(false), {});
  });

  test('an explicit size beats either profile', () => {
    const options = ok(['--url', 'u', '--mobile', '--width', '800', '--height', '600', '--scale', '1']);
    assert.equal(options.width, 800);
    assert.equal(options.height, 600);
    assert.equal(options.scale, 1);
    // Still a phone as far as the user agent goes; only the frame was overridden.
    assert.equal(options.mobile, true);
  });
});

describe('hold', () => {
  test('is only spent when there is a pan to hold either end of', () => {
    assert.equal(ok(['--url', 'u']).holdFrames, 0);
    assert.equal(ok(['--url', 'u', '--hold', '3']).holdFrames, 0);
    assert.equal(ok(['--url', 'u', '--scroll']).holdFrames, 120);
    assert.equal(ok(['--url', 'u', '--scroll', '--hold', '0.5', '--fps', '30']).holdFrames, 15);
    assert.equal(ok(['--url', 'u', '--scroll', '--hold', '0']).holdFrames, 0);
  });
});

describe('actions', () => {
  test('either flag becomes the one selector the shot is built around', () => {
    assert.equal(ok(['--url', 'u', '--hover', 'nav a']).actionSelector, 'nav a');
    assert.equal(ok(['--url', 'u', '--focus', '#field']).actionSelector, '#field');
  });

  test('one shot each, so not both at once', () => {
    const parsed = rejected(['--url', 'u', '--hover', 'a', '--focus', 'b']);
    assert.match(parsed.errors[0], /one shot each/);
    assert.equal(parsed.showUsage, false);
  });

  test('and not while panning the whole page', () => {
    for (const flag of ['--hover', '--focus']) {
      const parsed = rejected(['--url', 'u', '--scroll', flag, 'a']);
      assert.match(parsed.errors[0], /pass one or the other/);
    }
  });
});

describe('refusals', () => {
  test('no --url prints the usage rather than an error', () => {
    const parsed = rejected([]);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.showUsage, true);
    assert.match(USAGE[0], /^usage: node record\.ts --url/);
  });

  test('an unknown flag is reported, not ignored', () => {
    const parsed = rejected(['--url', 'u', '--nope']);
    assert.equal(parsed.showUsage, true);
    assert.match(parsed.errors[0], /nope/);
  });

  test('a number that is not one is refused at the door', () => {
    // Number('abc') is NaN, which reaches the frame loop as a count of NaN and leaves an
    // empty mp4 behind a zero exit code.
    for (const flag of ['--fps', '--seconds', '--width', '--height', '--scale']) {
      const parsed = rejected(['--url', 'u', flag, 'abc']);
      assert.match(parsed.errors[0], /positive number/);
      assert.match(rejected(['--url', 'u', flag, '0']).errors[0], /positive number/);
    }
    assert.match(rejected(['--url', 'u', '--hold', 'abc']).errors[0], /positive number/);
  });
});
