// Frame renderer: drives a page exposing window.film.frame(t) in headless Chrome (software WebGL)
// and writes PNG frames.
//
//   node tools/render.mjs --page index.html --times 1,2.5,7 --scale 0.5 --out out/test
//   node tools/render.mjs --range 0:60:2 --scale 0.25 --out out/sheet --sheet 6
//   node tools/render.mjs --frames 0:1440 --part 0/2 --out out/frames
//   extra query string for the page: --q "pose=surf&yaw=30"
import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true'; args[k] = v; }
}
const page = args.page || 'index.html';
const scale = args.scale || '1';
const out = path.resolve(root, args.out || 'out/test');
const fps = parseFloat(args.fps || '24');
fs.mkdirSync(out, { recursive: true });

let jobs = []; // { name, t }
if (args.times) jobs = args.times.split(',').map((s, i) => ({ t: parseFloat(s), name: `t_${parseFloat(s).toFixed(3).padStart(7, '0')}` }));
else if (args.range) { const [a, b, st] = args.range.split(':').map(parseFloat); for (let t = a, i = 0; t < b - 1e-6; t += st, i++) jobs.push({ t, name: `t_${t.toFixed(3).padStart(7, '0')}` }); }
else if (args.frames) { const [a, b] = args.frames.split(':').map((x) => parseInt(x)); for (let i = a; i < b; i++) jobs.push({ t: i / fps, name: `f_${String(i).padStart(5, '0')}`, i }); }
else jobs = [{ t: parseFloat(args.t || '0'), name: args.name || 'frame' }];
if (args.part) { const [k, n] = args.part.split('/').map((x) => parseInt(x)); jobs = jobs.filter((j, idx) => (j.i ?? idx) % n === k); }
if (args.skip === 'true') jobs = jobs.filter((j) => !fs.existsSync(path.join(out, j.name + '.png')));

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const srv = http.createServer((q, s) => {
  const p = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  fs.readFile(p, (e, d) => {
    if (e) { s.writeHead(404); s.end(); return; }
    s.writeHead(200, { 'content-type': mime[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    s.end(d);
  });
});
await new Promise((r) => srv.listen(0, r));
const port = srv.address().port;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/local/bin/google-chrome', headless: 'new', protocolTimeout: 0,
  args: ['--no-sandbox', '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl', '--disable-background-timer-throttling', '--js-flags=--max-old-space-size=4096'],
});
let failed = false;
try {
  const pg = await browser.newPage();
  const quiet = args.quiet === 'true';
  pg.on('console', (m) => { const t = m.text(); if (/GL Driver Message|GPU stall/.test(t)) return; if (!quiet || m.type() === 'error' || /error|warn/i.test(t)) console.log('[page]', t.slice(0, 600)); });
  pg.on('pageerror', (e) => { console.log('[pageerror]', e.message); });
  const url = `http://localhost:${port}/${page}?scale=${scale}${args.q ? '&' + args.q : ''}`;
  await pg.goto(url);
  await pg.waitForFunction('window.ready || window.bootError', { timeout: 180000 });
  const be = await pg.evaluate('window.bootError');
  if (be) throw new Error('boot failed: ' + be);
  const t0 = Date.now();
  for (let n = 0; n < jobs.length; n++) {
    const j = jobs[n];
    const data = await pg.evaluate((t) => window.film.frame(t), j.t);
    fs.writeFileSync(path.join(out, j.name + '.png'), Buffer.from(data.split(',')[1], 'base64'));
    if (!quiet || n % 24 === 0 || n === jobs.length - 1) {
      const el = (Date.now() - t0) / 1000;
      console.log(`${j.name} t=${j.t.toFixed(3)}  [${n + 1}/${jobs.length}]  ${(el / (n + 1)).toFixed(2)} s/frame`);
    }
  }
  if (args.info === 'true') console.log(JSON.stringify(await pg.evaluate('window.film.info()')));
} catch (e) {
  failed = true; console.error('RENDER ERROR', e.message);
} finally {
  await browser.close(); srv.close();
}
if (!failed && args.sheet) {
  const cols = parseInt(args.sheet); const rows = Math.ceil(jobs.length / cols);
  const tw = parseInt(args.tw || '480');
  const sheet = path.join(out, 'sheet.jpg');
  // glob keeps the frame names (which sort chronologically)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-pattern_type', 'glob', '-i', path.join(out, (args.frames ? 'f_' : 't_') + '*.png'), '-vf', `scale=${tw}:-1,tile=${cols}x${rows}:padding=4:color=0x202020`, '-frames:v', '1', '-q:v', '3', sheet]);
  console.log('sheet', sheet);
}
process.exit(failed ? 1 : 0);
