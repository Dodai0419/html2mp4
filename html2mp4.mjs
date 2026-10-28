#!/usr/bin/env node
// html2mp4: render a code-drawn HTML animation to MP4, GIF or stills, frame by frame.
// Zero npm dependencies: drives the Chrome/Edge you already have over the DevTools protocol
// (Node's built-in WebSocket) and pipes JPEG frames into ffmpeg.
// Understands both page contracts:
//   - renderFrame: window.renderFrame(t) + window.__ready (+ window.DURATION)  (Moessif/code-video-showcase)
//   - timeline:    window.__timelines[id].seek(t) + [data-composition-id][data-duration|width|height]
//                  (HyperFrames pages, as made by ItsssssJack/claude-video-2)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = `usage: node html2mp4.mjs <page.html|url> -o out.mp4 [options]
  -o, --out <file>     .mp4 or .gif (required unless --still)
  --duration <s>       clip length (default: the page's DURATION / data-duration, else 3)
  --fps <n>            default 30
  --width/--height     viewport (default: data-width/height, else 1920x1080)
  --t0 <s> --speed <x> segment mode for renderFrame pages: ?seg=1&t0=&speed=&dur= is appended
  --still <t1,t2,...>  write JPEG stills instead of a video (next to --out, or in ./stills)
  --root <dir>         static root (default: the page's folder)
  --crf <n>            libx264 quality, default 18
  --quality <n>        JPEG frame quality, default 92
  --demo               render the bundled examples into out/`;

export function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('-')) { a._.push(k); continue; }
    const key = { '-o': 'out', '-h': 'help' }[k] || k.replace(/^--/, '');
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--') || key === 'help' || key === 'demo') a[key] = true;
    else { a[key] = v; i++; }
  }
  return a;
}

export function findBrowser(env = process.env, exists = fs.existsSync) {
  if (env.CHROME_EXE) return env.CHROME_EXE;
  const pf = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  const cands = process.platform === 'win32'
    ? pf.flatMap(p => [path.join(p, 'Google/Chrome/Application/chrome.exe'), path.join(p, 'Microsoft/Edge/Application/msedge.exe')])
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
         '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
          .map(n => spawnSync('which', [n], { encoding: 'utf8' }).stdout?.trim()).filter(Boolean);
  const hit = cands.find(c => exists(c));
  if (!hit) throw new Error('no Chrome/Edge/Chromium found; set CHROME_EXE');
  return hit;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.wasm': 'application/wasm' };

function serve(root) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (file !== root && !file.startsWith(root + path.sep)) return res.writeHead(403).end();  // stay inside root
    fs.readFile(file, (err, buf) => err ? res.writeHead(404).end()
      : res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }).end(buf));
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

async function launch(exe, w, h) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'html2mp4-'));
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1', `--window-size=${w},${h}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await new Promise((ok, fail) => {
    let log = '';
    const t = setTimeout(() => fail(new Error('browser did not start:\n' + log)), 30000);
    proc.stderr.on('data', d => { log += d; const m = log.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//); if (m) { clearTimeout(t); ok(m[1]); } });
    proc.on('exit', c => fail(new Error(`browser exited (${c}):\n` + log)));
  });
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let id = 0; const wait = new Map(); const errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) { const [ok, fail] = wait.get(m.id); wait.delete(m.id); m.error ? fail(new Error(m.error.message)) : ok(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((ok, fail) => { wait.set(++id, [ok, fail]); ws.send(JSON.stringify({ id, method, params })); });
  const close = async () => {
    const exited = proc.exitCode !== null ? Promise.resolve() : new Promise(r => proc.once('exit', r));
    send('Browser.close').catch(() => {});
    await Promise.race([exited, new Promise(r => setTimeout(r, 3000).unref())]);
    ws.close(); proc.kill();
    // the browser's helper processes can hold the profile for a moment; a leftover temp folder is harmless
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
  };
  return { send, close, errors };
}

export const DETECT = `(() => {
  if (window.__bootError) return { error: String(window.__bootError) };
  const root = document.querySelector('[data-composition-id]');
  if (window.__ready === true && typeof window.renderFrame === 'function')
    return { kind: 'renderFrame', duration: window.DURATION ?? null };
  if (document.readyState === 'complete' && window.__timelines && Object.keys(window.__timelines).length)
    return { kind: 'timeline', duration: root ? +root.dataset.duration || null : null,
             width: root ? +root.dataset.width || null : null, height: root ? +root.dataset.height || null : null };
  return null; })()`;

export const SEEK = {
  renderFrame: t => `Promise.resolve(window.renderFrame(${t}))`,
  timeline: t => `Object.values(window.__timelines).forEach(tl => tl.seek(${t}, false))`,
};

export function frameTimes(duration, fps) { return Array.from({ length: Math.round(duration * fps) }, (_, i) => i / fps); }

export function ffmpegArgs(out, fps, crf) {
  const input = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-'];
  return out.toLowerCase().endsWith('.gif')
    ? [...input, '-vf', `fps=${Math.min(fps, 15)},scale='min(800,iw)':-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`, out]
    : [...input, '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];
}

export async function render(page, o = {}) {
  const fps = +(o.fps ?? 30), q = +(o.quality ?? 92);
  const remote = /^https?:/.test(page);
  const root = path.resolve(o.root || (remote ? '.' : path.dirname(page)));
  const server = remote ? null : await serve(root);
  let url = remote ? page : `http://127.0.0.1:${server.address().port}/${path.relative(root, path.resolve(page)).split(path.sep).join('/')}`;
  if (!remote && (o.t0 !== undefined || o.speed !== undefined))
    url += (url.includes('?') ? '&' : '?') + `seg=1&t0=${o.t0 ?? 0}&speed=${o.speed ?? 1}&dur=${o.duration ?? 3}`;
  if (o.query) url += (url.includes('?') ? '&' : '?') + o.query;
  const b = await launch(o.browser || findBrowser(), +(o.width || 1920), +(o.height || 1080));
  try {
    const size = (w, h) => b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await b.send('Runtime.enable');
    await size(+(o.width || 1920), +(o.height || 1080));
    await b.send('Page.navigate', { url });
    let info = null; const until = Date.now() + +(o.timeout || 60000);
    while (!info) {
      info = (await b.send('Runtime.evaluate', { expression: DETECT, returnByValue: true })).result.value;
      if (info?.error) throw new Error('page boot error: ' + info.error);
      if (!info) {
        if (Date.now() > until) throw new Error('page never became ready: expose window.renderFrame + window.__ready, or window.__timelines');
        await new Promise(r => setTimeout(r, 50));
      }
    }
    const W = +(o.width || info.width || 1920), H = +(o.height || info.height || 1080);
    await size(W, H);
    await b.send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => 1)', awaitPromise: true });
    const duration = +(o.duration ?? info.duration ?? 3);
    const shoot = async t => {
      const r = await b.send('Runtime.evaluate', { expression: SEEK[info.kind](t), awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`seek(${t}) failed: ` + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return Buffer.from((await b.send('Page.captureScreenshot', { format: 'jpeg', quality: q, fromSurface: true })).data, 'base64');
    };
    if (o.still) {
      const dir = o.out ? path.dirname(path.resolve(o.out)) : path.resolve('stills');
      fs.mkdirSync(dir, { recursive: true });
      const files = [];
      for (const t of String(o.still).split(',').map(Number)) {
        const f = path.join(dir, `still-${t.toFixed(2).replace('.', '_')}.jpg`);
        fs.writeFileSync(f, await shoot(t)); files.push(f);
      }
      return { kind: info.kind, files, width: W, height: H, errors: b.errors };
    }
    if (!o.out) throw new Error('--out is required (or use --still)');
    fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
    const ff = spawn(o.ffmpeg || process.env.FFMPEG_EXE || 'ffmpeg', ffmpegArgs(o.out, fps, o.crf ?? 18), { stdio: ['pipe', 'ignore', 'pipe'] });
    let ffErr = ''; ff.stderr.on('data', d => ffErr += d);
    const done = new Promise((ok, fail) => { ff.on('error', fail); ff.on('close', c => c ? fail(new Error('ffmpeg failed: ' + ffErr)) : ok()); });
    const times = frameTimes(duration, fps);
    for (const t of times) { const buf = await shoot(t); if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r)); }
    ff.stdin.end(); await done;
    return { kind: info.kind, out: path.resolve(o.out), frames: times.length, fps, width: W, height: H, errors: b.errors };
  } finally { await b.close(); server?.close(); }
}

const DEMO = [
  ['examples/orbit.html', 'out/orbit.mp4', {}],
  ['examples/title-card.html', 'out/title-card.mp4', { query: 'first=Want%20a&keyword=launch%20film%3F' }],
  ['examples/orbit.html', 'out/orbit.gif', { fps: 15 }],
];

async function main(argv) {
  const a = parseArgs(argv);
  if (a.help || (!a._[0] && !a.demo)) { console.log(USAGE); return a.help ? 0 : 1; }
  const jobs = a.demo ? DEMO.map(([p, out, extra]) => [path.join(HERE, p), a.out ? path.join(a.out, path.basename(out)) : out, extra])
    : [[a._[0], a.out, {}]];
  for (const [page, out, extra] of jobs) {
    const t = performance.now();
    const r = await render(page, { ...a, out, ...extra });
    const s = ((performance.now() - t) / 1000).toFixed(1);
    if (r.files) r.files.forEach(f => console.log(f));
    else console.log(`${r.out}  ${r.frames} frames @${r.fps}fps  ${r.width}x${r.height}  [${r.kind}]  ${s}s`);
    if (r.errors.length) console.error('page errors:', r.errors.slice(0, 3).join('\n'));
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then(c => process.exit(c), e => { console.error('error:', e.message); process.exit(1); });
