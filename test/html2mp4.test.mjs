import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, frameTimes, ffmpegArgs, findBrowser, render } from '../html2mp4.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'h2m-test-'));

// mean RGB of frame n, read back from the encoded video with ffmpeg
function pixel(video, n) {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', video, '-vf', `select=eq(n\\,${n}),scale=1:1`, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
  assert.equal(r.status, 0, String(r.stderr));
  return [...r.stdout.subarray(0, 3)];
}
function frames(video) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
    'stream=nb_read_frames,width,height', '-of', 'csv=p=0', video], { encoding: 'utf8' });
  const [w, h, n] = r.stdout.trim().split(',').map(Number);
  return { w, h, n };
}
const near = (got, want) => got.every((v, i) => Math.abs(v - want[i]) < 40);

test('parseArgs reads flags, values and the page', () => {
  assert.deepEqual(parseArgs(['p.html', '-o', 'x.mp4', '--fps', '24', '--demo']), { _: ['p.html'], out: 'x.mp4', fps: '24', demo: true });
});

test('frameTimes is i/fps, like render-segment.mjs', () => {
  assert.deepEqual(frameTimes(0.5, 4), [0, 0.25]);
  assert.equal(frameTimes(3, 30).length, 90);
});

test('ffmpegArgs picks x264 for mp4 and a palette for gif', () => {
  assert.ok(ffmpegArgs('a.mp4', 30, 18).includes('libx264'));
  assert.ok(ffmpegArgs('a.GIF', 30, 18).join(' ').includes('palettegen'));
});

test('findBrowser honours CHROME_EXE and fails clearly when nothing exists', () => {
  assert.equal(findBrowser({ CHROME_EXE: '/x/chrome' }), '/x/chrome');
  if (process.platform !== 'linux') assert.throws(() => findBrowser({}, () => false), /CHROME_EXE/);
});

test('renderFrame contract: every frame is drawn from its own t', async () => {
  const out = path.join(tmp(), 'rf.mp4');
  const r = await render(path.join(HERE, 'fixtures/render-frame.html'), { out, fps: 10, width: 320, height: 180 });
  assert.equal(r.kind, 'renderFrame');
  assert.deepEqual(frames(out), { w: 320, h: 180, n: 10 });       // DURATION = 1 s from the page
  assert.ok(near(pixel(out, 0), [255, 0, 0]), 'frame 0 red: ' + pixel(out, 0));
  assert.ok(near(pixel(out, 9), [0, 0, 255]), 'frame 9 blue: ' + pixel(out, 9));
});

test('timeline contract: size and duration come from data-* attributes', async () => {
  const out = path.join(tmp(), 'tl.mp4');
  const r = await render(path.join(HERE, 'fixtures/timeline.html'), { out, fps: 10 });
  assert.equal(r.kind, 'timeline');
  assert.deepEqual(frames(out), { w: 400, h: 240, n: 20 });
  assert.ok(near(pixel(out, 0), [0, 0, 0]), 'frame 0 black: ' + pixel(out, 0));
  assert.ok(near(pixel(out, 19), [255, 255, 255]), 'last frame white: ' + pixel(out, 19));
});

test('stills and gif output', async () => {
  const dir = tmp();
  const s = await render(path.join(HERE, 'fixtures/render-frame.html'), { out: path.join(dir, 'x.mp4'), still: '0,0.9', width: 320, height: 180 });
  assert.deepEqual(s.files.map(f => path.basename(f)), ['still-0_00.jpg', 'still-0_90.jpg']);
  const gif = path.join(dir, 'a.gif');
  await render(path.join(HERE, 'fixtures/timeline.html'), { out: gif, fps: 10 });
  assert.equal(fs.readFileSync(gif).subarray(0, 3).toString(), 'GIF');
});

test('a page boot error is reported, not rendered', async () => {
  await assert.rejects(render(path.join(HERE, 'fixtures/boot-error.html'), { out: path.join(tmp(), 'e.mp4') }), /boot error: no data/);
});

test('segment mode appends ?seg=1&t0=&speed=&dur= like render-segment.mjs', async () => {
  const dir = tmp();
  const s = await render(path.join(HERE, 'fixtures/segment.html'), { out: path.join(dir, 'x.mp4'), still: '0', t0: 0.6, speed: 2, duration: 3 });
  // the fixture paints green only when it sees exactly seg=1, t0=0.6, speed=2, dur=3
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', s.files[0], '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
  assert.ok(near([...r.stdout.subarray(0, 3)], [0, 255, 0]), 'segment params reached the page');
});

test('the bundled examples render with no page errors', async () => {
  const out = path.join(tmp(), 'card.mp4');
  const r = await render(path.join(HERE, '../examples/title-card.html'), { out, fps: 10 });
  assert.equal(r.kind, 'renderFrame');
  assert.deepEqual(frames(out), { w: 1920, h: 1080, n: 20 });
  assert.deepEqual(r.errors, []);
  const o = await render(path.join(HERE, '../examples/orbit.html'), { out: path.join(tmp(), 'o.mp4'), fps: 5 });
  assert.equal(o.kind, 'timeline');
  assert.deepEqual(frames(o.out), { w: 1280, h: 720, n: 20 });
});
