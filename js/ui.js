// Builds the parameter panel from SCHEMA. Calls onChange(key, value, final)
// while dragging (final=false) and on release (final=true).

import { SCHEMA, PRESETS, defaultParams } from './params.js?v=20261026172943';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compassName = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

export function buildPanel(root, params, onChange) {
  const controls = {};
  root.innerHTML = '';

  for (const group of SCHEMA) {
    const det = document.createElement('details');
    det.className = 'group';
    det.open = group.open;
    const sum = document.createElement('summary');
    sum.textContent = group.group;
    det.appendChild(sum);

    for (const def of group.params) {
      const row = document.createElement('div');
      row.className = 'row';
      if (def.help) row.title = def.help;
      const label = document.createElement('label');
      label.textContent = def.label;
      label.htmlFor = `p-${def.key}`;

      if (def.type === 'bool') {
        row.classList.add('row-bool');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = `p-${def.key}`;
        input.checked = params[def.key];
        input.addEventListener('change', () => onChange(def.key, input.checked, true));
        row.append(input, label);
        controls[def.key] = { set: (v) => (input.checked = v) };
      } else if (def.type === 'select') {
        const sel = document.createElement('select');
        sel.id = `p-${def.key}`;
        for (const [k, v] of Object.entries(def.options)) {
          const o = document.createElement('option');
          o.value = k;
          o.textContent = v;
          sel.appendChild(o);
        }
        sel.value = params[def.key];
        sel.addEventListener('change', () => onChange(def.key, sel.value, true));
        row.classList.add('row-select');
        row.append(label, sel);
        controls[def.key] = { set: (v) => (sel.value = v) };
      } else if (def.type === 'compass') {
        row.classList.add('row-compass');
        const c = buildCompass(params[def.key], (v, fin) => onChange(def.key, v, fin));
        row.append(c.el);
        controls[def.key] = c;
      } else {
        const input = document.createElement('input');
        input.type = 'range';
        input.id = `p-${def.key}`;
        input.min = def.min;
        input.max = def.max;
        input.step = def.step;
        input.value = params[def.key];
        const out = document.createElement('output');
        const fmt = (v) => `${(+v).toFixed(stepDecimals(def.step))}${def.unit ? ' ' + def.unit : ''}`;
        out.textContent = fmt(params[def.key]);
        input.addEventListener('input', () => {
          out.textContent = fmt(input.value);
          onChange(def.key, +input.value, false);
        });
        input.addEventListener('change', () => onChange(def.key, +input.value, true));
        const head = document.createElement('div');
        head.className = 'row-head';
        head.append(label, out);
        row.append(head, input);
        controls[def.key] = {
          set: (v) => {
            input.value = v;
            out.textContent = fmt(v);
          },
        };
      }
      det.appendChild(row);
    }
    root.appendChild(det);
  }
  return controls;
}

function stepDecimals(step) {
  const s = String(step);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

// Draggable compass dial: the arrow shows where the wind comes FROM.
function buildCompass(value, onChange) {
  const el = document.createElement('div');
  el.className = 'compass';
  el.innerHTML = `
    <svg viewBox="-60 -60 120 120" aria-label="Wind direction dial" role="slider" tabindex="0">
      <circle r="52" class="dial"/>
      ${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
        const r = (a * Math.PI) / 180;
        const big = a % 90 === 0;
        return `<line x1="${Math.sin(r) * (big ? 40 : 45)}" y1="${-Math.cos(r) * (big ? 40 : 45)}" x2="${Math.sin(r) * 52}" y2="${-Math.cos(r) * 52}" class="tick"/>`;
      }).join('')}
      <text y="-27" class="card">N</text><text x="29" y="4" class="card">E</text>
      <text y="35" class="card">S</text><text x="-29" y="4" class="card">W</text>
      <g class="needle"><line y1="-44" y2="18" /><path d="M0,30 L-7,14 L7,14 Z"/><circle cy="-44" r="6" class="grip"/></g>
    </svg>
    <div class="compass-info">
      <div class="compass-label">Wind from</div>
      <div class="compass-value"></div>
      <div class="compass-sub">drag the dial · arrow shows where air flows</div>
    </div>`;
  const svg = el.querySelector('svg');
  const needle = el.querySelector('.needle');
  const val = el.querySelector('.compass-value');
  let current = value;
  const set = (v) => {
    current = Math.round(((v % 360) + 360) % 360);
    needle.setAttribute('transform', `rotate(${current})`);
    val.textContent = `${current}° ${compassName(current)}`;
  };
  set(value);
  let dragging = false;
  const fromEvent = (e) => {
    const r = svg.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2);
    const y = e.clientY - (r.top + r.height / 2);
    return (Math.atan2(x, -y) * 180) / Math.PI;
  };
  svg.addEventListener('pointerdown', (e) => {
    dragging = true;
    svg.setPointerCapture(e.pointerId);
    set(fromEvent(e));
    onChange(current, false);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    set(fromEvent(e));
    onChange(current, false);
  });
  svg.addEventListener('pointerup', () => {
    dragging = false;
    onChange(current, true);
  });
  svg.addEventListener('keydown', (e) => {
    const d = { ArrowLeft: -5, ArrowRight: 5, ArrowUp: 5, ArrowDown: -5 }[e.key];
    if (d) {
      e.preventDefault();
      set(current + d);
      onChange(current, true);
    }
  });
  return { el, set };
}

export function buildPresetSelect(sel, onPick) {
  sel.innerHTML = '<option value="">Presets…</option>';
  for (const name of Object.keys(PRESETS)) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    if (!sel.value) return;
    onPick({ ...defaultParams(), ...PRESETS[sel.value] });
    sel.value = '';
  });
}
