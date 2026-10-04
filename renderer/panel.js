const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hm = sec => { sec = Math.round(sec / 60); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
const hms = sec => { sec = Math.max(0, Math.floor(sec)); return `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; };
const hrs = h => h.toFixed(2).replace('.', ',') + ' h';
const isoDate = d => { d = new Date(d); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const today = () => isoDate(new Date());
const msg = (el, text, kind = '') => { el.textContent = text; el.className = 'msg ' + kind; };

let toastTimer;
function toast(text, err = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 2600);
}

let activities = [];
let state = null;
let reviewRows = [], reviewSegs = [], reviewWritable = false;

// ---------- navegación ----------
function showTab(tab) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('section').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
  ({ tasks: loadRecent, review: loadReview, summary: loadSummary, settings: loadSettings })[tab]?.();
  if (tab === 'tasks') $('q').focus();
}
document.querySelectorAll('nav button').forEach(b => (b.onclick = () => showTab(b.dataset.tab)));
tt.on('tab', showTab);
tt.on('state', s => { state = s; renderNow(); });

document.querySelectorAll('[data-shift]').forEach(b => {
  b.onclick = () => {
    const input = $(b.dataset.for);
    const d = new Date(input.value + 'T12:00:00');
    d.setDate(d.getDate() + Number(b.dataset.shift));
    input.value = isoDate(d);
    input.onchange();
  };
});

// ---------- tarjeta "en curso" ----------
function renderNow() {
  if (!state) return;
  const c = state.current;
  $('nowDot').className = 'dot' + (c ? ' on' : '');
  $('nowState').textContent = c ? 'En curso' : state.idlePrompt ? 'En pausa' : 'Parado';
  const issue = c?.issue || state.lastIssue;
  $('nowTask').textContent = issue ? `#${issue.id} ${issue.subject}` : 'Sin tarea en curso';
  $('nowTimer').textContent = hms(c ? (Date.now() - c.start) / 1000 : 0);
  const btn = $('nowBtn');
  btn.textContent = c ? 'Parar' : 'Reanudar';
  btn.className = 'btn btn-block ' + (c ? 'btn-danger' : 'btn-primary');
  btn.disabled = !c && !state.lastIssue && !state.idlePrompt;
}
$('nowBtn').onclick = () => tt.call('timer:toggle');
setInterval(renderNow, 1000);

function activityOptions(selected, emptyLabel = '— actividad —') {
  return `<option value="">${emptyLabel}</option>` +
    activities.map(a => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
}
const actName = id => activities.find(a => a.id === id)?.name || '';

async function loadActivities() {
  activities = await tt.call('activities:get');
  const s = await tt.call('settings:get');
  $('startActivity').innerHTML = activityOptions(s.defaultActivityId, 'Actividad…');
}

// ---------- tareas ----------
// Depth-first order of a project's issues following parent → child (Redmine issue tree).
// Issues whose parent is not in the same group become roots and show "↳ #parent".
function treeOrder(items) {
  const ids = new Set(items.map(i => i.id));
  const children = new Map();
  for (const i of items) {
    const key = ids.has(i.parentId) ? i.parentId : null;
    children.set(key, [...(children.get(key) || []), i]);
  }
  const out = [];
  const walk = (key, depth) => (children.get(key) || []).forEach(i => {
    out.push({ i, depth: Math.min(depth, 4), orphanOf: depth === 0 && i.parentId ? i.parentId : null });
    walk(i.id, depth + 1);
  });
  walk(null, 0);
  return out;
}

function renderIssues(list, title) {
  const real = list.filter(i => !i.context);
  $('resultsTitle').textContent = title;
  $('resultsCount').textContent = real.length ? `${real.length} tareas` : '';
  const curId = state?.current?.issue.id;
  // Grouped by project (alphabetical); inside each group, the issue tree.
  const groups = new Map();
  for (const i of list) groups.set(i.project, [...(groups.get(i.project) || []), i]);
  const sorted = [...groups].sort(([a], [b]) => a.localeCompare(b, 'es'));
  $('results').innerHTML = real.length ? sorted.map(([project, items]) => `
    <li class="group"><span>${esc(project || 'Sin proyecto')}</span><span class="group-count">${items.filter(i => !i.context).length}</span></li>` + treeOrder(items).map(({ i, depth, orphanOf }) => `
    <li class="depth-${depth} ${i.context ? 'context' : ''} ${i.id === curId ? 'current' : ''}" ${i.context ? 'title="Tarea padre (no está en el resultado)"' : ''}>
      <span class="issue-id">${depth ? '<span class="tree-mark">└</span>' : ''}#${i.id}</span>
      <div class="issue-main">
        <div class="issue-title">${esc(i.subject)}</div>
        ${orphanOf ? `<div class="issue-meta">↳ subtarea de #${orphanOf}</div>` : ''}
      </div>
      ${i.status ? `<span class="badge">${esc(i.status)}</span>` : ''}
      <button class="btn btn-sm ${i.id === curId ? '' : 'btn-primary'}" data-id="${i.id}" ${i.id === curId ? 'disabled' : ''}>${i.id === curId ? 'En curso' : '▶ Empezar'}</button>
    </li>`).join('')).join('') : '<li class="empty">Nada que mostrar.</li>';
  $('results').querySelectorAll('button[data-id]').forEach(b => {
    b.onclick = async () => {
      const issue = list.find(i => String(i.id) === b.dataset.id);
      const act = Number($('startActivity').value) || null;
      await tt.call('timer:start', { id: issue.id, subject: issue.subject, project: issue.project }, act);
      toast(`Contando #${issue.id}`);
      setTimeout(() => window.close(), 600);
    };
  });
}

function setChip(id) {
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.id === id));
}

async function loadRecent() {
  setChip('recentBtn');
  renderIssues(await tt.call('issues:recent'), 'Recientes');
}

async function loadProjects() {
  try {
    const projects = await tt.call('projects:list');
    const sel = $('projectFilter');
    const current = sel.value;
    const opts = list => list.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    const fav = projects.filter(p => p.bookmarked), member = projects.filter(p => !p.bookmarked);
    sel.innerHTML = '<option value="">★ Todos mis favoritos</option>' +
      (fav.length ? `<optgroup label="Favoritos">${opts(fav)}</optgroup>` : '') +
      (member.length ? `<optgroup label="Participo">${opts(member)}</optgroup>` : '');
    if ([...sel.options].some(o => o.value === current)) sel.value = current;
  } catch { /* sin conexión ni lista previa: queda solo "Todos mis favoritos" */ }
}

async function search(q, title) {
  msg($('searchMsg'), 'Buscando…');
  try {
    const projectId = $('projectFilter').value;
    if (projectId) title += ' · ' + $('projectFilter').selectedOptions[0].textContent;
    const list = await tt.call('issues:search', q, projectId);
    renderIssues(list, title);
    msg($('searchMsg'), '');
  } catch (err) {
    msg($('searchMsg'), err.message, 'err');
  }
}

$('searchForm').onsubmit = e => {
  e.preventDefault();
  const q = $('q').value.trim();
  setChip(q ? null : 'mineBtn');
  search(q, q ? 'Resultados' : 'Mis tareas abiertas');
};
$('mineBtn').onclick = () => { setChip('mineBtn'); $('q').value = ''; search('', 'Mis tareas abiertas'); };
$('recentBtn').onclick = loadRecent;
$('projectFilter').onchange = () => $('searchForm').requestSubmit();

// ---------- revisión ----------
$('reviewDate').value = today();
$('reviewDate').onchange = loadReview;

async function loadReview() {
  const date = $('reviewDate').value;
  const r = await tt.call('review:get', date);
  reviewRows = r.rows;
  $('reviewRows').innerHTML = reviewRows.length ? reviewRows.map((row, i) => {
    const dis = row.submitted ? 'disabled' : '';
    return `
    <tr class="${row.submitted ? 'sent' : ''}" data-i="${i}">
      <td><input type="checkbox" class="inc" ${row.include ? 'checked' : ''} ${dis}></td>
      <td>
        <div class="issue-title"><span class="issue-id">#${row.issueId}</span> ${esc(row.subject)}</div>
        <div class="issue-meta">${esc(row.project)}${row.submitted ? ` · <span class="badge sent-badge">✓ enviada${row.submitted.timeEntryId ? ' #' + row.submitted.timeEntryId : ''}</span>` : ''}</div>
      </td>
      <td><select class="act" ${dis}>${activityOptions(row.activityId)}</select></td>
      <td class="num muted">${hm(row.seconds)}</td>
      <td class="num"><input class="hours" type="number" step="0.25" min="0" value="${row.hours}" ${dis}></td>
      <td class="row-comment"></td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="empty">Sin tiempo registrado este día.</td></tr>';

  $('reviewRows').querySelectorAll('tr[data-i]').forEach(tr => {
    const row = reviewRows[tr.dataset.i];
    tr.querySelector('.inc').onchange = e => { row.include = e.target.checked; refreshComments(); updateTotals(); };
    tr.querySelector('.act').onchange = e => { row.activityId = Number(e.target.value) || null; };
    tr.querySelector('.hours').oninput = e => { row.hours = Math.max(0, Number(e.target.value) || 0); updateTotals(); };
  });

  reviewSegs = r.segments;
  $('segCount').textContent = r.segments.length ? `(${r.segments.length})` : '';
  const t = ts => new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  $('segRows').innerHTML = r.segments.length ? r.segments.map(s => `
    <tr>
      <td class="muted">${t(s.start)} – ${t(s.end)}</td>
      <td><span class="issue-id">#${s.issueId}</span> ${esc(s.subject)}</td>
      <td class="muted">${esc(actName(s.activityId))}</td>
      <td class="num">${hm((s.end - s.start) / 1000)}</td>
      <td class="seg-comment-cell"><input class="seg-comment" data-id="${esc(s.id)}" maxlength="500" placeholder="¿Qué has hecho? (obligatorio)" value="${esc(s.comment || '')}" ${segSent(s) ? 'disabled' : ''}></td>
      <td class="num"><button class="btn btn-sm btn-ghost" data-id="${esc(s.id)}" title="Borrar tramo">Borrar</button></td>
    </tr>`).join('') : '<tr><td class="empty">Sin tramos.</td></tr>';
  $('segRows').querySelectorAll('input.seg-comment').forEach(inp => {
    inp.onchange = async () => {
      const seg = reviewSegs.find(x => x.id === inp.dataset.id);
      try {
        seg.comment = await tt.call('segments:setComment', seg.id, inp.value);
        inp.value = seg.comment;
        refreshComments();
      } catch (err) { msg($('reviewMsg'), err.message, 'err'); }
    };
    inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); };
  });
  $('segRows').querySelectorAll('button[data-id]').forEach(b => (b.onclick = async () => {
    if (!confirm('¿Borrar este tramo?')) return;
    await tt.call('segments:delete', b.dataset.id);
    loadReview();
  }));

  const notes = [];
  if (!r.writeEnabled) notes.push('Modo solo lectura: la escritura en Redmine está desactivada en Ajustes.');
  if (state?.current && date === today()) notes.push('Hay un contador en marcha: su tiempo aparecerá aquí al pararlo.');
  $('reviewBanner').textContent = notes.join(' ');
  $('reviewBanner').classList.toggle('hidden', !notes.length);
  reviewWritable = r.writeEnabled;
  msg($('reviewMsg'), '');
  refreshComments();
  updateTotals();
}

const segKey = s => `${s.issueId}|${s.activityId ?? ''}`;
const segSent = s => reviewRows.some(r => r.submitted && r.key === segKey(s));

// Recalcula, a partir de los tramos, el comentario de cada fila y si falta alguno.
function refreshComments() {
  for (const row of reviewRows) {
    const segs = reviewSegs.filter(s => segKey(s) === row.key);
    const texts = [...new Set(segs.map(s => String(s.comment || '').trim()).filter(Boolean))];
    row.comments = texts.join('; ');
    row.uncommented = segs.filter(s => !String(s.comment || '').trim()).length;
  }
  $('reviewRows').querySelectorAll('tr[data-i]').forEach(tr => {
    const row = reviewRows[tr.dataset.i];
    tr.querySelector('.row-comment').innerHTML = row.uncommented && !row.submitted
      ? `<span class="warn">${row.uncommented > 1 ? `Faltan ${row.uncommented} comentarios` : 'Falta 1 comentario'} de tramo</span>`
      : `<span class="muted">${esc(row.comments) || '—'}</span>`;
  });
  $('segRows').querySelectorAll('input.seg-comment').forEach(inp => inp.classList.toggle('missing', !inp.disabled && !inp.value.trim()));
  const missing = reviewRows.some(r => r.include && !r.submitted && r.uncommented);
  if (missing) $('segDetails').open = true;
  $('submitBtn').disabled = !reviewWritable || missing;
  $('submitBtn').title = missing ? 'Cada tramo necesita un comentario antes de imputar' : '';
}

function updateTotals() {
  const pending = reviewRows.filter(r => r.include && !r.submitted).reduce((a, r) => a + r.hours, 0);
  const sent = reviewRows.filter(r => r.submitted).reduce((a, r) => a + r.submitted.hours, 0);
  $('statReal').textContent = hm(reviewRows.reduce((a, r) => a + r.seconds, 0));
  $('statPending').textContent = hrs(pending);
  $('statSent').textContent = hrs(sent);
}

$('submitBtn').onclick = async () => {
  const date = $('reviewDate').value;
  const rows = reviewRows.filter(r => !r.submitted).map(r => ({ ...r, submitted: undefined }));
  try {
    const res = await tt.call('review:submit', date, rows);
    if (res.cancelled) return;
    const fails = res.results.filter(x => !x.ok);
    await loadReview();
    if (fails.length) msg($('reviewMsg'), `Fallaron ${fails.length}: ${fails.map(f => f.error).join(' | ')}`, 'err');
    else toast(`Imputadas ${res.results.length} entradas en Redmine`);
  } catch (err) {
    msg($('reviewMsg'), err.message, 'err');
  }
};

// ---------- resúmenes ----------
$('sumDate').value = today();
$('sumDate').onchange = loadSummary;

async function loadSummary() {
  const { daily, weekly } = await tt.call('summary:get', $('sumDate').value);
  $('sumDay').textContent = hm(daily.seconds);
  $('sumDayH').textContent = hrs(daily.hours) + ' redondeadas';
  $('sumWeek').textContent = hm(weekly.seconds);
  $('sumWeekH').textContent = hrs(weekly.issues.reduce((a, i) => a + i.hours, 0)) + ' redondeadas';

  const max = Math.max(1, ...daily.issues.map(i => i.seconds));
  $('daily').innerHTML = daily.issues.length ? daily.issues.map(i => `
    <li>
      <div class="bar-label">
        <div class="issue-title"><span class="issue-id">#${i.issueId}</span> ${esc(i.subject)}</div>
        <div class="bar-track"><div class="bar-fill" data-w="${(i.seconds / max * 100).toFixed(1)}"></div></div>
      </div>
      <span class="num">${hm(i.seconds)}</span>
      <span class="num muted">${hrs(i.hours)}</span>
    </li>`).join('') : '<li class="empty">Sin tiempo registrado este día.</li>';

  const dayNames = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  const td = today();
  const cellMax = Math.max(1, ...weekly.issues.flatMap(i => Object.values(i.perDay)));
  const cell = sec => {
    if (!sec) return '<td class="cell"><span class="muted">·</span></td>';
    const a = (0.12 + 0.5 * sec / cellMax).toFixed(2);
    return `<td class="cell"><span data-a="${a}">${hm(sec)}</span></td>`;
  };
  $('weeklyHead').innerHTML = `<tr><th>Tarea</th>${weekly.days.map((d, i) => `<th class="day ${d === td ? 'today-col' : ''}">${dayNames[i]} ${d.slice(8)}</th>`).join('')}<th class="num">Total</th></tr>`;
  $('weekly').innerHTML = weekly.issues.length ? weekly.issues.map(i => `
    <tr><td><div class="issue-title"><span class="issue-id">#${i.issueId}</span> ${esc(i.subject)}</div></td>
    ${weekly.days.map(d => cell(i.perDay[d])).join('')}
    <td class="num"><b>${hm(i.seconds)}</b><div class="muted">${hrs(i.hours)}</div></td></tr>`).join('') +
    `<tr class="total"><td>Total</td>${weekly.days.map(d => `<td class="cell">${weekly.totals[d] ? hm(weekly.totals[d]) : ''}</td>`).join('')}<td class="num">${hm(weekly.seconds)}</td></tr>`
    : '<tr><td colspan="9" class="empty">Sin tiempo registrado esta semana.</td></tr>';
  // La CSP no permite style="" en el HTML; se aplica por CSSOM.
  document.querySelectorAll('#daily .bar-fill').forEach(el => (el.style.width = el.dataset.w + '%'));
  document.querySelectorAll('#weekly span[data-a]').forEach(el => (el.style.background = `rgba(47, 191, 134, ${el.dataset.a})`));
}

// ---------- ajustes ----------
const form = $('settingsForm');

async function loadSettings() {
  const s = await tt.call('settings:get');
  form.url.value = s.url || '';
  form.apiKey.value = '';
  form.apiKey.placeholder = s.hasApiKey ? '•••••••••••••••• (guardada) · escribe otra para cambiarla' : 'Pega aquí tu API key';
  $('clearKey').hidden = !s.hasApiKey;
  $('keyStatus').className = s.error ? 'msg err' : s.hasApiKey ? 'msg ok' : '';
  $('keyStatus').textContent = s.error ||
    (s.hasApiKey ? `✓ Guardada y cifrada en el ${s.storage || 'llavero del sistema'}. Nunca se escribe en claro en disco.`
                 : 'Redmine → Mi cuenta → Clave de acceso a la API. Se guardará cifrada en el llavero del sistema.');
  form.caPath.value = s.caPath || '';
  form.defaultActivityId.innerHTML = activityOptions(s.defaultActivityId, activities.length ? '— elige —' : 'Prueba la conexión para cargarlas');
  form.idleMinutes.value = s.idleMinutes;
  form.rounding.value = s.rounding;
  form.onlyOpen.checked = s.onlyOpen;
  form.writeEnabled.checked = s.writeEnabled;
}

function settingsPayload() {
  return {
    url: form.url.value.trim(),
    apiKey: form.apiKey.value,
    caPath: form.caPath.value.trim(),
    defaultActivityId: Number(form.defaultActivityId.value) || null,
    idleMinutes: Number(form.idleMinutes.value),
    rounding: form.rounding.value,
    onlyOpen: form.onlyOpen.checked,
    writeEnabled: form.writeEnabled.checked
  };
}

$('clearKey').onclick = async () => {
  if (!confirm('¿Borrar la API key guardada? La app dejará de poder conectar con Redmine hasta que pongas otra.')) return;
  await tt.call('settings:clearKey');
  await loadSettings();
  toast('API key borrada');
};

form.onsubmit = async e => {
  e.preventDefault();
  try {
    await tt.call('settings:save', settingsPayload());
    await loadActivities();
    await loadSettings();
    toast('Ajustes guardados');
  } catch (err) { msg($('settingsMsg'), err.message, 'err'); }
};

$('testBtn').onclick = async () => {
  msg($('testMsg'), 'Conectando…');
  try {
    await tt.call('settings:save', settingsPayload()); // prueba con lo que hay escrito
    const r = await tt.call('settings:test');
    msg($('testMsg'), `Conectado como ${r.user} · ${r.activities} actividades`, 'ok');
    await loadActivities();
    await loadSettings();
  } catch (err) { msg($('testMsg'), err.message, 'err'); }
};

$('pickCa').onclick = async () => {
  const p = await tt.call('settings:pickCa');
  if (p) form.caPath.value = p;
};

// ---------- inicio ----------
(async () => {
  state = await tt.call('state:get');
  renderNow();
  await loadActivities();
  loadProjects();
  showTab(new URLSearchParams(location.search).get('tab') || 'tasks');
})();
