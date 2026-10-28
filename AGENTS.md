# html2mp4 (for Codex and other agents)


Turns a page that draws its frames from a time `t` into a video. No npm install.

## When to use
- The user asks for a video, GIF, animated title, motion graphic or "make it move".
- You wrote an HTML animation and need an MP4/GIF file or a few stills to show the user.

## How
1. Write the page so it draws the whole frame from `t` alone (no `Date.now()`, no `Math.random()` in the draw). Use ONE contract:
   - `window.DURATION = <s>; window.renderFrame = t => {...}; window.__ready = true;`
   - or `<div data-composition-id="main" data-duration="4" data-width="1280" data-height="720">` plus `window.__timelines = { main: <anything with seek(t)> }`.
2. Check stills first (cheap): `node html2mp4.mjs page.html --still 0.2,1,2.5 -o stills/x`, then look at the JPEGs.
3. Render: `node html2mp4.mjs page.html -o out.mp4` (or `-o out.gif`). Options: `--fps 30`, `--duration 6`, `--width 1080 --height 1920`.
4. Report the output path, frame count and size printed by the command.

Requirements: Node 22+, ffmpeg on PATH (or `FFMPEG_EXE`), Chrome/Edge/Chromium (or `CHROME_EXE`).
If the command says "page never became ready", the page did not set `__ready` or `__timelines`; if it prints "page errors", fix the page script.
