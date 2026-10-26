#!/usr/bin/env node
// Live Oak Explorer local server (no dependencies).
//   node server.js            -> http://localhost:8420
//
// Serves the Three.js app and drives the offline renderers:
//   POST /api/blender/build   grow skeleton -> Blender (render still and/or export GLB/FBX/.blend)
//   POST /api/blender/open    open the oak scene in the Blender GUI
//   POST /api/unreal/send     import Blender's FBX into the UE5 project and build a level
//   GET  /api/jobs/:id        job status, log tail and output URLs
//
// Paths can be overridden with BLENDER_PATH, UE_ROOT and PORT.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8420);
const JOBS_DIR = path.join(ROOT, 'output', 'jobs');
const UE_PROJECT = path.join(ROOT, 'unreal', 'OakExplorer', 'OakExplorer.uproject');
fs.mkdirSync(JOBS_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.hdr': 'application/octet-stream', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wasm': 'application/wasm',
  '.fbx': 'application/octet-stream', '.blend': 'application/octet-stream', '.svg': 'image/svg+xml', '.txt': 'text/plain',
};

// ------------------------------------------------------- tool discovery ---

function findBlender() {
  const cands = [process.env.BLENDER_PATH, '/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender', '/snap/bin/blender'];
  for (const c of cands) {
    if (c && fs.existsSync(c)) {
      let version = '?';
      try {
        version = execFileSync(c, ['--version'], { encoding: 'utf8', timeout: 30000 }).split('\n')[0].replace('Blender ', '').trim();
      } catch { /* keep ? */ }
      return { path: c, version };
    }
  }
  return null;
}

function findUnreal() {
  const roots = [];
  if (process.env.UE_ROOT) roots.push(process.env.UE_ROOT);
  const scan = (dir) => {
    try {
      for (const d of fs.readdirSync(dir)) if (/^UE_\d/.test(d)) roots.push(path.join(dir, d));
    } catch { /* missing */ }
  };
  scan('/Users/Shared/Epic Games');
  try {
    for (const v of fs.readdirSync('/Volumes')) {
      scan(path.join('/Volumes', v, 'UnrealEngine'));
      scan(path.join('/Volumes', v, 'Epic Games'));
    }
  } catch { /* not macOS */ }
  roots.sort().reverse(); // newest version first
  for (const r of roots) {
    const exe = path.join(r, 'Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor');
    if (fs.existsSync(exe)) {
      let version = path.basename(r).replace('UE_', '');
      try {
        const b = JSON.parse(fs.readFileSync(path.join(r, 'Engine/Build/Build.version'), 'utf8'));
        version = `${b.MajorVersion}.${b.MinorVersion}.${b.PatchVersion}`;
      } catch { /* keep folder name */ }
      return { root: r, exe, version };
    }
  }
  return null;
}

const tools = { blender: findBlender(), unreal: findUnreal() };
console.log('Blender:', tools.blender ? `${tools.blender.version} (${tools.blender.path})` : 'not found');
console.log('Unreal :', tools.unreal ? `${tools.unreal.version} (${tools.unreal.root})` : 'not found');

// ----------------------------------------------------------------- jobs ---

const jobs = new Map();
const newId = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6);
const jobUrl = (id, f) => `/output/jobs/${id}/${f}`;

function makeJob(type) {
  const id = newId();
  const dir = path.join(JOBS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const job = { id, type, dir, state: 'queued', phase: '', log: '', outputs: {}, started: Date.now() };
  jobs.set(id, job);
  return job;
}

function appendLog(job, text) {
  job.log = (job.log + text).slice(-20000);
}

async function writePayload(job, body) {
  const { mossTexture, ...rest } = body;
  if (mossTexture?.startsWith('data:image/png;base64,')) {
    await fsp.writeFile(path.join(job.dir, 'moss.png'), Buffer.from(mossTexture.split(',')[1], 'base64'));
  }
  rest.assets = path.join(ROOT, 'assets');
  rest.jobDir = job.dir;
  await fsp.writeFile(path.join(job.dir, 'job.json'), JSON.stringify(rest));
}

function runBlender(job, gui) {
  const script = path.join(ROOT, 'blender', 'build_oak.py');
  const args = gui
    ? ['--python', script, '--', job.dir, '--gui']
    : ['--background', '--factory-startup', '--python', script, '--', job.dir];
  const child = spawn(tools.blender.path, args, { cwd: ROOT, detached: gui, stdio: gui ? 'ignore' : 'pipe' });
  child.on('error', (err) => {
    job.state = 'failed';
    job.phase = `could not start Blender: ${err.message}`;
    appendLog(job, `\n${job.phase}\n`);
  });
  job.state = 'running';
  if (gui) {
    child.unref();
    job.state = 'done';
    job.phase = 'opened in Blender';
    return;
  }
  const onData = (d) => {
    const s = d.toString();
    for (const line of s.split('\n')) {
      const m = line.match(/^OAK: (.*)/);
      if (m) job.phase = m[1];
    }
    // Keep the log readable: drop Cycles' per-tile spam.
    appendLog(job, s.split('\n').filter((l) => !/^Fra:\d+ .*Sample \d+\/\d+$/.test(l.trim()) || /Sample (\d+)\/\1/.test(l)).join('\n'));
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('close', (code) => {
    for (const [k, f] of Object.entries({ render: 'render.png', glb: 'oak.glb', fbx: 'oak.fbx', blend: 'oak.blend' })) {
      if (fs.existsSync(path.join(job.dir, f))) job.outputs[k] = jobUrl(job.id, f);
    }
    job.state = code === 0 && fs.existsSync(path.join(job.dir, 'done.txt')) ? 'done' : 'failed';
    job.phase = job.state === 'done' ? 'finished' : `exited with code ${code}`;
  });
}

function runUnreal(job, srcJob, body) {
  const ue = tools.unreal;
  const ueJob = {
    fbx: path.join(srcJob.dir, 'oak.fbx'),
    srcDir: srcJob.dir,
    assets: path.join(ROOT, 'assets'),
    jobDir: job.dir,
    jobId: srcJob.id.replace(/[^A-Za-z0-9]/g, '_'),
    camera: body.camera,
    sun: body.sun,
    params: body.params,
    ...(() => {
      try {
        const sk = JSON.parse(fs.readFileSync(path.join(srcJob.dir, 'job.json'), 'utf8')).skeleton;
        return { pond: sk.pond || null, canopyR: sk.shear?.spread || 12 };
      } catch {
        return { pond: null, canopyR: 12 };
      }
    })(),
  };
  fs.writeFileSync(path.join(job.dir, 'unreal_job.json'), JSON.stringify(ueJob, null, 2));
  const script = path.join(ROOT, 'unreal', 'scripts', 'setup_oak_scene.py');
  const shotDir = path.join(path.dirname(UE_PROJECT), 'Saved', 'Screenshots');
  const launchTime = Date.now();
  fs.mkdirSync(path.join(path.dirname(UE_PROJECT), 'Content'), { recursive: true });
  // Content/Python/init_unreal.py picks these up and builds the scene; unlike
  // -ExecutePythonScript this leaves the editor open afterwards.
  const child = spawn(ue.exe, [UE_PROJECT, '-log'], {
    cwd: path.dirname(UE_PROJECT),
    env: { ...process.env, OAK_UE_JOB: path.join(job.dir, 'unreal_job.json'), OAK_UE_SCRIPT: script },
    stdio: 'pipe',
  });
  child.on('error', (err) => {
    job.state = 'failed';
    job.phase = `could not start Unreal Editor: ${err.message}`;
    appendLog(job, `\n${job.phase}\n`);
  });
  job.state = 'running';
  job.phase = 'starting editor';
  const onData = (d) => {
    const s = d.toString();
    for (const line of s.split('\n')) {
      const m = line.match(/OAK: (.*)/);
      if (m) job.phase = m[1].trim();
    }
    appendLog(job, s.split('\n').filter((l) => /OAK:|Error|error:|LogPython/.test(l)).map((l) => l.replace(/^\[.*?\]\[.*?\]/, '')).join('\n') + '\n');
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  // HighResShot writes asynchronously, and the script takes a second shot
  // once shaders have compiled; always publish the newest one.
  // On macOS the editor logs to ~/Library/Logs rather than stdout; mirror it.
  const ueLog = path.join(process.env.HOME || '', 'Library/Logs/Unreal Engine/OakExplorerEditor/OakExplorer.log');
  let lastShot = 0;
  const poll = setInterval(() => {
    try {
      const st = fs.statSync(ueLog);
      if (st.mtimeMs > launchTime) {
        const lines = fs.readFileSync(ueLog, 'utf8').split('\n').filter((l) => /OAK:|Error:|Fatal/.test(l));
        const oak = [...new Set(lines.map((l) => l.replace(/^\[.*?\]\[.*?\]/, '').trim()))];
        job.log = oak.join('\n');
        const last = oak.filter((l) => l.includes('OAK:')).pop();
        if (last && !job.screenshot) job.phase = last.replace(/.*OAK: /, '');
      }
    } catch { /* log not there yet */ }
    const found = findNewest(shotDir, Math.max(launchTime, lastShot));
    if (found) {
      lastShot = fs.statSync(found).mtimeMs;
      const name = `unreal-${Math.round(lastShot)}.png`;
      fs.copyFileSync(found, path.join(job.dir, name));
      job.screenshot = jobUrl(job.id, name);
      job.phase = 'screenshot saved — the editor stays open for exploring';
    }
    if (Date.now() - launchTime > 30 * 60 * 1000) clearInterval(poll);
  }, 2000);
  child.on('close', (code) => {
    clearInterval(poll);
    job.state = 'exited';
    job.phase = `editor closed (code ${code})`;
  });
}

function findNewest(dir, since) {
  let best = null;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.png$/i.test(e.name)) {
        const st = fs.statSync(p);
        if (st.mtimeMs > since && st.size > 0 && (!best || st.mtimeMs > best.t)) best = { p, t: st.mtimeMs };
      }
    }
  };
  walk(dir);
  return best && Date.now() - best.t > 1500 ? best.p : null; // let the write finish
}

// --------------------------------------------------------------- server ---

async function readBody(req) {
  // Snapshots can be several MB of base64.
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const PAGES_ORIGIN = 'https://metaphorz.github.io';

async function api(req, res, url) {
  // Chrome's Private Network Access: a public page may only reach localhost
  // after a preflight that the server explicitly allows.
  if (req.method === 'OPTIONS' && url.pathname === '/api/status' && req.headers.origin === PAGES_ORIGIN) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': PAGES_ORIGIN,
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }
  if (url.pathname === '/api/status') {
    // The hosted (GitHub Pages) copy may ask whether a local server is
    // running so it can offer a link to it; only this read-only endpoint
    // answers cross-origin.
    if (req.headers.origin === PAGES_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', PAGES_ORIGIN);
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    return send(res, 200, {
      blender: tools.blender && { version: tools.blender.version },
      unreal: tools.unreal && { version: tools.unreal.version },
    });
  }
  const jm = url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
  if (jm) {
    const j = jobs.get(jm[1]);
    if (!j) return send(res, 404, { error: 'no such job' });
    const { dir, ...pub } = j;
    return send(res, 200, pub);
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });

  if (url.pathname === '/api/snapshot') {
    // Saves a PNG rendered in the browser into output/gallery/.
    const body = await readBody(req);
    const name = String(body.name || 'snapshot').replace(/[^\w.-]+/g, '_').slice(0, 80);
    if (!String(body.png || '').startsWith('data:image/png;base64,')) return send(res, 400, { error: 'png data URL required' });
    const dir = path.join(ROOT, 'output', 'gallery');
    fs.mkdirSync(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${name}.png`), Buffer.from(body.png.split(',')[1], 'base64'));
    return send(res, 200, { path: `/output/gallery/${name}.png` });
  }
  if (url.pathname === '/api/blender/build' || url.pathname === '/api/blender/open') {
    if (!tools.blender) return send(res, 503, { error: 'Blender not found. Set BLENDER_PATH.' });
    const body = await readBody(req);
    const gui = url.pathname.endsWith('/open');
    const job = makeJob(gui ? 'blender-gui' : 'blender');
    await writePayload(job, body);
    runBlender(job, gui);
    return send(res, 200, { id: job.id });
  }
  if (url.pathname === '/api/unreal/send') {
    if (!tools.unreal) return send(res, 503, { error: 'Unreal Engine not found. Set UE_ROOT.' });
    const body = await readBody(req);
    let src = jobs.get(body.jobId);
    // Jobs survive server restarts on disk.
    if (!src && /^[\w-]+$/.test(body.jobId || '') && fs.existsSync(path.join(JOBS_DIR, body.jobId))) {
      src = { id: body.jobId, dir: path.join(JOBS_DIR, body.jobId) };
    }
    if (!src || !fs.existsSync(path.join(src.dir, 'oak.fbx'))) return send(res, 400, { error: 'Build the tree in Blender first (no FBX for that job).' });
    const job = makeJob('unreal');
    runUnreal(job, src, body);
    return send(res, 200, { id: job.id });
  }
  return send(res, 404, { error: 'unknown endpoint' });
}

process.on('uncaughtException', (err) => console.error('uncaught:', err));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    const st = await fsp.stat(file).catch(() => null);
    if (!st || !st.isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': rel.startsWith('/output/') ? 'no-store' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`Live Oak Explorer → http://localhost:${PORT}`));
