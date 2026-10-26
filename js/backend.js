// Client for server.js — Blender and Unreal pipelines.
// When the page is opened without the server, these features are disabled
// and the Three.js explorer works on its own.

export const state = { online: false, lastJob: null };

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
  return json;
}

export async function init({ onStatus, onOffline }) {
  try {
    const st = await api('/api/status');
    state.online = true;
    onStatus(st);
  } catch {
    onOffline(await findLocalServer());
  }
}

// On the hosted site, look for the local server (started with ./start) so we
// can offer to open the local app, where Blender and Unreal work.
async function findLocalServer() {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return null;
  for (let port = 8420; port <= 8425; port++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 800);
      const res = await fetch(`http://localhost:${port}/api/status`, { signal: ctl.signal });
      clearTimeout(timer);
      if (res.ok) return `http://localhost:${port}/`;
    } catch { /* not running on this port */ }
  }
  return null;
}

export const blenderBuild = (payload) => api('/api/blender/build', payload);
export const blenderOpen = (payload) => api('/api/blender/open', payload);
export const unrealSend = (payload) => api('/api/unreal/send', payload);

export function watch(id, onUpdate) {
  return new Promise((resolve) => {
    const tick = async () => {
      const st = await api(`/api/jobs/${id}`).catch((e) => ({ state: 'failed', log: e.message }));
      onUpdate(st);
      if (st.state === 'running' || st.state === 'queued') setTimeout(tick, 1000);
      else {
        if (st.state === 'done') state.lastJob = st;
        resolve({ ...st, id });
      }
    };
    tick();
  });
}

export function watchUnreal(id, onUpdate) {
  const tick = async () => {
    const st = await api(`/api/jobs/${id}`).catch((e) => ({ state: 'failed', log: e.message }));
    onUpdate(st);
    // Keep polling after the first screenshot so later, better ones appear.
    if (st.state !== 'failed' && st.state !== 'exited') setTimeout(tick, 2000);
  };
  tick();
}
