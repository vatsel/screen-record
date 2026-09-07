/* The whole pipeline: a real page, a real browser, a real ffmpeg, and an mp4 at the end
 * of it. Slower than the rest of the suite, and the only thing here that would notice
 * the pieces having been wired together wrongly. */

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ACTION_SECONDS } from '../lib/constants.ts';
import { countTravelFrames, derivePan } from '../lib/motion.ts';

const run = promisify(execFile);
const RECORD = fileURLToPath(new URL('../record.ts', import.meta.url));
const FIXTURE = pathToFileURL(fileURLToPath(new URL('./fixtures/page.html', import.meta.url))).href;
const FRAME = ['--fps', '10', '--width', '320', '--height', '240', '--scale', '1'];

function have(tool: string) {
  try {
    execFileSync(tool, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const missing = !have('ffmpeg') || !have('ffprobe');
const workspace = missing ? '' : mkdtempSync(join(tmpdir(), 'screen-record-'));
after(() => workspace && rmSync(workspace, { recursive: true, force: true }));

async function record(name: string, args: string[]) {
  const out = join(workspace, `${name}.mp4`);
  const { stderr } = await run('node', [RECORD, '--url', FIXTURE, '--out', out, ...args], {
    maxBuffer: 8 * 1024 * 1024,
  });
  // The fixture animates on every frame, so a still frame here is the recorder having
  // stopped, not the page.
  assert.doesNotMatch(stderr, /drew nothing new/, stderr);
  return { out, stderr };
}

async function probe(file: string) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_frames',
    '-show_entries', 'stream=width,height,nb_read_frames',
    '-of', 'json',
    file,
  ]);
  const [stream] = JSON.parse(stdout).streams;
  return { width: stream.width, height: stream.height, frames: Number(stream.nb_read_frames) };
}

// How many frames carry real picture rather than being a repeat of the one before.
// A frame identical to its predecessor encodes to a couple of dozen bytes, so the packet
// sizes separate the two without decoding anything. This is what catches a recording that
// is technically the right length but is actually two images repeated -- the shape the
// still-frame latch used to produce.
async function substantialFrames(file: string) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=size', '-of', 'csv=p=0', file,
  ]);
  const sizes = stdout.trim().split('\n').map(Number);
  return { substantial: sizes.filter((size) => size > 60).length, frames: sizes.length };
}

// One frame out of the file, as bytes.
function frameAt(file: string, index: number) {
  const png = join(workspace, `${index}-${Date.now()}.png`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `select='eq(n\\,${index})'`, '-fps_mode', 'passthrough', '-frames:v', '1', png]);
  return execFileSync('shasum', [png]).toString().split(' ')[0];
}

describe('recording a page', { skip: missing && 'ffmpeg is not on PATH', timeout: 180000 }, () => {
  test('sitting still gives --seconds worth of frames at the frame size asked for', async () => {
    const { out } = await record('still', ['--seconds', '1', ...FRAME]);
    assert.deepEqual(await probe(out), { width: 320, height: 240, frames: 10 });
  });

  test('--scale multiplies the frame rather than the viewport', async () => {
    const { out } = await record('scaled', ['--seconds', '0.5', '--fps', '10', '--width', '320', '--height', '240', '--scale', '2']);
    const probed = await probe(out);
    assert.equal(probed.width, 640);
    assert.equal(probed.height, 480);
  });

  test('panning covers the page, and takes as long as the motion model says', async () => {
    const { out, stderr } = await record('pan', ['--scroll', '--hold', '0.2', ...FRAME]);
    const announced = stderr.match(/scrolling (\d+)px over/);
    assert.ok(announced, `no pan summary in: ${stderr}`);

    // The frame count is the motion model's answer for the page the recorder measured,
    // plus a hold at each end.
    const pan = derivePan(240);
    const travel = countTravelFrames({ pan, fps: 10, scrollableHeight: Number(announced[1]) });
    const holdFrames = Math.round(10 * 0.2);
    assert.deepEqual(await probe(out), { width: 320, height: 240, frames: travel + 2 * holdFrames });
  });

  test('and the page has actually moved by the end of it', async () => {
    const { out } = await record('moved', ['--scroll', '--hold', '0', ...FRAME]);
    const { frames } = await probe(out);
    // A pan that silently froze would still produce a perfectly valid mp4.
    assert.notEqual(frameAt(out, 0), frameAt(out, frames - 1));
  });

  test('an action crops to its element and lasts the sum of its phases', {
    skip: process.platform !== 'darwin' && '--hover needs macOS for the system cursors',
  }, async () => {
    const { out, stderr } = await record('hover', ['--hover', '#link', ...FRAME]);
    const announced = stderr.match(/cropped to \d+x\d+ css px \((\d+)x(\d+) out\)/);
    assert.ok(announced, `no crop summary in: ${stderr}`);

    const probed = await probe(out);
    // h264 needs even dimensions, so the file is the announced size rounded down.
    assert.equal(probed.width, Math.floor(Number(announced[1]) / 2) * 2);
    assert.equal(probed.height, Math.floor(Number(announced[2]) / 2) * 2);
    assert.ok(probed.width < 320 && probed.height < 240, 'cropped smaller than the viewport');
    assert.equal(probed.frames, Math.round(ACTION_SECONDS * 10));

    // The pointer is deliberately parked for the lead-in, the dwell and the lead-out, so
    // a healthy hover shot is around half repeated frames and that is fine. What is not
    // fine is a recording made of two images: a stalled capture used to produce exactly
    // the right frame count with nothing moving in it, behind a zero exit code.
    const drawn = await substantialFrames(out);
    // Measured at 17 of 23 on this fixture; the floor leaves room for encoder drift.
    assert.ok(drawn.substantial >= 10, `only ${drawn.substantial} of ${drawn.frames} frames carry picture`);
  });

  test('--focus needs no cursor and so needs no swift', async () => {
    const { out } = await record('focus', ['--focus', '#field', ...FRAME]);
    const probed = await probe(out);
    assert.equal(probed.frames, Math.round(ACTION_SECONDS * 10));
  });

  test('a selector that matches nothing is refused rather than recorded blank', async () => {
    await assert.rejects(
      () => record('nothing', ['--focus', '#not-here', ...FRAME]),
      (error: Error & { stderr: string }) => {
        assert.match(error.stderr, /nothing on the page matches #not-here/);
        return true;
      },
    );
  });
});
