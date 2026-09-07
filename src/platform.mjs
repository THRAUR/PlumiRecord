/**
 * Everything PlumiRecord has to ask the operating system, in one place.
 *
 * The recorder itself is portable — it drives Chrome over a socket and pipes PNGs
 * into ffmpeg, and neither of those cares what it is running on. What is not
 * portable is finding those two programs, knowing how much of the machine is left,
 * and killing a browser that has stopped answering. Linux, macOS and Windows each
 * disagree about all three, so the disagreement is confined here and the rest of
 * the codebase gets one answer.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { cpus, freemem, homedir, totalmem, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';
const EXE = IS_WIN ? '.exe' : '';

/* ---------------------------------------------------------------- where things live */

/**
 * Where uploads, renders and scratch frames go.
 *
 * Deliberately not the repo and deliberately not the system temp directory. On
 * Linux /tmp is usually tmpfs, so a long render fills RAM with files that killing
 * processes cannot free and the machine dies with nothing left to kill; on Windows
 * the temp directory is swept by the OS underneath a running job. Every platform
 * has a real answer for "an application's own data" and this uses it.
 */
export function dataDir() {
  if (process.env.PLUMIRECORD_DATA) return process.env.PLUMIRECORD_DATA;
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'PlumiRecord');
  if (IS_MAC) return path.join(homedir(), 'Library', 'Application Support', 'PlumiRecord');
  return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'plumirecord');
}

/** Where the browser-download caches live, so a Playwright or Puppeteer install is found for free. */
function browserCaches() {
  const home = homedir();
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(local, 'ms-playwright'), path.join(home, '.cache', 'puppeteer')];
  }
  if (IS_MAC) {
    return [path.join(home, 'Library', 'Caches', 'ms-playwright'), path.join(home, '.cache', 'puppeteer')];
  }
  return [path.join(home, '.cache', 'ms-playwright'), path.join(home, '.cache', 'puppeteer')];
}

/* ---------------------------------------------------------------- finding a browser */

/* A downloaded browser is two directories deep and the middle one is named for the
   version and the architecture — chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/.
   Pinning those names means a Playwright update silently stops being found, so the
   layout is walked instead of spelled out. */
function scanCache(root, dirPrefixes, exeNames) {
  const hits = [];
  let top;
  try { top = readdirSync(root); } catch { return hits; }
  for (const a of top) {
    if (!dirPrefixes.some(p => a.startsWith(p))) continue;
    let mid;
    try { mid = readdirSync(path.join(root, a)); } catch { continue; }
    for (const b of mid) {
      for (const exe of exeNames) {
        const p = path.join(root, a, b, exe + EXE);
        if (existsSync(p)) hits.push({ path: p, version: a });
        const nested = path.join(root, a, b, exe + '.app', 'Contents', 'MacOS', exe);
        if (IS_MAC && existsSync(nested)) hits.push({ path: nested, version: a });
      }
    }
  }
  /* Newest version first: "chromium-1200" sorts above "chromium-999" numerically, and
     as text it does not. */
  return hits.sort((x, y) => (Number(y.version.match(/(\d+)$/)?.[1] || 0)) - (Number(x.version.match(/(\d+)$/)?.[1] || 0)));
}

/** Chrome installed the ordinary way, per platform. */
function systemChromes() {
  const home = homedir();
  if (IS_MAC) {
    const apps = ['Google Chrome', 'Google Chrome Canary', 'Chromium', 'Brave Browser', 'Microsoft Edge'];
    const roots = ['/Applications', path.join(home, 'Applications')];
    return roots.flatMap(r => apps.map(a => path.join(r, `${a}.app`, 'Contents', 'MacOS', a)));
  }
  if (IS_WIN) {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    return roots.flatMap(r => [
      path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(r, 'Chromium', 'Application', 'chrome.exe'),
      path.join(r, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]);
  }
  return [
    '/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    '/usr/bin/brave-browser', '/usr/bin/microsoft-edge',
  ];
}

let chromeCache = null;

/**
 * The browser to record with, and whether it needs to be told to be headless.
 *
 * `chrome-headless-shell` is preferred over a full Chrome for the same reason
 * Playwright ships it separately: it is the rendering half without the browser
 * around it, so it starts faster and holds a few hundred megabytes less — and on
 * this tool's hot path there may be four of them at once. A normal Chrome works
 * and is what most people already have, so it is the fallback rather than an error.
 */
export function findChrome() {
  if (chromeCache) return chromeCache;
  const explicit = process.env.PLUMIRECORD_CHROME || process.env.CHROME_HEADLESS_SHELL || process.env.CHROME_PATH;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`no browser at ${explicit} (from the environment)`);
    return (chromeCache = describeChrome(explicit));
  }
  for (const cache of browserCaches()) {
    const shell = scanCache(cache, ['chromium_headless_shell-', 'chrome-headless-shell'], ['chrome-headless-shell']);
    if (shell.length) return (chromeCache = describeChrome(shell[0].path));
  }
  for (const cache of browserCaches()) {
    const full = scanCache(cache, ['chromium-', 'chrome'], ['chrome', 'headless_shell', 'Chromium', 'Google Chrome']);
    if (full.length) return (chromeCache = describeChrome(full[0].path));
  }
  const system = systemChromes().find(existsSync);
  if (system) return (chromeCache = describeChrome(system));
  throw new Error(
    'no Chrome found. Install one with:\n'
    + '  npx playwright install chromium-headless-shell\n'
    + 'or install Google Chrome normally, or point PLUMIRECORD_CHROME at a binary.');
}

const describeChrome = bin => ({ bin, isShell: /chrome-headless-shell|headless_shell/i.test(path.basename(bin)) });

/**
 * The flags every launch needs, plus the ones only a full Chrome needs.
 *
 * A headless shell is headless by construction; a full Chrome has to be asked, and
 * then talked out of the power-saving it does when it believes nobody is looking.
 * Real-time capture is the case that cares: a throttled background timer does not
 * produce the animation we are pointing a camera at.
 */
export function chromeFlags({ isShell }) {
  const flags = [
    '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--force-color-profile=srgb', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-features=Translate,MediaRouter',
  ];
  /* Containers and WSL cannot give Chrome the user namespaces its sandbox wants, and
     that is most of where this runs unattended. macOS and Windows have no such
     problem, so they keep the sandbox. */
  if (IS_LINUX) flags.push('--no-sandbox', '--disable-dev-shm-usage');
  if (!isShell) flags.push('--headless=new');
  return flags;
}

/* ---------------------------------------------------------------- finding ffmpeg */

let ffmpegCache = null;

/** ffmpeg, from the environment or the PATH. Resolved once and remembered. */
export function ffmpegPath() {
  if (ffmpegCache) return ffmpegCache;
  const explicit = process.env.PLUMIRECORD_FFMPEG || process.env.FFMPEG_PATH;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`no ffmpeg at ${explicit} (from the environment)`);
    return (ffmpegCache = explicit);
  }
  try {
    execFileSync('ffmpeg' + EXE, ['-version'], { stdio: 'ignore', windowsHide: true });
    return (ffmpegCache = 'ffmpeg' + EXE);
  } catch { /* fall through to the advice below */ }
  const how = IS_MAC ? 'brew install ffmpeg'
    : IS_WIN ? 'winget install Gyan.FFmpeg   (then reopen your terminal)'
      : 'sudo apt install ffmpeg';
  throw new Error(`ffmpeg is not on your PATH. Install it with:\n  ${how}\nor point PLUMIRECORD_FFMPEG at the binary.`);
}

/* Pinning a render to a subset of cores needs taskset, which is Linux and
   util-linux only. Everywhere else ffmpeg's own thread flags are the whole cap —
   softer, but not nothing. */
export const CAN_PIN_CPUS = IS_LINUX && existsSync('/usr/bin/taskset');

/* ---------------------------------------------------------------- how much is left */

/**
 * Megabytes the machine could actually give a new process.
 *
 * Not `os.freemem()`. On macOS that is the count of completely untouched pages,
 * which on a healthy Mac is near zero because the OS spends everything it is not
 * using on cache — believing it would make this tool refuse every render on a
 * machine with 32GB free. Linux and macOS both publish the honest number somewhere
 * else, so each is read where it lives, and the reading is cached because the
 * macOS one costs a subprocess and the stats endpoint asks every two seconds.
 */
let memAt = 0, memMb = 0;
export function availableMb() {
  const now = Date.now();
  if (now - memAt < 2000 && memMb) return memMb;
  memAt = now;
  return (memMb = measureAvailableMb());
}

function measureAvailableMb() {
  if (IS_LINUX) {
    try {
      const m = readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/);
      if (m) return Math.round(Number(m[1]) / 1024);
    } catch { /* an unusual kernel; the rough number below will do */ }
  }
  if (IS_MAC) {
    try {
      const out = execFileSync('vm_stat', [], { encoding: 'utf8' });
      const size = Number(out.match(/page size of (\d+)/)?.[1] || 4096);
      const pages = k => Number(out.match(new RegExp(`${k}:\\s+(\\d+)`))?.[1] || 0);
      /* Free plus everything the OS would hand over without asking anyone: inactive
         pages, speculative read-ahead and the purgeable cache are all reclaimable on
         demand and are what "free memory" means to a person looking at Activity Monitor. */
      const avail = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable');
      if (avail) return Math.round(avail * size / 1048576);
    } catch { /* vm_stat missing is not a thing, but do not die for it */ }
  }
  /* Windows reports available physical memory here, which already includes standby,
     so it is the right number rather than a fallback. */
  return Math.round(freemem() / 1048576);
}

export const totalMb = () => Math.round(totalmem() / 1048576);

/** Swap in use, where the platform will say. Windows will not, and reports null. */
export function swapMb() {
  if (IS_LINUX) {
    try {
      const t = readFileSync('/proc/meminfo', 'utf8');
      const g = k => Number(t.match(new RegExp(`${k}:\\s+(\\d+)`))?.[1] || 0) / 1024;
      const total = g('SwapTotal');
      return { used: Math.round(total - g('SwapFree')), total: Math.round(total) };
    } catch { return null; }
  }
  if (IS_MAC) {
    try {
      const s = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' });
      const mb = k => { const m = s.match(new RegExp(`${k} = ([\\d.]+)([MG])`)); return m ? Number(m[1]) * (m[2] === 'G' ? 1024 : 1) : 0; };
      return { used: Math.round(mb('used')), total: Math.round(mb('total')) };
    } catch { return null; }
  }
  return null;
}

/**
 * Fraction of the machine's CPU in use.
 *
 * `os.cpus()` counts the same jiffies since boot that /proc/stat does and is the
 * one place all three platforms agree, so a rate still needs two readings. Sampled
 * on a timer rather than per request: two open tabs polling would otherwise each
 * get a fraction of the other's window and both report nonsense.
 */
let cpuLoad = 0, lastCpu = null;
export function sampleCpu() {
  let idle = 0, total = 0;
  for (const c of cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  const was = lastCpu;
  lastCpu = { idle, total };
  if (was && total > was.total) cpuLoad = Math.max(0, Math.min(1, 1 - (idle - was.idle) / (total - was.total)));
  return cpuLoad;
}
export const cpuUsage = () => cpuLoad;

/* ---------------------------------------------------------------- browsers we started */

/**
 * Every browser this tool has running, whichever run started it.
 *
 * Chrome outlives whoever spawned it, so a recorder restarted or killed mid-render
 * leaves browsers resident at several hundred megabytes each with nothing that knows
 * to clean them up, and they pile up across restarts until the box has no memory
 * left. They are matched on the profile directory they were handed — a path no other
 * program on the machine will ever be given — never on the browser's name, because
 * killing every Chrome on someone's laptop is not an acceptable way to tidy up.
 *
 * Linux reads /proc directly because it is free and there is no subprocess to fail.
 * The other two have to ask, and get the same shape of answer back.
 */
export async function listBrowsers(mark) {
  if (IS_LINUX) return listLinux(mark);
  if (IS_MAC) return listMac(mark);
  return listWindows(mark);
}

async function listLinux(mark) {
  const found = [];
  for (const pid of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(pid)) continue;
    /* What the process *is*, before what it was asked to do. A command line is just
       text, and anything that so much as greps for that profile path carries it — a
       shell doing so is a process group leader and would be killed as one. The kernel
       truncates comm at 15 characters, hence the prefix. */
    const comm = await readFileSafe(`/proc/${pid}/comm`);
    if (!/^(chrome|chromium|headless_shell|brave|msedge)/i.test(comm)) continue;
    /* Chrome hands the kernel its whole command line as one argument rather than a
       NUL-separated list, so this has to match the blob, not the parts. */
    const argv = await readFileSafe(`/proc/${pid}/cmdline`);
    if (!argv.includes(mark)) continue;
    const stat = await readFileSafe(`/proc/${pid}/stat`);
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    /* Renderers inherit the same flag as the browser that spawned them; only the one
       whose process-group id is itself can be signalled as a group. */
    found.push({ pid: Number(pid), leader: f[2] === pid, rssMb: Number(f[21]) * 4096 / 1048576 });
  }
  return found;
}

const readFileSafe = p => readFile(p, 'utf8').catch(() => '');

async function listMac(mark) {
  /* -ww stops ps truncating the arguments at the terminal width, which is where the
     profile path we are matching on lives. */
  const { stdout } = await run('ps', ['-Ao', 'pid=,pgid=,rss=,args=', '-ww'], { maxBuffer: 32 << 20 }).catch(() => ({ stdout: '' }));
  const found = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m || !m[4].includes(mark)) continue;
    if (!/chrome|chromium|headless_shell|brave|msedge/i.test(m[4])) continue;
    found.push({ pid: Number(m[1]), leader: m[1] === m[2], rssMb: Number(m[3]) / 1024 });
  }
  return found;
}

async function listWindows(mark) {
  /* Windows has no process groups to signal, so the tree is reconstructed instead:
     a matched process whose parent is also matched is a renderer, and the ones left
     are the browsers to kill. */
  /* A double-quoted PowerShell string escapes with a backtick, not a backslash — so
     the Windows path in `mark` passes through untouched while the characters that
     would end the string, interpolate a variable, or act as -like wildcards do not. */
  const lit = mark.replace(/[`"$\[\]*?]/g, c => '`' + c);
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*${lit}*" } `
    + '| Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress';
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, maxBuffer: 32 << 20 })
    .catch(() => ({ stdout: '' }));
  let rows = [];
  try { rows = JSON.parse(stdout.trim() || '[]'); } catch { return []; }
  if (!Array.isArray(rows)) rows = [rows];
  const pids = new Set(rows.map(r => r.ProcessId));
  return rows.map(r => ({
    pid: r.ProcessId,
    leader: !pids.has(r.ParentProcessId),
    rssMb: Number(r.WorkingSetSize || 0) / 1048576,
  }));
}

/**
 * Kill a browser and everything it spawned.
 *
 * Chrome puts its renderers in child processes, and killing only the one we hold a
 * handle to leaves those behind holding the memory that was the reason for killing
 * it. Unix says that with a process group; Windows has taskkill /T.
 */
export function killTree(pid) {
  if (!pid) return false;
  try {
    if (IS_WIN) {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
    return true;
  } catch {
    return false; /* already gone, which is the outcome we wanted anyway */
  }
}

/** How a child has to be spawned for killTree to be able to reach its whole tree. */
export const spawnOpts = () => ({ stdio: 'ignore', detached: !IS_WIN, windowsHide: true });

export { tmpdir };
