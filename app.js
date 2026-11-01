// Pack Grader front end. Talks to the FastAPI server on the laptop.

const FEATURE_TIMES = [0.02, 0.04, 0.06, 0.1, 0.14, 0.2, 0.3, 0.4, 0.6, 0.8, 1,
  1.5, 2, 3, 4, 6, 8, 12, 16, 22, 30];

// Served by the Python server itself (local run): talk to the same origin.
// Served from GitHub Pages: talk to the laptop server on port 8000.
const sameOrigin = ['localhost', '127.0.0.1'].includes(location.hostname);
let server = safeGet('serverUrl') ?? (sameOrigin ? '' : 'http://localhost:8000');

const state = { packs: [], status: null, packsKey: '', poll: null };
const $ = (sel, el = document) => el.querySelector(sel);

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (h) => Math.round(h * 100);

async function api(path, opts = {}) {
  const res = await fetch(server + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data.detail;
    throw new Error(typeof d === 'string' ? d : Array.isArray(d) ? 'Check the fields and try again' : `Server error ${res.status}`);
  }
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2800);
}

// ------------------------------------------------------------ status

async function loadStatus() {
  const clamp = $('#clamp');
  try {
    state.status = await api('/api/status');
    const esp = state.status.source === 'esp32';
    clamp.dataset.state = esp ? 'esp32' : 'demo';
    $('#refs-n').textContent = state.status.references ?? 0;
    $('#clamp-v').textContent = esp ? `${state.status.port} · 50 Hz` : 'Demo signal';
    return true;
  } catch {
    state.status = null;
    clamp.dataset.state = 'off';
    $('#clamp-v').textContent = 'Offline';
    return false;
  }
}

function labelLevel(n) {
  if (n >= 10) return [4, 'strong'];
  if (n >= 6) return [3, 'good'];
  if (n >= 4) return [2, 'rough'];
  return [1, 'too few'];
}

// ------------------------------------------------------------ list

async function loadPacks() {
  try {
    state.packs = await api('/api/packs');
  } catch {
    if (!state.status) renderOffline();
    return;
  }
  const key = JSON.stringify(state.packs.map((p) => [p.id, p.status, p.health, p.updated]));
  if (key !== state.packsKey) {
    state.packsKey = key;
    renderList();
  }
}

function renderOffline() {
  state.packsKey = '';
  $('#amps').textContent = '–';
  $('#spark').innerHTML = '';
  $('#list').innerHTML = `
    <div class="empty-state">
      <div class="empty-art"></div>
      <h2>Server not reachable</h2>
      <p>Run the Python server, then this page connects by itself. Address: <b>${esc(server || location.origin)}</b></p>
      <button class="btn" id="set-server">Change address</button>
    </div>`;
  $('#set-server').onclick = openServerSheet;
}

function battHTML(p, big = false) {
  if (p.status === 'new' || p.health == null) {
    return `<div class="batt empty"><span class="batt-note">Not tested</span></div>`;
  }
  const w = Math.min(pct(p.health), 100);
  const source = p.status === 'predicted' ? 'predicted' : 'measured';
  return `<div class="batt" data-grade="${p.grade}" data-source="${source}"${big ? ' data-big' : ''}>
            <div class="batt-fill" data-w="${w}"></div></div>`;
}

function fillBars(root) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.querySelectorAll('.batt-fill[data-w]').forEach((el) => { el.style.width = el.dataset.w + '%'; });
  }));
}

function renderList() {
  const packs = state.packs;
  const labeled = packs.filter((p) => p.status === 'labeled');
  const tested = packs.filter((p) => p.health != null);

  const [level] = labelLevel(labeled.length);
  $('#labels').dataset.level = level;
  $('#labels-n').textContent = labeled.length;
  $('#labels').querySelectorAll('.ticks i').forEach((t, i) => t.classList.toggle('on', i < labeled.length));

  renderStock(packs, tested);

  if (!packs.length) {
    $('#list').innerHTML = `
      <div class="empty-state">
        <div class="empty-art"></div>
        <h2>Register your first pack</h2>
        <p>Add a used pack with the voltage and capacity on its label. Then label it or predict its health.</p>
        <button class="btn btn-primary" id="empty-add">Register pack</button>
      </div>`;
    $('#empty-add').onclick = openRegister;
    return;
  }

  $('#list').innerHTML = packs.map((p, i) => `
    <button class="row" data-id="${esc(p.id)}" style="animation-delay:${i * 35}ms">
      <div>
        <div class="row-id">${esc(p.id)}</div>
        <div class="row-model">${esc(p.model || 'Pack')} · ${p.rated_v} V · ${p.rated_ah} Ah</div>
      </div>
      ${battHTML(p)}
      ${p.health != null
        ? `<span class="pct r">${pct(p.health)}<small>%</small></span>`
        : `<span class="pct none r">–</span>`}
      <div class="grade">
        ${p.health != null
          ? `<span class="src">${p.status === 'predicted' ? 'Pred.' : 'Meas.'}</span><span class="chip" data-grade="${p.grade}">${p.grade === 'Reject' ? 'R' : p.grade}</span>`
          : `<span class="src">New</span>`}
      </div>
    </button>`).join('');

  $('#list').querySelectorAll('.row').forEach((row) => {
    row.onclick = () => openPack(row.dataset.id);
  });
  fillBars($('#list'));
}

function renderStock(packs, tested) {
  $('#n-packs').textContent = packs.length;
  const mean = tested.length ? Math.round(tested.reduce((s, p) => s + p.health, 0) / tested.length * 100) : null;
  $('#avg').textContent = mean != null ? `Average ${mean}%` : '–';

  const groups = [
    ['a', 'A', 'var(--a)', packs.filter((p) => p.grade === 'A').length],
    ['b', 'B', 'var(--b)', packs.filter((p) => p.grade === 'B').length],
    ['r', 'Reject', 'var(--r)', packs.filter((p) => p.grade === 'Reject').length],
    ['n', 'Untested', 'var(--none)', packs.filter((p) => p.health == null).length],
  ];
  $('#dist').innerHTML = packs.length
    ? groups.filter((g) => g[3]).map((g) => `<i class="${g[0]}" style="flex-grow:${g[3]}"></i>`).join('')
    : '';
  $('#dist-key').innerHTML = groups.map((g) =>
    `<div><span class="k" style="--c:${g[2]}">${g[1]}</span><b>${g[3]}</b></div>`).join('');
}

// ------------------------------------------------------------ live readout

async function loadLive() {
  if (!state.status || document.hidden) return;
  let live;
  try { live = await api('/api/live'); } catch { return; }
  $('#amps').textContent = live.amps.toFixed(2);
  const v = live.values;
  const svg = $('#spark');
  if (v.length < 2) { svg.innerHTML = ''; return; }
  const max = Math.max(2.5, ...v) * 1.1;
  const n = 100;  // 10 s at 10 values a second fills the width
  const x = (i) => (i + (n - v.length)) / (n - 1) * 400;
  const y = (a) => 62 - a / max * 58;
  const pts = v.map((a, i) => `${x(i).toFixed(1)},${y(a).toFixed(1)}`).join(' ');
  svg.innerHTML = `
    <line class="base" x1="0" x2="400" y1="62" y2="62"/>
    <path class="fill" d="M${x(0)},62 L${pts.replace(/ /g, ' L')} L${x(v.length - 1)},62 Z"/>
    <polyline class="line" points="${pts}"/>`;
}

// ------------------------------------------------------------ sheet

function openSheet(html) {
  stopPoll();
  $('#sheet-body').innerHTML = html;
  $('#sheet').hidden = false;
  const first = $('#sheet-body').querySelector('input, .choice, .btn');
  if (first) setTimeout(() => first.focus(), 60);
}

function closeSheet() {
  stopPoll();
  $('#sheet').hidden = true;
  $('#sheet-body').innerHTML = '';
}

document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

// ------------------------------------------------------------ register

function openRegister() {
  openSheet(`
    <p class="eyebrow">New pack</p>
    <h2 id="sheet-title">Register a pack</h2>
    <p class="sub">Copy the values from the label on the pack.</p>
    <form id="reg" novalidate>
      <label class="field"><span>Pack ID</span>
        <input class="input mono" name="pack_id" placeholder="P-01" maxlength="32" autocomplete="off"></label>
      <label class="field"><span>Model</span>
        <input class="input" name="model" placeholder="Swap pack, 2024" maxlength="60" autocomplete="off"></label>
      <div class="grid2">
        <label class="field"><span>Rated voltage</span>
          <div class="unit"><input class="input mono" name="rated_v" inputmode="decimal" placeholder="60"><em>V</em></div></label>
        <label class="field"><span>Rated capacity</span>
          <div class="unit"><input class="input mono" name="rated_ah" inputmode="decimal" placeholder="30"><em>Ah</em></div></label>
      </div>
      <div class="rated"><span>Rated energy when new</span><b id="rated-kwh">– kWh</b></div>
      <p class="err" id="reg-err"></p>
      <button class="btn btn-primary btn-block" type="submit">Register pack</button>
    </form>`);

  const form = $('#reg');
  const update = () => {
    const v = parseFloat(form.rated_v.value), ah = parseFloat(form.rated_ah.value);
    $('#rated-kwh').textContent = v > 0 && ah > 0 ? `${(v * ah / 1000).toFixed(2)} kWh` : '– kWh';
    $('#reg-err').textContent = '';
  };
  form.addEventListener('input', update);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const id = form.pack_id.value.trim(), v = parseFloat(form.rated_v.value), ah = parseFloat(form.rated_ah.value);
    if (!id) return showErr('Enter a pack ID');
    if (!(v > 0)) return showErr('Enter the rated voltage');
    if (!(ah > 0)) return showErr('Enter the rated capacity');
    try {
      const p = await api('/api/packs', { method: 'POST', body: { id, model: form.model.value, rated_v: v, rated_ah: ah } });
      closeSheet();
      toast(`${p.id} registered`);
      await loadPacks();
    } catch (err) { showErr(err.message); }
  };
  function showErr(m) { $('#reg-err').textContent = m; }
}

// ------------------------------------------------------------ pack

const ICON_LABEL = '<svg viewBox="0 0 24 24"><path d="M4 7h11l5 5-5 5H4z"/><circle cx="8.5" cy="12" r="1.5"/></svg>';
const ICON_PREDICT = '<svg viewBox="0 0 24 24"><path d="M3 17l5-6 4 3 5-7 4 4"/><path d="M17 7h4v4"/></svg>';
const ICON_PLUG = '<svg viewBox="0 0 24 24"><path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0z"/><path d="M12 16v5"/></svg>';

function packById(id) { return state.packs.find((p) => p.id === id); }

function openPack(id) {
  const p = packById(id);
  if (!p) return;
  const tested = p.health != null;
  openSheet(`
    <p class="eyebrow">${p.status === 'labeled' ? 'Labeled pack' : p.status === 'predicted' ? 'Predicted pack' : 'New pack'}</p>
    <h2 id="sheet-title" class="mono">${esc(p.id)}</h2>
    <p class="sub">${esc(p.model || 'Pack')} · ${p.rated_v} V · ${p.rated_ah} Ah · ${p.rated_kwh.toFixed(2)} kWh rated</p>
    ${tested ? `<div class="now">${battHTML(p)}<span class="pct">${pct(p.health)}<small>%</small></span><span class="chip" data-grade="${p.grade}">${p.grade}</span></div>` : ''}
    <div class="choices">
      <button class="choice" id="go-label">
        <div class="choice-ico">${ICON_LABEL}</div>
        <b>Label</b><span>Record the curve and the measured energy. Teaches the model.</span>
      </button>
      <button class="choice" id="go-predict">
        <div class="choice-ico">${ICON_PREDICT}</div>
        <b>Predict</b><span>Record the curve only. The model gives the health.</span>
      </button>
    </div>
    <button class="danger-link" id="del">Remove pack</button>`);
  fillBars($('#sheet-body'));
  $('#go-label').onclick = () => startCapture(p, 'label');
  $('#go-predict').onclick = () => startCapture(p, 'predict');
  $('#del').onclick = async () => {
    if (!confirm(`Remove ${p.id}? Its curve and label are deleted.`)) return;
    await api(`/api/packs/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    closeSheet();
    toast(`${p.id} removed`);
    await loadPacks();
  };
}

// ------------------------------------------------------------ capture

function stopPoll() { if (state.poll) { clearTimeout(state.poll); state.poll = null; } }

// remoteJob: a capture the ESP32 started with its BOOT button. The server then
// labels or predicts by itself; the page only watches.
async function startCapture(p, mode, remoteJob = null) {
  const sim = state.status?.source !== 'esp32';
  const total = state.status?.capture_seconds ?? 30;
  const waitText = remoteJob ? 'Started from the ESP32 button'
    : sim ? 'The simulator plugs in for you' : 'Waiting for the current to jump';
  openSheet(`
    <div class="steps"><i class="on"></i><i id="st2"></i><i id="st3"></i></div>
    <p class="eyebrow">${mode === 'label' ? 'Label' : 'Predict'} · ${esc(p.id)}</p>
    <h2 id="sheet-title">Record the plug-in curve</h2>
    <p class="sub">${total} seconds of charger current, read by the clamp.</p>
    <div class="plug" id="plug">
      <div class="plug-ico">${ICON_PLUG}</div>
      <div><b id="plug-title">Plug the charger in</b>
      <span id="plug-sub">${waitText}</span></div>
    </div>
    <div class="chart">
      <div class="chart-read"><b id="cap-amps">0.00</b><span>amps</span></div>
      <svg id="chart" viewBox="0 0 560 190" preserveAspectRatio="none"></svg>
    </div>
    <div class="progress"><i id="prog"></i></div>
    <div class="chart-cap"><span id="cap-left">Waiting</span><span id="cap-right">0 / ${total} s</span></div>
    <div id="after"></div>`);

  let job = remoteJob ? { job_id: remoteJob } : null;
  if (!job) {
    try {
      job = await api(`/api/packs/${encodeURIComponent(p.id)}/capture`, { method: 'POST' });
    } catch (err) {
      $('#plug-title').textContent = 'Could not start';
      $('#plug-sub').textContent = err.message;
      return;
    }
  }

  const values = [];
  let lastState = 'waiting';
  const tick = async () => {
    let s;
    try {
      s = await api(`/api/capture/${job.job_id}?since=${values.length}`);
    } catch (err) {
      $('#plug-sub').textContent = err.message;
      return;
    }
    values.push(...s.values);
    if (s.state === 'failed') {
      $('#plug-title').textContent = 'No plug-in seen';
      $('#plug-sub').textContent = s.error;
      if (remoteJob) {
        $('#after').innerHTML = `<button class="btn btn-block" data-close>Close</button>`;
      } else {
        $('#after').innerHTML = `<button class="btn btn-block" id="retry">Try again</button>`;
        $('#retry').onclick = () => startCapture(p, mode);
      }
      return;
    }
    if (s.state !== lastState) {
      lastState = s.state;
      if (s.state === 'capturing') {
        $('#plug').classList.add('live');
        $('#plug-title').textContent = 'Charger plugged in';
        $('#plug-sub').textContent = 'Recording. Keep it plugged in.';
        $('#st2').classList.add('on');
      }
    }
    const secs = values.length / 50;
    $('#prog').style.width = `${Math.min(100, values.length / s.total * 100)}%`;
    $('#cap-left').textContent = s.state === 'waiting' ? 'Waiting' : s.state === 'done' ? 'Done' : 'Recording';
    $('#cap-right').textContent = `${Math.min(secs, total).toFixed(0)} / ${total} s`;
    if (values.length) $('#cap-amps').textContent = values[values.length - 1].toFixed(2);
    drawChart(values, total, s.state === 'done');

    if (s.state === 'done') {
      $('#st3').classList.add('on');
      $('#plug-title').textContent = 'Curve recorded';
      $('#plug-sub').textContent = 'You can unplug the charger';
      if (remoteJob) waitRemoteResult(p, mode);
      else if (mode === 'label') showLabelForm(p, job.job_id, s.suggested_kwh);
      else runPredict(p, job.job_id);
      return;
    }
    state.poll = setTimeout(tick, 200);
  };
  tick();
}

async function waitRemoteResult(p, mode) {
  $('#after').innerHTML = `<button class="btn btn-block" disabled>${mode === 'label' ? 'Saving label…' : 'Predicting…'}</button>`;
  for (let i = 0; i < 60; i++) {
    const a = await api('/api/active').catch(() => null);
    if (a?.state === 'done' && a.result) {
      await loadPacks();
      const r = a.result;
      if (mode === 'label') {
        showResult(r, 'Measured health', `${r.kwh.toFixed(2)} of ${r.rated_kwh.toFixed(2)} kWh · now teaching the model`);
      } else {
        await showModel(r);
        showResult(r, 'Predicted health', predictMeta(r));
      }
      return;
    }
    if (a?.state === 'failed') {
      $('#after').innerHTML = `<p class="err">${esc(a.error)}</p><button class="btn btn-block" data-close>Close</button>`;
      await loadPacks();
      return;
    }
    await new Promise((res) => setTimeout(res, 500));
  }
}

// Opens the recording screen when the ESP32's BOOT button starts a capture.
async function watchActive() {
  if (!state.status) return;
  const a = await api('/api/active').catch(() => null);
  if (!a) return;
  if (state.seenSeq == null) { state.seenSeq = a.seq; return; }  // ignore old ones on load
  if (a.seq <= state.seenSeq) return;
  state.seenSeq = a.seq;
  if (a.state === 'capturing') {
    await loadPacks();
    startCapture(packById(a.pack_id) ?? { id: a.pack_id }, a.mode, a.job_id);
  } else if (a.state === 'failed' && !a.job_id) {
    toast(a.error);  // refused before any recording started
  }
}

function drawChart(values, total, done) {
  const svg = $('#chart');
  if (!svg) return;
  const W = 560, H = 190, L = 34, R = 8, T = 10, B = 22;
  const max = Math.max(1, ...values) * 1.15;
  const step = max > 4 ? 1 : max > 2 ? 0.5 : 0.25;
  const ymax = Math.ceil(max / step) * step;
  const x = (i) => L + (i / 50) / total * (W - L - R);
  const y = (a) => T + (1 - a / ymax) * (H - T - B);

  const ticks = [];
  for (let v = 0; v <= ymax + 1e-9; v += step) ticks.push(v);
  const xt = [0, total / 4, total / 2, total * 3 / 4, total];

  const stride = Math.max(1, Math.floor(values.length / 400));
  const pts = [];
  for (let i = 0; i < values.length; i += stride) pts.push(`${x(i).toFixed(1)},${y(values[i]).toFixed(1)}`);
  const line = pts.join(' ');
  const area = pts.length ? `M${x(0)},${y(0)} L${line.replace(/ /g, ' L')} L${x((pts.length - 1) * stride)},${y(0)} Z` : '';

  let dots = '';
  if (done) {
    const scale = total / 30;
    dots = FEATURE_TIMES.map((t, k) => {
      const i = Math.min(Math.round(t * scale * 50), values.length - 1);
      return `<circle class="pt" cx="${x(i)}" cy="${y(values[i])}" r="3" style="animation-delay:${k * 25}ms"/>`;
    }).join('');
  }

  svg.innerHTML = `
    <g class="grid">${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`).join('')}</g>
    <g class="axis">
      ${ticks.map((v) => `<text x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end">${v}</text>`).join('')}
      ${xt.map((t) => `<text x="${L + t / total * (W - L - R)}" y="${H - 4}" text-anchor="middle">${Math.round(t)}s</text>`).join('')}
    </g>
    ${area ? `<path class="area" d="${area}"/>` : ''}
    ${line ? `<polyline class="curve" points="${line}"/>` : ''}
    ${dots}`;
}

function showLabelForm(p, jobId, suggested) {
  $('#sheet-title').textContent = 'Enter the measured energy';
  $('#after').innerHTML = `
    <form id="lab" novalidate>
      <label class="field"><span>Energy into the pack on a full charge from empty</span>
        <div class="unit"><input class="input mono" name="kwh" inputmode="decimal" placeholder="${(p.rated_kwh * 0.8).toFixed(2)}"><em>kWh</em></div></label>
      ${suggested ? `<p class="hint">Simulator value: <button type="button" id="use-sug">${suggested.toFixed(2)} kWh</button></p>` : ''}
      <div class="rated"><span>Health = measured ÷ ${p.rated_kwh.toFixed(2)} kWh rated</span><b id="lab-h">–</b></div>
      <p class="err" id="lab-err"></p>
      <button class="btn btn-primary btn-block" type="submit">Save label</button>
    </form>`;
  const form = $('#lab');
  const upd = () => {
    const k = parseFloat(form.kwh.value);
    $('#lab-h').textContent = k > 0 ? `${pct(k / p.rated_kwh)}%` : '–';
    $('#lab-err').textContent = '';
  };
  form.addEventListener('input', upd);
  if (suggested) $('#use-sug').onclick = () => { form.kwh.value = suggested.toFixed(2); upd(); };
  form.kwh.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const kwh = parseFloat(form.kwh.value);
    if (!(kwh > 0)) { $('#lab-err').textContent = 'Enter the measured energy in kWh'; return; }
    try {
      const out = await api(`/api/packs/${encodeURIComponent(p.id)}/label`, { method: 'POST', body: { job_id: jobId, kwh } });
      await loadPacks();
      showResult(out, 'Measured health', `${kwh.toFixed(2)} of ${out.rated_kwh.toFixed(2)} kWh · now teaching the model`);
    } catch (err) { $('#lab-err').textContent = err.message; }
  };
}

async function runPredict(p, jobId) {
  $('#after').innerHTML = `<button class="btn btn-block" disabled>Predicting…</button>`;
  try {
    const out = await api(`/api/packs/${encodeURIComponent(p.id)}/predict`, { method: 'POST', body: { job_id: jobId } });
    await loadPacks();
    await showModel(out);
    showResult(out, 'Predicted health', predictMeta(out));
  } catch (err) {
    $('#after').innerHTML = `<p class="err">${esc(err.message)}</p><button class="btn btn-block" data-close>Close</button>`;
  }
}

function predictMeta(r) {
  const used = (r.library || []).filter((e) => e.used).length;
  return `Weighted average of the ${used} closest of ${r.labels_used} known packs`;
}

// The model at work: every known pack is a dot placed at its health. Dots grow
// with how alike their curve is to this one, the closest K are joined to the
// answer, and the answer lands at their weighted average.
function showModel(r) {
  const lib = r.library || [];
  if (!lib.length) return Promise.resolve();
  const W = 560, L = 18, R = 18, AX = 150, lo = 0.45, hi = 1.0;
  const x = (h) => L + (Math.min(Math.max(h, lo), hi) - lo) / (hi - lo) * (W - L - R);
  const lanes = [46, 72, 98, 124];
  const order = [...lib].sort((a, b) => a.health - b.health);
  const used = lib.filter((e) => e.used).sort((a, b) => b.weight - a.weight);
  const px = x(r.health);

  const bands = [[lo, 0.6, 'r'], [0.6, 0.8, 'b'], [0.8, hi, 'a']].map(([a, b, c]) =>
    `<rect class="m-band ${c}" x="${x(a)}" y="30" width="${x(b) - x(a)}" height="${AX - 30}"/>`).join('');
  const ticks = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0].map((t) =>
    `<line class="m-tick" x1="${x(t)}" x2="${x(t)}" y1="${AX}" y2="${AX + 5}"/>
     <text class="m-tx" x="${x(t)}" y="${AX + 18}">${Math.round(t * 100)}%</text>`).join('');
  const pos = new Map(order.map((e, i) => [e.id, [x(e.health), lanes[i % lanes.length]]]));
  const lines = used.map((e) => {
    const [cx, cy] = pos.get(e.id);
    return `<line class="m-link" x1="${cx}" y1="${cy}" x2="${px}" y2="${AX}" style="stroke-width:${1 + e.weight * 5}"/>`;
  }).join('');
  const dots = order.map((e, i) => {
    const [cx, cy] = pos.get(e.id);
    return `<circle class="m-dot${e.used ? ' used' : ''}${e.kind === 'label' ? ' lab' : ''}" cx="${cx}" cy="${cy}"
      r="${(2.5 + e.similarity * 5).toFixed(1)}" style="transition-delay:${i * 32}ms"><title>${esc(e.id)} · ${pct(e.health)}%</title></circle>`;
  }).join('');

  openSheet(`
    <div class="steps"><i class="on"></i><i class="on"></i><i class="on"></i></div>
    <p class="eyebrow">Model · ${esc(r.id)}</p>
    <h2 id="sheet-title">Comparing with ${lib.length} known packs</h2>
    <p class="sub">Finds the curves most like this one, then averages their health.</p>
    <div class="m-stage">
      <div class="m-read"><span class="k" id="m-phase">Scanning library</span><b id="m-val">–</b></div>
      <svg id="m-svg" viewBox="0 0 ${W} ${AX + 26}" aria-hidden="true">
        ${bands}
        <text class="m-zone" x="${x(0.525)}" y="24">Reject</text>
        <text class="m-zone" x="${x(0.7)}" y="24">B</text>
        <text class="m-zone" x="${x(0.9)}" y="24">A</text>
        <line class="m-axis" x1="${L}" x2="${W - R}" y1="${AX}" y2="${AX}"/>
        ${ticks}${lines}${dots}
        <path class="m-mark" d="M${px} ${AX - 2}l-7 -11h14z"/>
      </svg>
    </div>
    <div class="nbs">
      ${used.map((e) => `
        <div class="nb">
          <span class="mono">${esc(e.id)}</span>
          <span class="nb-kind">${e.kind === 'label' ? 'Labeled' : 'Reference'}</span>
          <div class="nb-bar"><i data-w="${Math.round(e.weight * 100)}"></i></div>
          <span class="mono nb-h">${pct(e.health)}%</span>
          <span class="mono nb-w">${Math.round(e.weight * 100)}%</span>
        </div>`).join('')}
    </div>
    <p class="m-legend"><span class="m-key"></span>Reference <span class="m-key lab"></span>Labeled here · dot size = how alike · line width = weight</p>`);

  const svg = $('#m-svg');
  const scan = order.length * 32 + 350;
  return new Promise((resolve) => {
    requestAnimationFrame(() => svg.classList.add('scan'));
    setTimeout(() => {
      svg.classList.add('focus');
      $('#m-phase').textContent = `Closest ${used.length}`;
      $('#sheet-body').querySelectorAll('.nb-bar i').forEach((el) => { el.style.width = el.dataset.w + '%'; });
    }, scan);
    setTimeout(() => {
      svg.classList.add('land');
      $('#m-phase').textContent = 'Weighted average';
      const target = pct(r.health), t0 = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - t0) / 700);
        $('#m-val').textContent = `${Math.round(target * (1 - Math.pow(1 - k, 3)))}%`;
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }, scan + 1100);
    setTimeout(resolve, scan + 3200);
  });
}

function showResult(p, title, meta) {
  openSheet(`
    <div class="steps"><i class="on"></i><i class="on"></i><i class="on"></i></div>
    <div class="result">
      <p class="eyebrow">${title} · ${esc(p.id)}</p>
      <div class="result-big">${pct(p.health)}<small>%</small></div>
      <span class="chip" data-grade="${p.grade}">Grade ${p.grade}</span>
      ${battHTML(p, true)}
      <p class="result-meta">${esc(meta)}</p>
      <button class="btn btn-primary btn-block" data-close>Done</button>
    </div>`);
  fillBars($('#sheet-body'));
}

// ------------------------------------------------------------ server address

function openServerSheet() {
  openSheet(`
    <p class="eyebrow">Connection</p>
    <h2 id="sheet-title">Server address</h2>
    <p class="sub">The Python server running on the laptop with the ESP32.</p>
    <form id="srv">
      <label class="field"><span>Address</span>
        <input class="input mono" name="url" value="${esc(server || location.origin)}"></label>
      <button class="btn btn-primary btn-block" type="submit">Connect</button>
    </form>`);
  $('#srv').onsubmit = async (e) => {
    e.preventDefault();
    let url = e.target.url.value.trim().replace(/\/+$/, '');
    if (url === location.origin) url = '';
    server = url;
    safeSet('serverUrl', url);
    closeSheet();
    state.packsKey = '';
    if (await loadStatus()) await loadPacks(); else renderOffline();
  };
}

// ------------------------------------------------------------ start

$('#add').onclick = () => (state.status ? openRegister() : toast('Start the server first'));
$('#server').onclick = openServerSheet;

(async function init() {
  if (await loadStatus()) { await loadPacks(); loadLive(); } else renderOffline();
  setInterval(loadLive, 500);
  setInterval(watchActive, 1000);
  setInterval(async () => {
    const was = !!state.status;
    const now = await loadStatus();
    if (now) await loadPacks();
    else if (was) renderOffline();
  }, 3000);
})();
