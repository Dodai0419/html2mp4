// Reproduce the README benchmark: examples/orbit.html, 4 s at 30 fps, 1280x720 -> MP4, 3 runs.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../html2mp4.mjs';

const page = path.join(path.dirname(fileURLToPath(import.meta.url)), '../examples/orbit.html');
const runs = [];
for (let i = 0; i < 3; i++) {
  const t = performance.now();
  const r = await render(page, { out: path.join(os.tmpdir(), `html2mp4-bench-${i}.mp4`) });
  runs.push({ s: (performance.now() - t) / 1000, frames: r.frames });
}
console.log(runs.map(r => `${r.s.toFixed(1)} s (${(r.frames / r.s).toFixed(1)} fps)`).join(', '));
