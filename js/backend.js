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
    onOffline();
  }
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
    if (!st.screenshot && st.state !== 'failed' && st.state !== 'exited') setTimeout(tick, 2000);
  };
  tick();
}
