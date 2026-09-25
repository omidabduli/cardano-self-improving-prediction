#!/usr/bin/env node
// Assemble the GitHub Pages artifact: the static site plus the public data record.
//
// GitHub Pages lets browsers keep every file for 10 minutes, so after a deploy visitors could
// run old code for a while (or a mix of old and new modules). Every stylesheet, script and
// module import therefore gets ?v=<hash of the site's code>: a new deploy means new URLs,
// which the browser fetches fresh. Only index.html itself can still be up to 10 minutes old.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './store.mjs';

const out = path.join(ROOT, '_site');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'site'), out, { recursive: true });
if (fs.existsSync(path.join(ROOT, 'data'))) fs.cpSync(path.join(ROOT, 'data'), path.join(out, 'data'), { recursive: true });
fs.writeFileSync(path.join(out, '.nojekyll'), '');

const walk = (d, list = []) => {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p, list); else list.push(p);
  }
  return list;
};

// version = hash of the code (not the data, which changes every run)
const code = walk(path.join(ROOT, 'site')).filter((p) => /\.(js|css|html)$/.test(p)).sort();
const h = crypto.createHash('sha256');
for (const p of code) h.update(path.relative(ROOT, p)).update(fs.readFileSync(p));
const v = h.digest('hex').slice(0, 10);

let stamped = 0;
for (const p of walk(out).filter((p) => !p.includes(`${path.sep}data${path.sep}`))) {
  const before = fs.readFileSync(p, 'utf8');
  let after = before;
  if (p.endsWith('.html')) after = before.replace(/(href|src)="(assets\/[^"?]+\.(?:css|js))"/g, `$1="$2?v=${v}"`);
  // relative module imports: import ... from './x.js' / '../core/x.js', and import('./x.js')
  if (p.endsWith('.js')) after = before.replace(/((?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"?]+\.js)\2/g, `$1$2$3?v=${v}$2`);
  if (after !== before) { fs.writeFileSync(p, after); stamped++; }
}

const files = walk(out);
const bytes = files.reduce((a, p) => a + fs.statSync(p).size, 0);
console.log(`_site: ${files.length} files, ${(bytes / 1024).toFixed(0)} KiB, code version ${v} (${stamped} files stamped)`);
