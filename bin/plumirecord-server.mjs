#!/usr/bin/env node
/**
 * The `plumirecord-server` command.
 *
 * The server reads its port and address from the environment so that a process
 * manager can set them without a wrapper. Accepting them as flags too is purely so
 * that a person does not have to know that, which is why they are translated into
 * the environment here rather than threaded through the server itself.
 */
const args = process.argv.slice(2);
const take = (...names) => {
  const i = args.findIndex(a => names.includes(a));
  return i === -1 ? null : args[i + 1];
};

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
PlumiRecord's web UI — drop a design bundle in a browser, get an mp4 back.

  plumirecord-server [--port 3005] [--host 127.0.0.1] [--data <dir>]

  --port <n>     Port to listen on (default 3005, or $PORT).
  --host <addr>  Address to bind. Defaults to 127.0.0.1, which is reachable only
                 from this machine. Pass 0.0.0.0 to serve it to your network —
                 there is no login, so only do that behind one.
  --data <dir>   Where uploads and renders are kept (default: your OS's app-data
                 directory, or $PLUMIRECORD_DATA).
`.trim());
  process.exit(0);
}

const port = take('--port', '-p');
const host = take('--host');
const data = take('--data');
if (port) process.env.PORT = port;
if (host) process.env.PLUMIRECORD_HOST = host;
if (data) process.env.PLUMIRECORD_DATA = data;

await import('../src/server.mjs');
