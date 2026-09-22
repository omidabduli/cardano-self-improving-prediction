#!/usr/bin/env node
// Assemble the GitHub Pages artifact: the static site plus the public data record.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './store.mjs';

const out = path.join(ROOT, '_site');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'site'), out, { recursive: true });
if (fs.existsSync(path.join(ROOT, 'data'))) fs.cpSync(path.join(ROOT, 'data'), path.join(out, 'data'), { recursive: true });
fs.writeFileSync(path.join(out, '.nojekyll'), '');
let files = 0, bytes = 0;
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const s = fs.statSync(p); if (s.isDirectory()) walk(p); else { files++; bytes += s.size; } } };
walk(out);
console.log(`_site: ${files} files, ${(bytes / 1024).toFixed(0)} KiB`);
