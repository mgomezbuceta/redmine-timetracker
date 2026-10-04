const test = require('node:test');
const assert = require('node:assert');
const core = require('../src/core');

const at = (d, h, m = 0) => new Date(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`).getTime();

test('redondeo a 0,25 h', () => {
  assert.equal(core.roundHours(7 * 60), 0);         // 7 min -> 0
  assert.equal(core.roundHours(8 * 60), 0.25);      // 8 min -> 0.25
  assert.equal(core.roundHours(50 * 60), 0.75);
  assert.equal(core.roundHours(53 * 60), 1);
  assert.equal(core.roundHours(1 * 60, 'up'), 0.25);
  assert.equal(core.roundHours(15 * 60, 'up'), 0.25);
  assert.equal(core.roundHours(0, 'up'), 0);
});

test('parte segmentos que cruzan medianoche', () => {
  const segs = core.splitByDay({ issueId: 1, start: at('2026-10-01', 23), end: at('2026-10-02', 1) });
  assert.equal(segs.length, 2);
  assert.equal(core.localDate(segs[0].start), '2026-10-01');
  assert.equal(core.localDate(segs[1].start), '2026-10-02');
  assert.equal((segs[0].end - segs[0].start) / 3600e3, 1);
});

test('revisión agrupa por issue+actividad y marca enviadas', () => {
  const segs = [
    { issueId: 10, subject: 'A', activityId: 9, start: at('2026-10-01', 9), end: at('2026-10-01', 10) },
    { issueId: 10, subject: 'A', activityId: 9, start: at('2026-10-01', 11), end: at('2026-10-01', 11, 20) },
    { issueId: 10, subject: 'A', activityId: 8, start: at('2026-10-01', 12), end: at('2026-10-01', 12, 30) },
    { issueId: 11, subject: 'B', activityId: 9, start: at('2026-10-02', 9), end: at('2026-10-02', 10) }
  ];
  const rows = core.buildReview(segs, '2026-10-01', { submissions: [{ key: '10|8' }] });
  assert.equal(rows.length, 2);
  const a = rows.find(r => r.key === '10|9');
  assert.equal(a.hours, 1.25);
  assert.equal(a.include, true);
  const b = rows.find(r => r.key === '10|8');
  assert.ok(b.submitted);
  assert.equal(b.include, false);
});

test('semana de lunes a domingo', () => {
  const w = core.weekDates('2026-10-03'); // sábado
  assert.equal(w[0], '2026-09-28');
  assert.equal(w[6], '2026-10-04');
});

test('resumen semanal suma por día', () => {
  const segs = [
    { issueId: 1, subject: 'A', start: at('2026-09-28', 9), end: at('2026-09-28', 11) },
    { issueId: 1, subject: 'A', start: at('2026-09-30', 9), end: at('2026-09-30', 10) },
    { issueId: 2, subject: 'B', start: at('2026-10-05', 9), end: at('2026-10-05', 10) } // otra semana
  ];
  const w = core.weeklySummary(segs, '2026-10-01');
  assert.equal(w.issues.length, 1);
  assert.equal(w.seconds, 3 * 3600);
  assert.equal(w.totals['2026-09-28'], 7200);
});

test('revisión: comentario por tramo y recuento de tramos sin comentario', () => {
  const segs = [
    { issueId: 10, activityId: 9, start: at('2026-10-01', 9), end: at('2026-10-01', 10), comment: ' Análisis ' },
    { issueId: 10, activityId: 9, start: at('2026-10-01', 11), end: at('2026-10-01', 12), comment: '   ' },
    { issueId: 10, activityId: 9, start: at('2026-10-01', 13), end: at('2026-10-01', 14), comment: 'Pruebas' },
    { issueId: 11, activityId: 9, start: at('2026-10-01', 15), end: at('2026-10-01', 16), comment: 'Reunión' }
  ];
  const [a, b] = core.buildReview(segs, '2026-10-01');
  assert.equal(a.issueId, 10);
  assert.equal(a.comments, 'Análisis; Pruebas');
  assert.equal(a.uncommented, 1);
  assert.equal(b.uncommented, 0);
});
