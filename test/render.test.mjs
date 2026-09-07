/**
 * The whole pipeline, end to end, against the fixture slide.
 *
 * This is the test that makes "works on Linux, macOS and Windows" a claim rather
 * than a hope: it starts a real browser, records real frames and runs a real
 * ffmpeg, on whichever of the three is running CI. It skips rather than fails when
 * the machine has no browser or no ffmpeg, because that is a missing dependency and
 * not a broken build — `plumirecord --doctor` is the thing that reports it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { probe, detectLoop, record, snap, reapBrowsers } from '../src/recorder.mjs';
import { findChrome, ffmpegPath } from '../src/platform.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SLIDE = path.join(HERE, 'fixture.html');
const TILE = '#slide';

/* Resolved at import time, not in a before() hook: the runner reads `skip` as a
   value when it collects the tests, so a hook that has not run yet cannot decide
   it — and a function there is merely truthy, which silently skips everything. */
let skip = false;
try { findChrome(); ffmpegPath(); } catch (err) { skip = 'missing dependency — ' + err.message.split('\n')[0]; }
const dir = await mkdtemp(path.join(tmpdir(), 'plumirecord-render-'));

/** Ask ffprobe what actually ended up in the file, rather than trusting our own report. */
async function probeFile(file) {
  const { stdout } = await run(ffmpegPath().replace(/ffmpeg(\.exe)?$/i, (m) => m.replace('ffmpeg', 'ffprobe')), [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_frames,pix_fmt,color_transfer,color_range',
    '-of', 'json', file,
  ]);
  return JSON.parse(stdout).streams[0];
}

test('probe finds the artboard and its animations', { skip }, async () => {
  const { tiles, animations } = await probe(SLIDE);
  const slide = tiles.find(t => t.selector === TILE);
  assert.ok(slide, `no ${TILE} among ${tiles.map(t => t.selector).join(', ')}`);
  assert.equal(slide.width, 360);
  assert.equal(slide.height, 450);
  assert.ok(slide.thumb.startsWith('data:image/jpeg;base64,'), 'every tile comes back with a thumbnail');
  assert.deepEqual(animations.sort(), ['bob', 'sweep']);
});

test('loop detection finds the 2s period the fixture actually has', { skip }, async () => {
  const { loop, still } = await detectLoop(SLIDE, { tile: TILE, window: 12 });
  assert.equal(still, false, 'the fixture moves');
  assert.equal(loop, 2, `detected ${loop}s, but the CSS says 2s`);
});

test('records an mp4 that is the size, length and colour it claims', { skip }, async () => {
  const out = path.join(dir, 'clip.mp4');
  const r = await record(SLIDE, { tile: TILE, duration: 1, fps: 15, out });
  assert.equal(r.width, 360);
  assert.equal(r.height, 450);
  assert.ok((await stat(out)).size > 0);

  const v = await probeFile(out);
  assert.equal(v.width, 360);
  assert.equal(v.height, 450);
  assert.equal(Number(v.nb_frames), 15, 'one second at 15fps is fifteen frames');
  /* The colour tagging is the fiddly part and the part that silently regresses:
     these frames come out of a browser, so they are sRGB, and a clip that says
     otherwise lands visibly off the still beside it. */
  assert.equal(v.color_transfer, 'iec61966-2-1');
  assert.equal(v.color_range, 'pc');
});

test('stepping the clock renders above the compositor ceiling', { skip }, async () => {
  const out = path.join(dir, 'clip2x.mp4');
  const r = await record(SLIDE, { tile: TILE, duration: 0.5, fps: 15, scale: 2, out });
  assert.equal(r.stepped, true, '--scale implies stepping');
  assert.equal(r.width, 720);
  assert.equal(r.height, 900);
  const v = await probeFile(out);
  assert.equal(v.width, 720);
  assert.equal(Number(v.nb_frames), 8, 'half a second at 15fps, rounded up');
});

test('a still comes back re-drawn at the size asked for', { skip }, async () => {
  const out = path.join(dir, 'still.png');
  const r = await snap(SLIDE, { tile: TILE, scale: 3, start: 1, out });
  assert.equal(r.width, 1080);
  assert.equal(r.height, 1350);
  assert.ok((await stat(out)).size > 0);
});

test('a duration nobody gave is refused rather than guessed', { skip }, async () => {
  await assert.rejects(() => record(SLIDE, { tile: TILE }), /duration is required/);
});

test('no browser is left running when the tests are done', { skip }, async () => {
  /* The leak this guards against is the one that took a box down: a browser is
     spawned in its own group precisely so it survives its parent, which means every
     path out of a render has to close it or nothing will. */
  const leaked = await reapBrowsers({ frames: true });
  assert.equal(leaked, 0, `${leaked} browser(s) were left behind by the tests above`);
  await rm(dir, { recursive: true, force: true });
});
