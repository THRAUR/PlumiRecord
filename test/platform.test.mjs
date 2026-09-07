/**
 * The OS layer, checked on whatever OS is running the tests.
 *
 * These deliberately assert on shape and sanity rather than exact values: the whole
 * point of this module is that the right answer is different on each platform, so a
 * test that pinned a number could only pass on the machine it was written on. What
 * they do catch is the failure that actually happens — a platform branch returning
 * undefined, NaN, or zero, which downstream turns into "not enough memory" on a
 * machine with plenty or a render split across zero workers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  availableMb, totalMb, swapMb, sampleCpu, cpuUsage,
  dataDir, chromeFlags, listBrowsers, killTree, spawnOpts, IS_WIN,
} from '../src/platform.mjs';
import { autoWorkers, coreBudget } from '../src/recorder.mjs';

test('reports a believable amount of free memory', () => {
  const free = availableMb();
  assert.ok(Number.isFinite(free), `availableMb() gave ${free}`);
  assert.ok(free > 0, 'no machine that can run this has zero memory available');
  assert.ok(free <= totalMb(), `free (${free}MB) cannot exceed total (${totalMb()}MB)`);
});

test('reports swap, or admits it cannot', () => {
  const swap = swapMb();
  if (swap === null) return; /* Windows, legitimately */
  assert.ok(Number.isFinite(swap.used) && Number.isFinite(swap.total));
  assert.ok(swap.used <= swap.total + 1);
});

test('CPU load needs two samples and then stays a fraction', () => {
  sampleCpu();
  sampleCpu();
  const load = cpuUsage();
  assert.ok(load >= 0 && load <= 1, `cpu load out of range: ${load}`);
});

test('the worker count leaves the machine a core', () => {
  assert.ok(coreBudget() >= 1);
  assert.ok(autoWorkers() >= 1, 'a render always gets at least one browser');
  assert.ok(autoWorkers() <= coreBudget(), 'a render never gets every core');
});

test('the data directory is absolute and named for this app', () => {
  const dir = dataDir();
  assert.ok(path.isAbsolute(dir), `${dir} is not absolute`);
  assert.match(dir, /plumirecord/i);
});

test('a full browser is told to be headless and a headless shell is not', () => {
  assert.ok(chromeFlags({ isShell: false }).includes('--headless=new'));
  assert.ok(!chromeFlags({ isShell: true }).includes('--headless=new'));
  /* Always, on every platform: the clip is tagged sRGB downstream, so the frames
     have to actually be sRGB. */
  for (const shell of [true, false]) {
    assert.ok(chromeFlags({ isShell: shell }).includes('--force-color-profile=srgb'));
  }
});

test('a child is spawned in a group only where killing a group is a thing', () => {
  assert.equal(spawnOpts().detached, !IS_WIN);
});

test('listing our browsers works and finds none of somebody else', async () => {
  /* The mark is a path this test's process was never given, so a correct
     implementation finds nothing — and an implementation that matched on the name
     "chrome" would find the browser the developer has open. */
  const found = await listBrowsers(path.join(dataDir(), 'no-such-profile-' + process.pid));
  assert.deepEqual(found, []);
});

test('killing a process that is already gone is not an error', () => {
  assert.equal(killTree(0), false);
});
