#!/usr/bin/env node
/**
 * Record an animated HTML page to a social-ready mp4.
 *
 * Claude Design exports stills fine but its video export is unreliable, so this
 * drives headless Chrome over CDP directly and encodes the frames with ffmpeg.
 *
 *   plumirecord slide.html --tile '#tutTile' --duration 14
 *
 * Run with --help for the full option list. `plumirecord-server` wraps the same
 * exported functions in a drop-a-file web UI.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, mkdir, readdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { cpus, setPriority } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  findChrome, chromeFlags, ffmpegPath, CAN_PIN_CPUS, dataDir, hasZscale, rmTree,
  availableMb, listBrowsers as psBrowsers, killTree, spawnOpts,
} from './platform.mjs';

export { availableMb };

/* CDP is a WebSocket protocol and this deliberately has no dependencies, so it uses
   the one Node started shipping in v22. Saying so here beats a ReferenceError from
   somewhere three functions deep. */
if (typeof WebSocket === 'undefined') {
  throw new Error(`PlumiRecord needs Node 22 or newer for its built-in WebSocket (this is ${process.version}).`);
}

const HELP = `
Record an animated HTML page to mp4.

  plumirecord <file.html|url> [options]

Options
  --tile <selector>   Record only this element, sized to its own box.
  --duration <sec>    Length of the clip. Omit it to auto-detect the loop.
  --start <sec>       Drop this many seconds from the mount (default 0). Skips a
                      one-shot intro; auto-detection fills it in when it finds one.
  --fps <n>           Frame rate (default 30).
  --scale <n>         Render the tile at n times its size — 2 turns a 1080x1350
                      slide into 2160x2700, re-rendered rather than upscaled.
  --stepped           Step the page's clock instead of recording it in real time:
                      every frame exact, no ceiling on size or rate, but ~100ms a
                      frame at 1080 and ~200ms at 2160. Implied by --scale or by
                      --fps above 60, since real time cannot deliver either.
  --realtime          Force real-time capture even when stepping is implied.
  --workers <n>       Browsers to split a stepped render across, and the ceiling on
                      ffmpeg's threads afterwards. Defaults to what the box can
                      hold: one per free 900MB, never more than one per core less
                      one, capped at 4. A core is always left for the machine.
  --size <WxH>        Override the capture size (default: the tile's own box).
  --out <path>        Output file (default: <input basename>.mp4).
  --png               Save one frame as a PNG instead of a video: the frame the
                      clip would open on. Takes --scale and --start, ignores fps.
  --probe             List the page's tiles with their sizes, then exit.
  --detect            Report the detected loop length and start, then exit.
  --keep-frames       Leave the extracted PNG frames in the temp dir.
  --no-audio          Skip the silent audio track. Some Instagram upload paths
                      reject a video with no audio stream, so it is on by default.
  --offline           Block external DNS. Self-contained bundles only: a raw
                      .dc.html pulls React from unpkg and will not hydrate.
  --doctor            Check this machine has what the tool needs, then exit.
`.trim();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isUrl = s => /^https?:\/\//i.test(s);

/* Frames and browser profiles deliberately do not go in /tmp: it is tmpfs here, so
   a long render fills RAM with files that killing processes cannot free, and the
   machine dies with nothing left to kill. Disk is a thousand times larger and the
   space comes back. */
const WORK = process.env.PLUMIRECORD_TMP || path.join(dataDir(), 'work');
async function workDir(prefix) {
  await mkdir(WORK, { recursive: true });
  return mkdtemp(path.join(WORK, prefix));
}

/* What one render may spend, in cores. The machine always keeps one for itself:
   this box is reached over the network and nothing else, so the failure that
   actually matters here is not a slow render, it is a box that stops answering.
   Capture and encoding both spend from this same budget, which is why the two
   phases now sit at the same height on the meter instead of the second one
   pinning every core. */
export const coreBudget = () => Math.max(1, cpus().length - 1);

/* One browser rendering a 2160x2700 tile measured 636MB and roughly a core of work,
   so the split is bounded by whichever of memory or cores runs out first. A flat
   four of them on this 6-core box left nothing for the machine itself. */
export function autoWorkers(cap = 4) {
  return Math.max(1, Math.min(cap, coreBudget(), Math.floor(availableMb() / 900)));
}

/**
 * Every browser this tool has running, whichever run started it.
 *
 * Chrome is spawned in its own process group so one signal can take down the whole
 * tree — which also means it outlives whoever spawned it. A recorder restarted or
 * killed mid-render leaves browsers resident at ~600MB each with nothing that knows
 * to clean them up, and they pile up across restarts until the machine has no memory
 * left. So they are matched on the profile directory they were handed, a path no
 * other program will ever be given, and never on being called "chrome" — tidying up
 * must not be able to close the tabs somebody was working in.
 *
 * @see platform.mjs for how each OS is asked the question.
 */
export const PROFILE_MARK = () => `--user-data-dir=${path.join(WORK, 'dcrec-')}`;
export const listBrowsers = () => psBrowsers(PROFILE_MARK());

/** @see listBrowsers — kills each browser tree, and clears what it left behind. */
export async function reapBrowsers({ frames = false } = {}) {
  let killed = 0;
  for (const b of await listBrowsers()) {
    if (b.leader && killTree(b.pid)) killed++;
  }
  /* A profile only outlives its browser as garbage, so those always go. A frame
     directory belongs to a job still running in some node process, so it is only
     swept when the caller knows there is no such job. */
  const junk = frames ? /^(dcrec|dcframes|dcloop)-/ : /^dcrec-/;
  for (const name of await readdir(WORK).catch(() => [])) {
    if (junk.test(name)) await rmTree(path.join(WORK, name));
  }
  return killed;
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp4': 'video/mp4',
};

function serveDir(root) {
  const server = createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.resolve(root, '.' + rel);
    /* The separator matters: without it a sibling directory whose name merely starts
       with the same characters passes the check. */
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function connectCdp(port) {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find(t => t.type === 'page');
    } catch { /* chrome still starting */ }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('could not reach the CDP endpoint');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    } else if (m.method) listeners.forEach(f => f(m));
  };
  /* A reply is the only thing that ever settles a command, so a browser that dies
     mid-command would otherwise leave its promise pending for the life of the
     process - and the caller is a link in a serial queue, so that one promise
     wedges every job behind it. Killing the browser is a supported action here
     ("Close the browsers" does it), not an edge case, so treat a closed socket as
     the answer: fail what is in flight and refuse anything sent afterwards. */
  let dead = null;
  const die = why => {
    if (dead) return;
    dead = new Error(why);
    for (const { rej } of pending.values()) rej(dead);
    pending.clear();
  };
  ws.onclose = () => die('the browser closed while a command was in flight');
  ws.onerror = () => die('the connection to the browser failed');

  const send = (method, params = {}) => new Promise((res, rej) => {
    if (dead) return rej(dead);
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = expr => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    .then(r => {
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    });
  return {
    send, evaluate, on: f => listeners.add(f), off: f => listeners.delete(f), close: () => ws.close(),
    get dead() { return dead; },
  };
}

const run = (cmd, args, capture = false, nice = 0) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
  /* Core caps bound how much a job takes; this bounds what that costs everything
     else, by making sure anything still running outranks it for what is left. */
  if (nice) try { setPriority(p.pid, nice); } catch { /* not permitted in every sandbox */ }
  const out = [];
  let err = '';
  if (capture) p.stdout.on('data', d => out.push(d));
  p.stderr.on('data', d => { err += d; });
  p.on('close', code => code === 0 ? res(Buffer.concat(out)) : rej(new Error(`${cmd} exited ${code}\n${err.slice(-2000)}`)));
});

/* The page fixes both capture modes need: the host's box-sizing reset, and the
   tile pinned over the viewport origin. */
const pageSetup = tile => `
    const TILE = ${JSON.stringify(tile || null)};
    const ORIGIN = Date.now();
    const css = document.createElement('style');
    /* the design host wraps every page in this reset, so a raw .dc.html lays out
       ~128px wider than its own PNG export without it */
    css.textContent = '*,*::before,*::after{box-sizing:border-box}'
      + 'html,body{margin:0!important;padding:0!important}'
      /* pin the tile over the viewport origin. Translating the page instead
         forces Chrome to re-raster the whole multi-artboard layer and the
         capture drops from ~58fps to ~7; position:fixed costs nothing. */
      + (TILE ? TILE + '{position:fixed!important;top:0!important;left:0!important;right:auto!important;'
        + 'bottom:auto!important;margin:0!important;z-index:2147483647!important;'
        + 'border:0!important;box-shadow:none!important}' : '');
    const addCss = () => (document.head || document.documentElement).appendChild(css);
    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', addCss) : addCss();

    const measure = () => {
      const el = TILE ? document.querySelector(TILE) : document.body;
      if (!el || !el.offsetWidth) return null;
      return [el.offsetWidth, el.offsetHeight];
    };`;

/* Injected before any page script so it survives the reload we record. Pins the
   wanted tile over the viewport origin and stamps the moment it settles — the
   capture is sized to that box and the frames are aligned against t0. */
function isolationScript(tile) {
  return `(() => {
    ${pageSetup(tile)}
    /* t0 is not the moment the tile enters the DOM: layout runs ahead of paint,
       and the webfonts swap in a frame after that. Stamped too early, the clip
       opens on an empty background and a frame of fallback type. */
    const settle = fn => document.fonts.ready.then(() => {
      let n = 3;
      const tick = () => (--n ? requestAnimationFrame(tick) : fn());
      requestAnimationFrame(tick);
    });
    const mark = () => {
      const box = measure();
      if (!box) return false;
      settle(() => { window.__recBox = box; window.__recT0 = performance.now(); });
      return true;
    };
    const obs = new MutationObserver(() => { if (mark()) obs.disconnect(); });
    const start = () => { if (!mark()) obs.observe(document.documentElement, { childList: true, subtree: true }); };
    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start) : start();
  })()`;
}

/**
 * The clock shim, injected before any page code.
 *
 * Real-time screencast is capped by the compositor's 60Hz and starts dropping
 * frames as the picture grows. Stepping has no such ceiling: freeze the page's
 * clock, advance it one frame at a time, screenshot each position. Resolution and
 * frame rate stop being constraints and become arguments.
 *
 * Both kinds of motion have to be driven. These decks schedule their reveals with
 * setTimeout (`later()` in the deck's own React component), while the ambient
 * bobbing and blinking are CSS keyframes — seeking one without the other silently
 * records half the animation.
 */
function stepScript(tile) {
  return `(() => {
    ${pageSetup(tile)}
    const realSet = window.setTimeout.bind(window);
    let now = 0, seq = 1;
    const timers = new Map(), rafs = new Map(), births = new WeakMap();

    window.setTimeout = (fn, ms, ...a) => { timers.set(seq, { at: now + Math.max(0, ms || 0), fn, a }); return seq++; };
    window.setInterval = (fn, ms, ...a) => { const iv = Math.max(1, ms || 0); timers.set(seq, { at: now + iv, fn, a, iv }); return seq++; };
    window.clearTimeout = window.clearInterval = id => timers.delete(id);
    window.requestAnimationFrame = fn => { rafs.set(seq, fn); return seq++; };
    window.cancelAnimationFrame = id => rafs.delete(id);
    Date.now = () => ORIGIN + now;
    performance.now = () => now;

    /* One macrotask turn. React commits through a MessageChannel, not a timer, so
       without this the screenshot can land before the DOM the timers just changed. */
    const turn = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

    window.__step = async t => {
      now = t;
      for (let guard = 0; guard < 2000; guard++) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= now && (!next || x.at < next[1].at || (x.at === next[1].at && id < next[0]))) next = [id, x];
        if (!next) break;
        const [id, x] = next;
        if (x.iv) x.at = now + x.iv; else timers.delete(id);
        try { x.fn(...x.a); } catch {}
        await null;
      }
      for (const [id, fn] of [...rafs]) { rafs.delete(id); try { fn(now); } catch {} }
      /* An element revealed mid-clip starts its keyframes when it appears, so each
         animation is seeked relative to the step that first produced it. */
      for (const a of document.getAnimations()) {
        if (!births.has(a)) { births.set(a, now); try { a.pause(); } catch {} }
        try { a.currentTime = now - births.get(a); } catch {}
      }
      await turn();
    };
    /* Fast-forward without screenshotting, so a worker can pick up mid-timeline.
       Indexed off the same grid as the capture loop: accumulating dt drifts at
       frame rates that do not divide a second, like 30 or 60. */
    window.__fast = async (a, b, base, dt) => { for (let i = a; i < b; i++) await window.__step(base + i * dt); };
    window.__ready = () => { const b = measure(); return b ? (window.__recBox = b, true) : false; };
    realSet(() => {}, 0);
  })()`;
}

const READY = `(async () => {
  if (!window.__recT0) return false;
  await document.fonts.ready;
  return true;
})()`;

const STEP_READY = `(async () => {
  if (!window.__step || !window.__ready()) return false;
  await document.fonts.ready;
  return true;
})()`;

const MOUNT_HINT = 'the page never mounted — a raw .dc.html pulls React from unpkg.com, so it needs network access (drop --offline)';

/* Give up as soon as the caller stops caring: the browser work is minutes long and
   nothing downstream of it can be reused. */
const stop = signal => { if (signal?.aborted) throw new Error('cancelled'); };

/* One headless browser + one static server, reusable across several loads. The
   isolation script is swapped per load because it has to run before page code. */
async function openSession(input, { offline = false, signal, step = false } = {}) {
  let statics = null;
  let url = input;
  if (!isUrl(input)) {
    if (!existsSync(input)) throw new Error('no such file: ' + input);
    statics = await serveDir(path.resolve(path.dirname(input)));
    url = `http://127.0.0.1:${statics.port}/${encodeURIComponent(path.basename(input))}`;
  }

  const chromePort = 9500 + Math.floor(Math.random() * 400);
  const profile = await workDir('dcrec-');
  const browser = findChrome();
  /* chromeFlags carries the sRGB pin among others: the clip is tagged sRGB, so the
     frames have to actually be sRGB rather than whatever profile the machine
     underneath happens to be running. */
  const args = [
    ...chromeFlags(browser),
    `--user-data-dir=${profile}`, `--remote-debugging-port=${chromePort}`,
    '--window-size=1080,1350', 'about:blank',
  ];
  if (offline) args.unshift('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
  const chrome = spawn(browser.bin, args, spawnOpts());

  let cdp;
  try {
    cdp = await connectCdp(chromePort);
    await cdp.send('Page.enable');
  } catch (err) {
    killTree(chrome.pid);
    statics?.server.close();
    throw err;
  }

  let injected = null;
  const load = async tile => {
    if (injected) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected });
    injected = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: step ? stepScript(tile) : isolationScript(tile) })).identifier;
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    await cdp.send('Page.navigate', { url });
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      stop(signal);
      /* Under a frozen clock nothing with a delay ever runs, including whatever
         the page needs to mount. Re-running the queue at t=0 lets those through
         without moving the timeline. */
      if (step) await cdp.evaluate('window.__step ? window.__step(0) : 0').catch(() => {});
      if (await cdp.evaluate(step ? STEP_READY : READY).catch(() => false)) {
        return cdp.evaluate('JSON.stringify(window.__recBox)').then(JSON.parse);
      }
      /* The catch above is there to ride out a page mid-navigation, but a browser that
         has gone away is never coming back, and waiting out the full retry budget only
         ends in the mount hint — which blames the network for a dead browser. */
      if (cdp.dead) throw cdp.dead;
    }
    throw new Error(MOUNT_HINT);
  };

  const close = async () => {
    try { cdp.close(); } catch {}
    killTree(chrome.pid);
    statics?.server.close();
    await rmTree(profile);
  };
  return { cdp, url, load, close };
}

/* Screencast in real time. Virtual time looks tempting and is a trap: it stalls
   the compositor to ~1 painted frame per step and permanently skews the page's
   clock for the rest of the browser's life. */
async function captureFrames(session, { seconds, width, height, maxWidth, maxHeight, dir, onProgress, signal }) {
  const { cdp } = session;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const frames = [];
  const writes = [];
  const onFrame = m => {
    if (m.method !== 'Page.screencastFrame') return;
    const file = path.join(dir, `raw${String(frames.length).padStart(6, '0')}.png`);
    frames.push({ ts: m.params.metadata.timestamp * 1000, file });
    writes.push(writeFile(file, Buffer.from(m.params.data, 'base64')));
    cdp.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
  };
  cdp.on(onFrame);

  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(500);
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: maxWidth || width, maxHeight: maxHeight || height, everyNthFrame: 1 });
  await cdp.send('Page.navigate', { url: session.url });

  const until = Date.now() + (seconds + 5) * 1000;
  while (Date.now() < until) {
    await sleep(500);
    stop(signal);
    onProgress?.(Math.min(1, 1 - (until - Date.now()) / ((seconds + 5) * 1000)));
  }
  await cdp.send('Page.stopScreencast');
  cdp.off(onFrame);
  await sleep(500);
  await Promise.all(writes);

  const t0 = await cdp.evaluate('window.__recT0');
  if (t0 == null) throw new Error('the tile never appeared on the recorded pass');
  const origin = await cdp.evaluate('performance.timeOrigin');
  const elapsed = await cdp.evaluate('performance.now()') - t0;
  const rel = frames.map(f => ({ t: f.ts - (origin + t0), file: f.file })).sort((a, b) => a.t - b.t);
  if (!rel.length) throw new Error('no frames captured');
  return { frames: rel, elapsed };
}

/* Nearest-timestamp resample onto an even grid. Screencast frames arrive at the
   compositor's pace (~58fps here), not ours — and only when something moves, so
   the clip is measured against the wall clock rather than the last frame. A
   still tile legitimately produces two frames and a full-length video. */
async function resample(rel, { start, duration, fps, dir, prefix, elapsed }) {
  const need = (start + duration) * 1000;
  if (elapsed < need) {
    throw new Error(`capture ran short: ${Math.round(elapsed)}ms of the ${need}ms asked for`);
  }
  const count = Math.round(duration * fps);
  let idx = 0, worst = 0, reused = 0, prev = -1;
  for (let i = 0; i < count; i++) {
    const want = start * 1000 + (i * 1000) / fps;
    while (idx + 1 < rel.length && Math.abs(rel[idx + 1].t - want) <= Math.abs(rel[idx].t - want)) idx++;
    if (idx === prev) reused++;
    prev = idx;
    worst = Math.max(worst, Math.abs(rel[idx].t - want));
    await copyFile(rel[idx].file, path.join(dir, `${prefix}${String(i).padStart(5, '0')}.png`));
  }
  return { count, worst: Math.round(worst), reused, captured: rel.length };
}

/** List the artboards/tiles on a design page, each with a JPEG thumbnail. */
export async function probe(input, { offline = false, signal } = {}) {
  const session = await openSession(input, { offline, signal });
  try {
    await session.load(null);
    const tiles = await session.cdp.evaluate(`JSON.stringify(
      [...document.querySelectorAll('[data-screen-label]')].map(e => {
        const r = e.getBoundingClientRect();
        const label = e.dataset.screenLabel || '';
        return {
          selector: e.id ? '#' + e.id : '[data-screen-label="' + label + '"]',
          label, x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY),
          width: e.offsetWidth, height: e.offsetHeight,
        };
      }))`).then(JSON.parse);

    if (!tiles.length) {
      const box = await session.cdp.evaluate('JSON.stringify([document.body.offsetWidth, document.body.offsetHeight])').then(JSON.parse);
      tiles.push({ selector: null, label: 'whole page', x: 0, y: 0, width: box[0], height: box[1] });
    }
    for (const t of tiles) {
      stop(signal);
      const shot = await session.cdp.send('Page.captureScreenshot', {
        format: 'jpeg', quality: 74, captureBeyondViewport: true,
        clip: { x: t.x, y: t.y, width: t.width, height: t.height, scale: Math.min(1, 720 / t.width) },
      });
      t.thumb = 'data:image/jpeg;base64,' + shot.data;
    }
    const animations = await session.cdp.evaluate(
      `JSON.stringify([...new Set(document.getAnimations().map(a => a.animationName).filter(Boolean))])`).then(JSON.parse);
    return { tiles, animations };
  } finally {
    await session.close();
  }
}

/**
 * Find the shortest interval after which the tile repeats itself.
 *
 * Comparing PNG bytes only catches an exact repeat, which misses anything driven
 * by a JS timer or a fractional CSS period. Instead ffmpeg reduces every frame to
 * a small grey thumbnail and we compare those numerically.
 *
 * The clock is stepped rather than watched in real time. That is what makes the
 * comparison strict enough to be worth making: two frames a period apart come out
 * pixel-identical, so a real loop scores about 1 and anything else scores in the
 * hundreds. Recorded in real time the same frames arrive a few ms off and that
 * margin disappears into the noise.
 *
 * The score is the worst single cell, never the average. A slide can replay its
 * animation exactly while the words inside it move on — slide 01 does, its chat
 * script only comes back around after 45s — and averaged over a whole frame that
 * text is a rounding error. It would report a clean 9s loop for a clip that visibly
 * jumps at the seam.
 */
export async function detectLoop(input, { tile, offline = false, window: win = 40, onProgress, signal } = {}) {
  const dir = await workDir('dcloop-');
  const session = await openSession(input, { offline, signal, step: true });
  const FPS = 10, SKIP = 3, GRID = 24, SIZE = GRID * GRID, SAME = 20;
  try {
    if (win < SKIP + 2) return { loop: null, still: false };
    const [width, height] = await session.load(tile);
    const { cdp } = session;
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const clip = { x: 0, y: 0, width, height, scale: Math.min(1, 320 / width) };
    const count = Math.round(win * FPS);
    for (let i = 0; i < count; i++) {
      stop(signal);
      await cdp.evaluate(`window.__step(${i} * ${1000 / FPS})`);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip });
      await writeFile(path.join(dir, `g${String(i + 1).padStart(5, '0')}.png`), Buffer.from(shot.data, 'base64'));
      onProgress?.((i + 1) / count);
    }

    const raw = await run(ffmpegPath(), ['-v', 'error', '-i', path.join(dir, 'g%05d.png'),
      '-vf', `scale=${GRID}:${GRID},format=gray`, '-f', 'rawvideo', '-'], true);
    const n = Math.floor(raw.length / SIZE);
    const frame = i => raw.subarray(i * SIZE, (i + 1) * SIZE);
    const delta = (a, b) => {
      let max = 0;
      for (let k = 0; k < SIZE; k++) { const d = Math.abs(a[k] - b[k]); if (d > max) max = d; }
      return max;
    };

    const from = SKIP * FPS;
    let moving = 0;
    for (let i = from + 1; i < n; i++) moving = Math.max(moving, delta(frame(from), frame(i)));
    if (moving < SAME) return { loop: null, still: true };

    /* only up to half the usable span: a candidate period has to be checked
       against a full repeat of itself, or a long one "matches" on four seconds
       of overlap and reports a loop that is not there */
    for (let p = Math.round(FPS / 2); p <= Math.floor((n - from) / 2); p++) {
      let worst = 0;
      for (let i = from; i + p < n && worst < SAME; i++) worst = Math.max(worst, delta(frame(i), frame(i + p)));
      if (worst < SAME) {
        /* The scan ignores the first SKIP seconds so a one-time intro cannot veto a
           real loop — but then the clip has to start there too. Cut from zero and it
           opens on an intro it never comes back to, which is a visible jump at the
           seam even though the period is right. */
        let zero = 0;
        for (let i = 0; i + p < n && zero < SAME; i++) zero = Math.max(zero, delta(frame(i), frame(i + p)));
        return { loop: p / FPS, start: zero < SAME ? 0 : SKIP, still: false };
      }
    }
    return { loop: null, still: false };
  } finally {
    await session.close();
    await rmTree(dir);
  }
}

/**
 * Render one contiguous slice of the frame grid by stepping the page's clock.
 *
 * The slice is rendered from the beginning of the timeline, screenshotting only
 * its own frames. Jumping straight to the start would be faster and wrong: timers
 * would all fire in one lump and every animation born on the way would be dated
 * to the moment we arrived.
 */
async function stepShard(input, { tile, scale, offline, signal, fps, start, from, count, dir, onFrame }) {
  const session = await openSession(input, { offline, signal, step: true });
  try {
    const [w, h] = await session.load(tile);
    const { cdp } = session;
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w * scale, height: h * scale, deviceScaleFactor: 1, mobile: false });
    /* deviceScaleFactor does nothing for the screencast or for captureScreenshot
       here — it comes back at CSS size regardless. Zooming the tile into a viewport
       sized to match is what actually re-renders the design at a higher resolution. */
    if (scale !== 1) await cdp.evaluate(`document.querySelector(${JSON.stringify(tile)}).style.zoom = ${scale}`);

    /* The skipped intro has to be played, not jumped: it is where the reveals are,
       and an animation born during it is dated to whenever the clock first reached
       it. Land on the same grid the capture uses so the lead-in and the clip meet. */
    const dt = 1000 / fps, lead = Math.round(start * fps);
    if (lead + from > 0) await cdp.evaluate(`window.__fast(0, ${lead + from}, 0, ${dt})`);
    for (let i = from; i < from + count; i++) {
      stop(signal);
      await cdp.evaluate(`window.__step(${lead + i} * ${dt})`);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(dir, `f${String(i).padStart(5, '0')}.png`), Buffer.from(shot.data, 'base64'));
      onFrame?.();
    }
    return [w * scale, h * scale];
  } finally {
    await session.close();
  }
}

/* Every shard renders its own lead-in, so the work per shard is uneven — the last
   one replays the whole timeline. Splitting evenly still beats one browser, and the
   lead-in is ~1ms a frame against ~100ms to screenshot one. */
async function stepFrames(input, opts, dir) {
  const { fps, workers, onProgress } = opts;
  const total = Math.round(opts.duration * fps);
  const per = Math.ceil(total / Math.max(1, Math.min(workers, total)));
  const ranges = [];
  for (let from = 0; from < total; from += per) ranges.push([from, Math.min(per, total - from)]);

  let done = 0;
  const onFrame = () => onProgress?.('recording', ++done / total);
  const sizes = await Promise.all(ranges.map(([from, count]) =>
    stepShard(input, { ...opts, from, count, dir, onFrame })));

  return { size: sizes[0], count: total, captured: total, worst: 0, reused: 0 };
}

async function encode(dir, { fps, duration, audio, target, threads = coreBudget() }) {
  /* x264 helps itself to about 1.5 threads a core unless told otherwise, so encoding
     used to pin every core at 100% - a step up from the capture that came before it,
     and the one moment in a render when the box is least able to answer for itself.
     Given as an input option this bounds the PNG decoders, and again before the
     output it bounds the encoder; -filter_threads covers the colour conversion. */
  const t = String(threads);
  const args = ['-v', 'error', '-y', '-filter_threads', t, '-threads', t,
    '-framerate', String(fps), '-i', path.join(dir, 'f%05d.png')];
  if (audio) args.push('-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  args.push('-c:v', 'libx264', '-profile:v', 'high', '-level', '4.0', '-crf', '18');
  /* A still and a video of the same slide have to be the same colour: they sit next to
     each other in a carousel and a swipe between them shows any step.
     Range first — left to itself ffmpeg squeezes the picture into the 16-235 broadcast
     range and then writes "unknown", so every player guesses. Keeping the full 0-255 and
     saying so halved the round-trip error; limited range, even tagged, measured worse.
     Then the conversion: swscale's fixed-point coefficients cost a level over zimg's,
     mean 1.17/255 against 0.56 on a chart of flat patches. Both measure the same at
     -qp 0, so none of this drift is the compression — it is all RGB to YUV and back.
     Then the transfer, which is the one still visible on a phone. These frames come out
     of a browser, so they are sRGB, and tagging them bt709 asks a colour-managed viewer
     to decode them on a curve they were never encoded with: same primaries, different
     gamma, landing the clip 6 to 16 levels off the still beside it while every value in
     the file is "correct". iec61966-2-1 is sRGB, which is what they actually are.
     setparams does the labelling; the -color_trc output option looks like it would and
     silently leaves it unknown.
     zscale is zimg, and ffmpeg only carries it when built --enable-libzimg — which
     Homebrew's bottle and the usual Windows builds are not. Its advantage is real but
     under one level, and a missing filter is not a slightly worse clip, it is no clip
     at all, so swscale is the fallback rather than a hard requirement. The tagging is
     identical either way, and the tagging is the part that is visible on a phone. */
  const convert = hasZscale()
    ? 'zscale=matrix=709:range=full'
    : 'scale=in_range=full:out_range=full:in_color_matrix=bt709:out_color_matrix=bt709';
  args.push('-vf', convert + ',setparams=range=pc:colorspace=bt709'
    + ':color_primaries=bt709:color_trc=iec61966-2-1', '-pix_fmt', 'yuv420p');
  /* Deliberately no -shortest: silence is generated as fast as ffmpeg can ask for it
     while the video encodes in real time, and -shortest makes the muxer hold every
     packet until it knows which stream ended first. Measured at 2160x2700, that grew
     with the length of the clip — 1.6GB for six seconds, 4.2GB for forty — and it is
     what made a long render able to take the machine down. The -t above already ends
     the silence at exactly the right place, so nothing is lost by leaving it out. */
  if (audio) args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-threads', t, '-movflags', '+faststart', '-r', String(fps), target);
  /* Those flags bound each thread pool separately - decoder, filters, encoder,
     lookahead - and the pools still add up: measured on this 4-core box, 352% of a
     core uncapped and 308% with the flags alone. Pinning the process to the cores
     the capture was allowed is the only ceiling the kernel actually enforces, and it
     holds at 260%. It costs about 35% in wall time, which is the right way round for
     a box whose only failure that has ever mattered is going unreachable. */
  const ff = ffmpegPath();
  const pin = CAN_PIN_CPUS ? ['-c', `0-${threads - 1}`, ff] : [];
  await run(CAN_PIN_CPUS ? 'taskset' : ff, [...pin, ...args], false, 10);
}

/** Record one tile to an mp4. Returns the output path plus capture stats. */
export async function record(input, opts = {}) {
  const {
    tile, start = 0, fps = 30, audio = true, offline = false, out, keepFrames, onProgress, signal,
    scale = 1, workers = autoWorkers(),
  } = opts;
  if (!(opts.duration > 0)) throw new Error('duration is required');
  /* Real time is faster and good enough at 1080/60, which is all a social upload
     keeps. Past that the compositor is the limit, so step the clock instead. */
  const stepped = opts.stepped ?? (scale > 1 || fps > 60);
  const dir = await workDir('dcframes-');
  const target = path.resolve(out || path.join(process.cwd(), path.basename(input).replace(/\.[^.]+$/, '') + '.mp4'));
  let session = null;
  try {
    let width, height, stats;
    if (stepped) {
      stats = await stepFrames(input, { tile, scale, offline, signal, fps, start, duration: opts.duration, workers, onProgress }, dir);
      [width, height] = stats.size;
      delete stats.size;
    } else {
      session = await openSession(input, { offline, signal });
      const natural = await session.load(tile);
      [width, height] = opts.size ? opts.size.split('x').map(Number) : natural;
      const { frames, elapsed } = await captureFrames(session, {
        seconds: start + opts.duration, width, height, dir, signal,
        onProgress: p => onProgress?.('recording', p),
      });
      stats = await resample(frames, { start, duration: opts.duration, fps, dir, prefix: 'f', elapsed });
    }
    onProgress?.('encoding', 0);
    await encode(dir, { fps, duration: opts.duration, audio, target, threads: Math.min(workers, coreBudget()) });
    onProgress?.('encoding', 1);
    return { out: target, width, height, stepped, ...stats };
  } finally {
    await session?.close();
    if (keepFrames) console.log('frames kept in ' + dir);
    else await rmTree(dir);
  }
}

/**
 * One frame of a tile as a PNG, at any multiple of its own size.
 *
 * The clock is stepped up to `start` rather than jumped there, for the reason the
 * video shards replay their lead-in: an element revealed on the way dates its
 * animation to the step that produced it, so arriving late freezes the reveals
 * half-played. Stepping also means a slide that never settles still comes out at
 * a defined moment instead of whenever the screenshot happened to land.
 */
export async function snap(input, { tile, offline = false, scale = 1, start = 0, out, signal } = {}) {
  const session = await openSession(input, { offline, signal, step: true });
  const target = path.resolve(out || path.join(process.cwd(), path.basename(input).replace(/\.[^.]+$/, '') + '.png'));
  try {
    const [w, h] = await session.load(tile);
    const { cdp } = session;
    const width = Math.round(w * scale), height = Math.round(h * scale);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    if (scale !== 1) {
      await cdp.evaluate(`${tile ? `document.querySelector(${JSON.stringify(tile)})` : 'document.body'}.style.zoom = ${scale}`);
    }
    const dt = 1000 / 30, steps = Math.round(start * 30);
    if (steps > 0) await cdp.evaluate(`window.__fast(0, ${steps}, 0, ${dt})`);
    await cdp.evaluate(`window.__step(${steps} * ${dt})`);
    stop(signal);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(target, Buffer.from(shot.data, 'base64'));
    return { out: target, width, height };
  } finally {
    await session.close();
  }
}

function parseArgs(argv) {
  const opts = { fps: 30, start: 0, audio: true, offline: false, scale: 1, workers: autoWorkers() };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--png') opts.png = true;
    else if (a === '--probe') opts.probe = true;
    else if (a === '--detect') opts.detect = true;
    else if (a === '--keep-frames') opts.keepFrames = true;
    else if (a === '--no-audio') opts.audio = false;
    else if (a === '--offline') opts.offline = true;
    else if (a === '--doctor') opts.doctor = true;
    else if (a === '--stepped') opts.stepped = true;
    else if (a === '--realtime') opts.stepped = false;
    else if (a === '--tile') opts.tile = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--size') opts.size = argv[++i];
    else if (a === '--duration') opts.duration = Number(argv[++i]);
    else if (a === '--start') opts.start = Number(argv[++i]);
    else if (a === '--fps') opts.fps = Number(argv[++i]);
    else if (a === '--scale') opts.scale = Number(argv[++i]);
    else if (a === '--workers') opts.workers = Number(argv[++i]);
    else if (a.startsWith('--')) throw new Error('unknown option ' + a);
    else rest.push(a);
  }
  opts.input = rest[0];
  return opts;
}

/**
 * Say whether this machine can actually record anything, and if not, what to install.
 *
 * The two things this tool needs are the two things it cannot install for you, and
 * both fail late and unhelpfully — a missing ffmpeg surfaces as a broken pipe after
 * a render has already spent two minutes drawing frames. Asking up front turns that
 * into one line of advice.
 */
export async function doctor() {
  const line = (ok, name, detail) => console.log(`${ok ? ' ok ' : 'MISS'}  ${name.padEnd(9)} ${detail}`);
  let ready = true;
  console.log(`PlumiRecord on ${process.platform}/${process.arch}, Node ${process.version}\n`);

  if (Number(process.versions.node.split('.')[0]) < 22) {
    ready = false;
    line(false, 'node', 'needs v22 or newer (for its built-in WebSocket)');
  } else line(true, 'node', 'v22+, has WebSocket');

  try {
    const { bin, isShell } = findChrome();
    line(true, 'chrome', `${bin}${isShell ? '' : '  (full browser — headless shell would be leaner)'}`);
  } catch (err) { ready = false; line(false, 'chrome', err.message.split('\n').join('\n        ')); }

  try {
    line(true, 'ffmpeg', `${ffmpegPath()}${hasZscale() ? '' : '  (no zscale — colour converts via swscale, under a level off)'}`);
  } catch (err) { ready = false; line(false, 'ffmpeg', err.message.split('\n').join('\n        ')); }

  console.log(`\nworkers   ${autoWorkers()} (${coreBudget()} cores usable, ${(availableMb() / 1024).toFixed(1)}GB free)`);
  console.log(`data      ${dataDir()}`);
  const live = await listBrowsers().catch(() => []);
  console.log(`browsers  ${live.filter(b => b.leader).length} of ours running`);
  console.log(ready ? '\nReady.' : '\nNot ready — install what is missing above.');
  return ready;
}

export async function cli() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.doctor) { process.exit(await doctor() ? 0 : 1); }
  if (opts.help || !opts.input) { console.log(HELP); process.exit(opts.input ? 0 : 1); }
  const input = isUrl(opts.input) ? opts.input : path.resolve(opts.input);

  if (opts.probe) {
    const { tiles, animations } = await probe(input, opts);
    for (const t of tiles) console.log(`${(t.selector || '(page)').padEnd(28)} ${t.width}x${t.height}  ${t.label}`);
    console.log('animations: ' + (animations.join(', ') || 'none'));
    return;
  }

  if (opts.png) {
    const r = await snap(input, opts);
    console.log(`wrote ${r.out} (${r.width}x${r.height})`);
    return;
  }

  if (!opts.duration || opts.detect) {
    process.stderr.write('detecting the loop length...\n');
    const { loop, start, still } = await detectLoop(input, opts);
    const verdict = loop ? `loop: ${loop}s${start ? ` from ${start}s` : ''}` : still ? 'nothing on this page moves' : 'no loop found — pass --duration';
    if (opts.detect) { console.log(verdict); return; }
    if (!loop) throw new Error(verdict);
    opts.duration = loop;
    if (start && !opts.start) opts.start = start;
    process.stderr.write(`detected ${verdict}\n`);
  }

  console.log(`recording ${opts.duration}s @ ${opts.fps}fps...`);
  const r = await record(input, opts);
  console.log(r.stepped
    ? `stepped ${r.count} exact frames at ${r.width}x${r.height} across ${Math.min(opts.workers, r.count)} workers`
    : `captured ${r.captured} frames, kept ${r.count} at ${r.width}x${r.height} (worst drift ${r.worst}ms, ${r.reused} reused)`);
  console.log('wrote ' + r.out);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(err => { console.error('error: ' + err.message); process.exit(1); });
}
