// Lógica pura (sin Electron): fechas, troceo por días, agregación y redondeo.

function localDate(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function startOfNextDay(ts) {
  const d = new Date(ts);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

// Parte un segmento que cruza medianoche en varios, uno por día.
function splitByDay(seg) {
  const out = [];
  let start = seg.start;
  while (localDate(start) !== localDate(seg.end - 1) && seg.end > start) {
    const cut = startOfNextDay(start);
    out.push({ ...seg, start, end: cut });
    start = cut;
  }
  if (seg.end > start) out.push({ ...seg, start, end: seg.end });
  return out;
}

function roundHours(seconds, mode = 'nearest', step = 0.25) {
  const h = seconds / 3600;
  const q = h / step;
  const r = mode === 'up' ? Math.ceil(q - 1e-9) : Math.round(q);
  return Math.round(r * step * 100) / 100;
}

function segmentsOfDate(segments, date) {
  return segments.filter(s => localDate(s.start) === date);
}

// Agrupa los segmentos de un día por (issue, actividad) para la revisión.
function buildReview(segments, date, { rounding = 'nearest', submissions = [] } = {}) {
  const groups = new Map();
  for (const s of segmentsOfDate(segments, date)) {
    const key = `${s.issueId}|${s.activityId ?? ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key, issueId: s.issueId, subject: s.subject, project: s.project,
        activityId: s.activityId ?? null, seconds: 0, comments: [], uncommented: 0
      });
    }
    const g = groups.get(key);
    g.seconds += Math.max(0, (s.end - s.start) / 1000);
    // Cada tramo necesita su comentario antes de imputar.
    const comment = String(s.comment || '').trim();
    if (!comment) g.uncommented++;
    else if (!g.comments.includes(comment)) g.comments.push(comment);
  }
  return [...groups.values()].map(g => {
    const sent = submissions.find(x => x.key === g.key);
    const hours = roundHours(g.seconds, rounding);
    return {
      ...g,
      comments: g.comments.join('; '),
      hours,
      include: !sent && hours > 0,
      submitted: sent || null
    };
  }).sort((a, b) => b.seconds - a.seconds);
}

function weekDates(date) {
  const [y, m, d] = date.split('-').map(Number);
  const base = new Date(y, m - 1, d);
  const dow = (base.getDay() + 6) % 7; // lunes = 0
  base.setDate(base.getDate() - dow);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const x = new Date(base);
    x.setDate(base.getDate() + i);
    out.push(localDate(x.getTime()));
  }
  return out;
}

// Resumen del día por tarea (sumando actividades). Las horas son las que se imputarían:
// redondeadas a 0,25 h por tarea y actividad, igual que en la revisión.
function dailySummary(segments, date, rounding) {
  const rows = buildReview(segments, date, { rounding });
  const byIssue = new Map();
  for (const r of rows) {
    const x = byIssue.get(r.issueId) || { issueId: r.issueId, subject: r.subject, project: r.project, seconds: 0, hours: 0, comments: [] };
    x.seconds += r.seconds;
    x.hours = Math.round((x.hours + r.hours) * 100) / 100;
    byIssue.set(r.issueId, x);
  }
  for (const s of segmentsOfDate(segments, date)) {
    const c = String(s.comment || '').trim(), x = byIssue.get(s.issueId);
    if (c && !x.comments.includes(c)) x.comments.push(c);
  }
  const issues = [...byIssue.values()].sort((a, b) => b.seconds - a.seconds);
  return {
    date, issues,
    seconds: issues.reduce((a, b) => a + b.seconds, 0),
    hours: rows.reduce((a, b) => a + b.hours, 0)
  };
}

// Resumen semanal: cada día se calcula como en dailySummary, así las horas coinciden con lo imputable.
function weeklySummary(segments, date, rounding) {
  const days = weekDates(date);
  const byIssue = new Map();
  const totals = {}, totalsHours = {};
  for (const day of days) {
    const d = dailySummary(segments, day, rounding);
    totals[day] = d.seconds;
    totalsHours[day] = d.hours;
    for (const i of d.issues) {
      const x = byIssue.get(i.issueId) || { issueId: i.issueId, subject: i.subject, project: i.project, perDay: {}, perDayHours: {}, seconds: 0, hours: 0 };
      x.perDay[day] = i.seconds;
      x.perDayHours[day] = i.hours;
      x.seconds += i.seconds;
      x.hours = Math.round((x.hours + i.hours) * 100) / 100;
      byIssue.set(i.issueId, x);
    }
  }
  const sum = o => Math.round(Object.values(o).reduce((a, b) => a + b, 0) * 100) / 100;
  return {
    days, totals, totalsHours,
    issues: [...byIssue.values()].sort((a, b) => b.seconds - a.seconds),
    seconds: sum(totals), hours: sum(totalsHours)
  };
}

const hhmm = ts => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// Tramo de tiempo añadido a mano (sin contador). Lanza un Error con el motivo si no es válido.
function manualSegment({ issue, activityId, date, start, hours, comment }, existing = []) {
  if (!issue || !Number.isInteger(Number(issue.id)) || Number(issue.id) <= 0) throw new Error('Elige una tarea válida.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || localDate(new Date(`${date}T12:00:00`).getTime()) !== date) throw new Error('La fecha no es válida.');
  const m = /^(\d{2}):(\d{2})$/.exec(String(start));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('La hora de inicio no es válida.');
  const minutes = Math.round(Number(hours) * 60);
  if (!(minutes > 0 && minutes <= 24 * 60)) throw new Error('Indica las horas (mayor que 0).');
  const text = String(comment || '').trim();
  if (!text) throw new Error('El comentario es obligatorio.');
  const from = new Date(`${date}T${start}:00`).getTime();
  const to = from + minutes * 60_000;
  if (to > startOfNextDay(from)) throw new Error('El tramo debe acabar el mismo día (antes de las 24:00).');
  const clash = existing.find(x => x.start < to && x.end > from);
  if (clash) throw new Error(`Se solapa con otro tramo de ${hhmm(clash.start)} a ${hhmm(clash.end)}.`);
  return {
    issueId: Number(issue.id), subject: String(issue.subject || '').slice(0, 255), project: String(issue.project || '').slice(0, 255),
    activityId: activityId ?? null, start: from, end: to, comment: text.slice(0, 500), manual: true
  };
}

// Hora propuesta para un tramo manual: donde acaba el último tramo del día, o las 09:00.
function suggestStart(segments, date) {
  const last = Math.max(0, ...segmentsOfDate(segments, date).map(s => s.end));
  return last ? hhmm(last) : '09:00';
}

// Filas a enviar a Redmine. De la ventana solo se acepta qué filas se envían, sus horas y
// su actividad (validadas); la tarea y los comentarios salen de los tramos guardados.
function prepareSubmission(rows, truthRows, activityIds) {
  const truth = new Map(truthRows.map(g => [g.key, g]));
  return rows.filter(r => r.include).map(r => {
    const g = truth.get(r.key);
    if (!g) throw new Error('Una de las filas ya no existe: recarga la revisión.');
    const hours = Number(r.hours);
    if (!(hours > 0 && hours <= 24)) throw new Error(`Las horas de #${g.issueId} deben estar entre 0 y 24.`);
    const activityId = Number(r.activityId);
    if (!activityIds.includes(activityId)) throw new Error(`Falta la actividad (o no es válida) en #${g.issueId}.`);
    if (g.uncommented > 0) throw new Error(`Falta el comentario de algún tramo en #${g.issueId}. Complétalo en "Tramos registrados".`);
    return { key: g.key, issueId: g.issueId, hours: Math.round(hours * 100) / 100, activityId, comments: g.comments };
  });
}

// ¿Es `latest` (p. ej. "v0.3.0") una versión estable posterior a `current`?
function isNewer(latest, current) {
  const parse = v => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim())?.slice(1).map(Number);
  const a = parse(latest), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// Tramos de una tarea en un día que todavía no tienen comentario (para pedirlo al parar).
function uncommentedIds(segments, issueId, date) {
  return segmentsOfDate(segments, date)
    .filter(s => s.issueId === issueId && !String(s.comment || '').trim())
    .map(s => s.id);
}

// Horas redondeadas para el contador: total de hoy y grupo (tarea + actividad) en curso,
// contando el tramo abierto. Mismo redondeo que la revisión y la imputación.
function liveHours(segments, current, now, rounding) {
  const all = current
    ? [...segments, { issueId: current.issue.id, activityId: current.activityId, start: current.start, end: now }]
    : segments;
  const rows = buildReview(all, localDate(now), { rounding });
  const key = current ? `${current.issue.id}|${current.activityId ?? ''}` : null;
  return {
    today: Math.round(rows.reduce((a, r) => a + r.hours, 0) * 100) / 100,
    current: rows.find(r => r.key === key)?.hours || 0
  };
}

module.exports = { liveHours, uncommentedIds, isNewer, prepareSubmission, localDate, splitByDay, roundHours, buildReview, weekDates, dailySummary, weeklySummary, segmentsOfDate, manualSegment, suggestStart };
