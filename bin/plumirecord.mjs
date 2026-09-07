#!/usr/bin/env node
/* The `plumirecord` command. The work is all in src/recorder.mjs, which stays
   importable as a library — this only exists so the CLI has a name. */
import { cli } from '../src/recorder.mjs';

cli().catch(err => {
  console.error('error: ' + err.message);
  process.exit(1);
});
