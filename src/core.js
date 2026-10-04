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

function dailySummary(segments, date, rounding) {
  const rows = buildReview(segments, date, { rounding });
  // Resumen por issue (sumando actividades)
  const byIssue = new Map();
  for (const r of rows) {
    const x = byIssue.get(r.issueId) || { issueId: r.issueId, subject: r.subject, project: r.project, seconds: 0 };
    x.seconds += r.seconds;
    byIssue.set(r.issueId, x);
  }
  const issues = [...byIssue.values()].map(x => ({ ...x, hours: roundHours(x.seconds, rounding) }))
    .sort((a, b) => b.seconds - a.seconds);
  const seconds = issues.reduce((a, b) => a + b.seconds, 0);
  return { date, issues, seconds, hours: rows.reduce((a, b) => a + b.hours, 0) };
}

function weeklySummary(segments, date, rounding) {
  const days = weekDates(date);
  const byIssue = new Map();
  const totals = Object.fromEntries(days.map(d => [d, 0]));
  for (const day of days) {
    for (const s of segmentsOfDate(segments, day)) {
      const sec = (s.end - s.start) / 1000;
      const x = byIssue.get(s.issueId) || { issueId: s.issueId, subject: s.subject, project: s.project, perDay: {}, seconds: 0 };
      x.perDay[day] = (x.perDay[day] || 0) + sec;
      x.seconds += sec;
      byIssue.set(s.issueId, x);
      totals[day] += sec;
    }
  }
  const issues = [...byIssue.values()].map(x => ({ ...x, hours: roundHours(x.seconds, rounding) }))
    .sort((a, b) => b.seconds - a.seconds);
  return { days, issues, totals, seconds: Object.values(totals).reduce((a, b) => a + b, 0) };
}

module.exports = { localDate, splitByDay, roundHours, buildReview, weekDates, dailySummary, weeklySummary, segmentsOfDate };
