/**
 * PlumiRecord's web UI — a drop-a-file front end for the recorder.
 *
 * Meant to be run two ways from the same code: on a laptop, where it is a local
 * app you open in a browser, and on an always-on box, where a handoff zip can be
 * dropped from a phone and comes back as a social-format mp4 without anyone
 * opening a terminal.
 *
 *   plumirecord-server --port 3005
 *
 * Uploads and renders live outside the repo, in the platform's application data
 * directory — @see platform.mjs.
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir, stat, rm, statfs } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  probe, detectLoop, record, snap,
  listBrowsers, reapBrowsers, autoWorkers, availableMb,
} from './recorder.mjs';
import { dataDir, sampleCpu, cpuUsage, swapMb, totalMb } from './platform.mjs';
import { unzip } from './unzip.mjs';

const PORT = Number(process.env.PORT || 3005);
/* Localhost by default: this is a personal tool with no login, so it has no business
   being reachable from the coffee-shop wifi. Serving it to a network is a deliberate
   act — see the README on putting it on a box.
   Deliberately not $HOST, tempting as the name is. That variable is already set to
   0.0.0.0 in plenty of shells and process managers for the benefit of some other
   program, and a tool that silently publishes itself to the network because of a
   variable its user never aimed at it is not a default, it is an accident. */
const HOST = process.env.PLUMIRECORD_HOST || '127.0.0.1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');
const DATA = dataDir();
const SOURCES = path.join(DATA, 'sources');
const RENDERS = path.join(DATA, 'renders');
const MAX_UPLOAD = 400 * 1024 * 1024;

const slug = s => (s || '').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'file';

/* One headless Chrome at a time: two of them on this box fight over the profile
   lock and neither finishes.
   The queue is only ever as reliable as its slowest link: a task that never settles
   holds every later one behind it for the life of the process. releaseQueue() below
   cuts the chain, and the epoch is what makes that safe — an abandoned task still
   settles eventually, and without it that late decrement would corrupt the count of
   the queue that replaced it. */
let tail = Promise.resolve();
let busy = 0;
let epoch = 0;
function serial(fn) {
  const mine = epoch;
  busy++;
  clearTimeout(idleTimer);
  const result = tail.then(() => fn());
  tail = result.catch(() => {});
  result.finally(() => { if (mine === epoch && --busy === 0) armIdleReap(); }).catch(() => {});
  return result;
}
function releaseQueue() {
  epoch++;
  tail = Promise.resolve();
  busy = 0;
  armIdleReap();
}

/* Anything that drives a browser registers its controller here so it can be called
   off. A job has an id and its own controller; a probe is a plain request/response
   and has neither, but it opens a browser and holds the queue exactly the same way. */
const aborts = new Set();
function abortable(fn) {
  const ctl = new AbortController();
  aborts.add(ctl);
  return serial(() => fn(ctl.signal)).finally(() => aborts.delete(ctl));
}

/* A browser outlives the process that started it, so one still alive long after the
   last job is a leak by definition — a cancelled render whose cleanup never ran, or
   one that died with the recorder. Left alone each sits on ~600MB until the box runs
   out, so sweep instead of waiting to be asked. */
const IDLE_REAP_MS = 5 * 60 * 1000;
let idleTimer = null;
function armIdleReap() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (busy) return armIdleReap();
    const killed = await reapBrowsers({ frames: true }).catch(() => 0);
    if (killed) console.log(`idle ${IDLE_REAP_MS / 60000}min: reaped ${killed} leftover browser(s)`);
  }, IDLE_REAP_MS);
  idleTimer.unref();
}

const jobs = new Map();
function newJob(kind) {
  const job = { id: randomUUID().slice(0, 8), kind, phase: 'queued', pct: 0, done: false, watchers: new Set(), ctl: new AbortController() };
  jobs.set(job.id, job);
  return job;
}
function push(job, patch) {
  Object.assign(job, patch);
  const line = `data: ${JSON.stringify({ phase: job.phase, pct: job.pct, done: job.done, result: job.result, error: job.error })}\n\n`;
  for (const res of job.watchers) res.write(line);
  if (job.done) { for (const res of job.watchers) res.end(); job.watchers.clear(); }
}

/* An upload lands as a staging folder and only earns a meta file once someone has
   said which pages are worth keeping. That marker is the whole difference between a
   shelf and a pile: before this the box kept every upload for ever with no way back
   to one, so the same handoff got re-uploaded until 23 copies of it were on disk. */
const META = '_recorder.json';
const COVER = '_cover.jpg';
/* Claude Design puts a picture of the deck at the root of the zip. */
const ZIP_COVER = '.thumbnail';
const STAGE_TTL_MS = 12 * 60 * 60 * 1000;

const workDirOf = id => {
  if (!/^[\w-]+$/.test(id || '')) throw new Error('bad id');
  return path.join(SOURCES, id);
};
const meta = async id => { try { return JSON.parse(await readFile(path.join(workDirOf(id), META), 'utf8')); } catch { return null; } };
const putMeta = (id, m) => writeFile(path.join(workDirOf(id), META), JSON.stringify(m, null, 2));

/* Paths inside a work are kept posix-style whatever the OS, because they travel:
   into the JSON the browser holds, into the meta file on disk, and back again on the
   next request. `at()` is the one place they turn back into a real path. */
const at = (dir, rel) => path.join(dir, ...rel.split('/'));

async function walkFiles(dir, rel = '') {
  const out = [];
  for (const e of await readdir(at(dir, rel || '.'), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await walkFiles(dir, r));
    else out.push(r);
  }
  return out;
}

/* The .dc.html prototypes are the real designs; export/ holds pre-bundled copies of
   the same thing. A bundle usually carries early drafts alongside the finished deck,
   and unzip flattens the timestamps, so size is the only signal left for which one
   has the most slides in it. */
const rankPages = list => list.sort((a, b) => (b.path.includes('.dc.html') - a.path.includes('.dc.html'))
  || (a.path.includes('/export/') - b.path.includes('/export/')) || b.size - a.size);

async function findPages(dir) {
  const pages = [];
  for (const f of await walkFiles(dir)) {
    if (!/\.html?$/i.test(f) || f.split('/')[0] === '_ds') continue;
    pages.push({ path: f, size: (await stat(at(dir, f))).size });
  }
  return rankPages(pages);
}

const titleOf = p => p.split('/').pop().replace(/\.dc\.html$|\.\w+$/, '');

/** Unpack an upload into staging and list what is inside it. Nothing is kept yet. */
async function ingest(name, bytes) {
  const id = Date.now().toString(36) + '-' + randomUUID().slice(0, 4);
  const dir = path.join(SOURCES, id);
  await mkdir(dir, { recursive: true });

  if (name.toLowerCase().endsWith('.zip')) {
    /* Read in process rather than shelling out to `unzip`, which Windows does not
       have. @see unzip.mjs. __MACOSX is the resource-fork shadow tree a Mac adds to
       every archive it makes; skipping it up front beats deleting it afterwards. */
    await unzip(bytes, dir, { skip: rel => rel.startsWith('__MACOSX/') });
  } else {
    await writeFile(path.join(dir, slug(name)), bytes);
  }

  const pages = await findPages(dir);
  if (!pages.length) {
    await rm(dir, { recursive: true, force: true });
    throw new Error('no HTML page in that upload');
  }
  const files = await walkFiles(dir);
  return {
    id, name: name.replace(/\.zip$/i, ''),
    pages: pages.map(p => ({ path: p.path, title: titleOf(p.path), size: p.size })),
    others: files.length - pages.length,
    cover: existsSync(path.join(dir, ZIP_COVER)) ? `/works/${id}/cover` : null,
  };
}

/* Keeping a page means keeping what it draws with. Rather than parse the HTML, look
   for each file's own name inside the pages being kept, and then inside the scripts
   and stylesheets those pull in — a reference can be written a dozen ways but the
   file name is in all of them. Guessing wide is the safe direction here: an extra
   40KB asset costs nothing, a missing one renders the slide wrong. */
async function prune(dir, keepPages) {
  const all = await walkFiles(dir);
  const keep = new Set([META, COVER, ZIP_COVER, ...keepPages]);
  let text = '';
  const absorb = async f => { text += await readFile(at(dir, f), 'utf8').catch(() => ''); };
  for (const p of keepPages) await absorb(p);

  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    for (const f of all) {
      if (keep.has(f)) continue;
      const base = path.basename(f);
      if (!text.includes(base) && !text.includes(encodeURIComponent(base))) continue;
      keep.add(f);
      grew = true;
      if (/\.(css|js|json)$/i.test(f)) await absorb(f);
    }
    if (!grew) break;
  }

  /* Counted as they go rather than as the difference of the two sets: `keep` is
     seeded with names that may not be on disk at all — a cover this upload never had —
     so the subtraction reports fewer files dropped than there were, and can go
     negative on a small bundle. */
  let dropped = 0;
  for (const f of all) if (!keep.has(f)) { await rm(at(dir, f), { force: true }); dropped++; }
  const dropEmpty = async (rel = '') => {
    for (const e of await readdir(at(dir, rel || '.'), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      await dropEmpty(r);
      if (!(await readdir(at(dir, r))).length) await rm(at(dir, r), { recursive: true, force: true });
    }
  };
  await dropEmpty();
  return dropped;
}

async function sizeOf(dir) {
  let n = 0;
  for (const f of await walkFiles(dir)) n += (await stat(at(dir, f)).catch(() => ({ size: 0 }))).size;
  return n;
}

/** Promote a staged upload to a kept work, throwing away everything not chosen. */
async function keepPages(id, wanted, name) {
  const dir = workDirOf(id);
  const pages = await findPages(dir);
  const chosen = rankPages(pages.filter(p => wanted.includes(p.path)));
  if (!chosen.length) throw new Error('pick at least one page to keep');

  const dropped = await prune(dir, chosen.map(p => p.path));
  const m = {
    name: name || titleOf(chosen[0].path),
    at: Date.now(),
    pages: chosen.map(p => ({ path: p.path, title: titleOf(p.path) })),
    cover: existsSync(path.join(dir, ZIP_COVER)) ? ZIP_COVER : null,
    bytes: await sizeOf(dir),
  };
  await putMeta(id, m);
  return { ...entry(id, m), dropped };
}

const entry = (id, m) => ({
  id, name: m.name, at: m.at, pages: m.pages, bytes: m.bytes,
  cover: m.cover ? `/works/${id}/cover` : null,
});

async function works() {
  const out = [];
  for (const id of await readdir(SOURCES).catch(() => [])) {
    const m = await meta(id);
    if (m) out.push(entry(id, m));
  }
  return out.sort((a, b) => b.at - a.at);
}

/* The first time a work is opened it is probed anyway, so the picture of its first
   slide is already in hand — better than nothing on the shelf, and free. */
async function saveCover(id, thumb) {
  const m = await meta(id);
  if (!m || m.cover || !thumb?.startsWith('data:image/')) return;
  await writeFile(path.join(workDirOf(id), COVER), Buffer.from(thumb.split(',')[1], 'base64'));
  await putMeta(id, { ...m, cover: COVER });
}

/* The page name arrives from the browser and so is not to be trusted with a path.
   workDirOf vets the id; the separator on the second check is what stops a sibling
   directory whose name merely starts the same way from passing it. */
function sourcePage(id, page) {
  const dir = path.resolve(workDirOf(id));
  const file = path.resolve(at(dir, String(page || '')));
  if (!file.startsWith(dir + path.sep)) throw new Error('bad path');
  return file;
}

async function library() {
  const out = [];
  for (const name of await readdir(RENDERS).catch(() => [])) {
    if (!/\.(mp4|png)$/.test(name)) continue;
    const s = await stat(path.join(RENDERS, name));
    out.push({ name, size: s.size, at: s.mtimeMs });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 40);
}

/* What a render is about to cost, so one the box cannot hold is refused rather than
   started. Measured here: a browser rendering a 2160x2700 tile holds ~700MB, and x264
   at that size holds 1.6GB however long the clip is — its buffers are a function of
   frame size, not frame count. The two are the peak rather than the sum, because
   every browser is closed before encoding begins. Frames are ~31KB per megapixel and
   go to disk, so they cost memory nothing at all. */
const HEADROOM_MB = 900;
function budget({ kind, w = 1080, h = 1350, scale = 1, fps = 30, duration = 0 }) {
  const mpx = (w * h * scale * scale) / 1e6;
  /* A still is one browser drawing one frame however big it is asked to be; only a
     video is ever split across several. */
  const workers = kind !== 'png' && (scale > 1 || fps > 60) ? autoWorkers() : 1;
  return {
    workers,
    ramMb: Math.round(Math.max(workers * 700, duration ? mpx * 300 : 0, 300)),
    diskMb: Math.round(duration * fps * mpx * 31 / 1024),
  };
}

/* Two readings are needed for a rate, so this is sampled on a timer rather than per
   request: two open tabs polling would otherwise each get a fraction of the other's
   window and both report nonsense. @see platform.mjs for where the numbers come from. */
sampleCpu();
setInterval(sampleCpu, 2000).unref();

async function stats() {
  const browsers = await listBrowsers();
  const disk = await statfs(DATA).catch(() => null);
  /* Windows will not say what its page file is doing, and a made-up number is worse
     than an absent one — the UI hides the meter when this is null. */
  const swap = swapMb();
  return {
    cpu: cpuUsage(), cores: cpus().length,
    dataDir: DATA,
    ramTotalMb: totalMb(),
    ramFreeMb: availableMb(),
    swapUsedMb: swap ? swap.used : null,
    swapTotalMb: swap ? swap.total : null,
    diskFreeMb: disk ? Math.round(Number(disk.bavail) * Number(disk.bsize) / 1048576) : null,
    /* Summing the tree double-counts what its processes share, exactly as `ps` does.
       It is the right order of magnitude and it is the number a task manager shows. */
    browsers: browsers.filter(b => b.leader).length,
    browserMb: Math.round(browsers.reduce((s, b) => s + b.rssMb, 0)),
    busy, workers: autoWorkers(),
  };
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', d => {
      n += d.length;
      if (n > MAX_UPLOAD) { reject(new Error('upload too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const ROUTES = {
  async 'POST /api/source'(req, res, url) {
    const name = url.searchParams.get('name') || 'upload.html';
    json(res, 200, await ingest(name, await readBody(req)));
  },
  /* Chosen pages stay, the rest of the upload goes. Nothing is recorded here — the
     point is to be able to import a handoff now and decide what to make of it later. */
  async 'POST /api/source/keep'(req, res) {
    const { id, pages, name } = JSON.parse(await readBody(req));
    json(res, 200, await keepPages(id, Array.isArray(pages) ? pages : [], name));
  },
  async 'POST /api/source/discard'(req, res) {
    const { id } = JSON.parse(await readBody(req));
    if (await meta(id)) throw new Error('that one is on the shelf — throw it away from there');
    await rm(workDirOf(id), { recursive: true, force: true });
    json(res, 200, { ok: true });
  },
  async 'GET /api/works'(req, res) {
    json(res, 200, await works());
  },
  async 'POST /api/probe'(req, res) {
    const { id, page, url } = JSON.parse(await readBody(req));
    const input = url || sourcePage(id, page);
    const found = await abortable(signal => probe(input, { signal }));
    if (id) await saveCover(id, found.tiles[0]?.thumb).catch(() => {});
    json(res, 200, found);
  },
  async 'POST /api/jobs'(req, res) {
    const body = JSON.parse(await readBody(req));
    const input = body.url || sourcePage(body.id, body.page);

    /* Starting a render the machine cannot finish used to take the whole box down
       with it, so say no while saying no is still possible. */
    if (body.kind !== 'detect') {
      const need = budget({
        kind: body.kind,
        w: Number(body.w) || 1080, h: Number(body.h) || 1350, scale: Number(body.scale) || 1,
        fps: Number(body.fps) || 30, duration: Number(body.duration) || 0,
      });
      const spare = availableMb() - HEADROOM_MB;
      if (need.ramMb > spare) {
        return json(res, 507, {
          error: `this needs about ${(need.ramMb / 1024).toFixed(1)}GB and only ${(Math.max(0, spare) / 1024).toFixed(1)}GB is safe to use right now — try a smaller size or fewer fps, or free some memory first`,
        });
      }
    }

    const job = newJob(body.kind);

    if (body.kind === 'detect') {
      serial(async () => {
        if (job.ctl.signal.aborted) return push(job, { phase: 'cancelled', done: true, error: 'cancelled' });
        push(job, { phase: 'playing the page, looking for a repeat', pct: 0 });
        try {
          const found = await detectLoop(input, {
            tile: body.tile, window: body.window || 40, signal: job.ctl.signal,
            onProgress: p => push(job, { pct: p }),
          });
          push(job, { phase: 'done', pct: 1, done: true, result: found });
        } catch (err) { push(job, { done: true, error: err.message }); }
      });
    } else if (body.kind === 'png') {
      const file = `${slug(body.name || 'still')}-${Date.now().toString(36)}.png`;
      serial(async () => {
        if (job.ctl.signal.aborted) return push(job, { phase: 'cancelled', done: true, error: 'cancelled' });
        push(job, { phase: 'drawing the frame', pct: 0 });
        try {
          await mkdir(RENDERS, { recursive: true });
          const r = await snap(input, {
            tile: body.tile, start: Number(body.start) || 0, scale: Number(body.scale) || 1,
            out: path.join(RENDERS, file), signal: job.ctl.signal,
          });
          push(job, { phase: 'done', pct: 1, done: true, result: { file, ...r, out: undefined } });
        } catch (err) { push(job, { done: true, error: err.message }); }
      });
    } else {
      const file = `${slug(body.name || 'clip')}-${Date.now().toString(36)}.mp4`;
      serial(async () => {
        if (job.ctl.signal.aborted) return push(job, { phase: 'cancelled', done: true, error: 'cancelled' });
        push(job, { phase: 'starting the browser', pct: 0 });
        try {
          await mkdir(RENDERS, { recursive: true });
          const r = await record(input, {
            tile: body.tile, duration: Number(body.duration), start: Number(body.start) || 0,
            fps: Number(body.fps) || 30, scale: Number(body.scale) || 1,
            out: path.join(RENDERS, file), signal: job.ctl.signal,
            onProgress: (phase, pct) => push(job, { phase: phase === 'encoding' ? 'encoding the mp4' : 'drawing frames', pct }),
          });
          push(job, { phase: 'done', pct: 1, done: true, result: { file, ...r, out: undefined } });
        } catch (err) { push(job, { done: true, error: err.message }); }
      });
    }
    json(res, 200, { job: job.id });
  },
  async 'GET /api/library'(req, res) {
    json(res, 200, await library());
  },
  async 'GET /api/stats'(req, res) {
    json(res, 200, await stats());
  },
  /* "I am done working" — the browsers are the expensive thing on this box, and
     leaving one running costs more than any job it was still doing. */
  async 'POST /api/browsers/kill'(req, res) {
    const wasBusy = busy > 0;
    for (const job of jobs.values()) if (!job.done) job.ctl.abort();
    for (const ctl of aborts) ctl.abort();
    const killed = await reapBrowsers({ frames: !wasBusy });
    /* This is also the way out of a wedged queue, and the only one that does not need
       a terminal. Every browser is dead by the time we reach this line, so nothing
       still queued can make progress; keeping the chain would only pass the wedge on
       to the next upload. */
    releaseQueue();
    json(res, 200, { killed, wasBusy });
  },
};


const STATIC = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = `${req.method} ${url.pathname}`;
  try {
    if (ROUTES[key]) return await ROUTES[key](req, res, url);

    /* Picking a different slide should not leave you queued behind the render you
       no longer want — the browser work is the whole wait. */
    const cancel = url.pathname.match(/^\/api\/jobs\/([\w-]+)\/cancel$/);
    if (cancel && req.method === 'POST') {
      jobs.get(cancel[1])?.ctl.abort();
      return json(res, 200, { ok: true });
    }

    const events = url.pathname.match(/^\/api\/jobs\/([\w-]+)\/events$/);
    if (events && req.method === 'GET') {
      const job = jobs.get(events[1]);
      if (!job) return json(res, 404, { error: 'no such job' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      job.watchers.add(res);
      push(job, {});
      req.on('close', () => job.watchers.delete(res));
      return;
    }

    const work = url.pathname.match(/^\/(?:api\/)?works\/([\w-]+)(\/cover)?$/);
    if (work && req.method === 'DELETE') {
      await rm(workDirOf(work[1]), { recursive: true, force: true });
      return json(res, 200, { ok: true });
    }
    if (work && work[2] && req.method === 'GET') {
      const m = await meta(work[1]);
      const file = path.join(workDirOf(work[1]), m?.cover || ZIP_COVER);
      const body = await readFile(file).catch(() => null);
      if (!body) return json(res, 404, { error: 'no cover' });
      res.writeHead(200, { 'content-type': m?.cover === COVER ? 'image/jpeg' : 'image/webp', 'cache-control': 'no-cache' });
      return res.end(body);
    }

    const render = url.pathname.match(/^\/renders\/([\w.-]+\.(mp4|png))$/);
    if (render && req.method === 'DELETE') {
      /* Throwing a file away is the one route where a crafted name must not be able
         to reach outside the shelf, so re-check the path after resolving it. */
      const file = path.resolve(RENDERS, render[1]);
      if (!file.startsWith(path.resolve(RENDERS) + path.sep)) return json(res, 400, { error: 'bad path' });
      await rm(file, { force: true });
      return json(res, 200, { ok: true });
    }
    if (render) {
      const file = path.join(RENDERS, render[1]);
      const s = await stat(file).catch(() => null);
      if (!s) return json(res, 404, { error: 'gone' });
      res.writeHead(200, {
        'content-type': render[2] === 'png' ? 'image/png' : 'video/mp4', 'content-length': s.size,
        'content-disposition': url.searchParams.has('download') ? `attachment; filename="${render[1]}"` : 'inline',
      });
      return createReadStream(file).pipe(res);
    }

    const asset = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
    const body = await readFile(path.join(PUBLIC, asset));
    res.writeHead(200, { 'content-type': STATIC[path.extname(asset)] || 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    json(res, 400, { error: err.message });
  }
});

await mkdir(RENDERS, { recursive: true });
await mkdir(SOURCES, { recursive: true });

/* A source directory with pages in it but no meta file is either staging nobody has
   finished with, or a shelf from a data directory this version did not write — an
   upgrade, or a PLUMIRECORD_DATA pointed somewhere older. The second kind is somebody's
   real work, so it is adopted rather than swept, and nothing is pruned: no one chose
   these pages, so no one can be said to have rejected the rest. Only directories older
   than the staging window qualify, so a live upload is never mistaken for one. */
for (const id of await readdir(SOURCES).catch(() => [])) {
  const dir = path.join(SOURCES, id);
  const st = await stat(dir).catch(() => null);
  if (!st?.isDirectory() || await meta(id) || Date.now() - st.mtimeMs < STAGE_TTL_MS) continue;
  const pages = await findPages(dir).catch(() => []);
  if (!pages.length) continue;
  await putMeta(id, {
    name: titleOf(pages[0].path),
    at: st.mtimeMs,
    pages: pages.map(p => ({ path: p.path, title: titleOf(p.path) })),
    cover: existsSync(path.join(dir, ZIP_COVER)) ? ZIP_COVER : null,
    bytes: await sizeOf(dir),
    adopted: true,
  });
  console.log(`startup: adopted earlier upload ${id}`);
}

/* From here on an upload nobody kept anything from is rubbish, and sweeping it is
   what stops the box filling up the way it did. */
for (const id of await readdir(SOURCES).catch(() => [])) {
  const dir = path.join(SOURCES, id);
  const s = await stat(dir).catch(() => null);
  if (!s?.isDirectory() || await meta(id)) continue;
  if (Date.now() - s.mtimeMs > STAGE_TTL_MS) await rm(dir, { recursive: true, force: true });
}

/* Nothing can be running yet, so any browser alive at this point belongs to a
   previous life of this process and is holding memory nobody is going to reclaim.
   This is the restart that finally clears a box that has been leaking for days. */
const stale = await reapBrowsers({ frames: true }).catch(() => 0);
if (stale) console.log(`startup: reaped ${stale} browser(s) left over from a previous run`);
armIdleReap();

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`PlumiRecord  →  http://${shown}:${PORT}`);
  console.log(`data in ${DATA}`);
  if (HOST === '0.0.0.0' || HOST === '::') console.log('listening on every interface — there is no login, so put it behind one.');
});
