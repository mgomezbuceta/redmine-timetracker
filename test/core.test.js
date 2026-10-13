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

test('tramo manual: valida y construye el tramo sin contador', () => {
  const issue = { id: 7, subject: 'Informe', project: 'BI' };
  const existing = [{ issueId: 1, start: at('2026-10-01', 9), end: at('2026-10-01', 10, 30) }];
  const s = core.manualSegment({ issue, activityId: 9, date: '2026-10-01', start: '11:00', hours: 1.5, comment: ' Reunión ' }, existing);
  assert.equal(s.start, at('2026-10-01', 11));
  assert.equal(s.end, at('2026-10-01', 12, 30));
  assert.deepEqual([s.issueId, s.subject, s.project, s.activityId, s.comment, s.manual], [7, 'Informe', 'BI', 9, 'Reunión', true]);
  const base = { issue, activityId: 9, date: '2026-10-01', start: '11:00', hours: 1, comment: 'x' };
  assert.throws(() => core.manualSegment({ ...base, comment: '  ' }, existing), /comentario/);
  assert.throws(() => core.manualSegment({ ...base, hours: 0 }, existing), /horas/);
  assert.throws(() => core.manualSegment({ ...base, start: '23:30' }, existing), /mismo día/);
  assert.throws(() => core.manualSegment({ ...base, start: '10:00' }, existing), /Se solapa/);
  assert.throws(() => core.manualSegment({ ...base, issue: { id: 'x' } }, existing), /tarea/);
  assert.throws(() => core.manualSegment({ ...base, date: '2026-13-40' }, existing), /fecha/);
});

test('hora sugerida para un tramo manual: al final del último tramo del día', () => {
  assert.equal(core.suggestStart([], '2026-10-01'), '09:00');
  const segs = [{ start: at('2026-10-01', 9), end: at('2026-10-01', 10, 45) }, { start: at('2026-10-02', 8), end: at('2026-10-02', 18) }];
  assert.equal(core.suggestStart(segs, '2026-10-01'), '10:45');
});

test('envío a Redmine: se reconstruye desde los tramos guardados y se validan horas y actividad', () => {
  const truth = [{ key: '10|9', issueId: 10, activityId: 9, comments: 'Análisis', uncommented: 0 }];
  const ok = core.prepareSubmission([{ key: '10|9', issueId: 999, include: true, hours: 1.5, activityId: 8 }], truth, [8, 9]);
  assert.deepEqual(ok, [{ key: '10|9', issueId: 10, hours: 1.5, activityId: 8, comments: 'Análisis' }]);
  assert.deepEqual(core.prepareSubmission([{ key: '10|9', include: false, hours: 1, activityId: 9 }], truth, [9]), []);
  assert.throws(() => core.prepareSubmission([{ key: 'x|1', include: true, hours: 1, activityId: 9 }], truth, [9]), /no existe/);
  assert.throws(() => core.prepareSubmission([{ key: '10|9', include: true, hours: 30, activityId: 9 }], truth, [9]), /horas/);
  assert.throws(() => core.prepareSubmission([{ key: '10|9', include: true, hours: 1, activityId: 77 }], truth, [9]), /actividad/);
  assert.throws(() => core.prepareSubmission([{ key: '10|9', include: true, hours: 1, activityId: 9 }], [{ ...truth[0], uncommented: 1 }], [9]), /comentario/);
});

test('comparación de versiones para el aviso de actualización', () => {
  assert.equal(core.isNewer('v0.3.0', '0.2.0'), true);
  assert.equal(core.isNewer('0.10.0', '0.9.9'), true);
  assert.equal(core.isNewer('v1.0.0', '0.99.1'), true);
  assert.equal(core.isNewer('v0.2.0', '0.2.0'), false);
  assert.equal(core.isNewer('0.1.9', '0.2.0'), false);
  assert.equal(core.isNewer('basura', '0.2.0'), false);
  assert.equal(core.isNewer('v0.3.0-beta.1', '0.2.0'), false); // las versiones previas no se anuncian
});

test('comentario al parar: tramos del día de esa tarea que aún no tienen comentario', () => {
  const segs = [
    { id: 'a', issueId: 10, start: at('2026-10-01', 9), end: at('2026-10-01', 10), comment: 'Hecho' },
    { id: 'b', issueId: 10, start: at('2026-10-01', 11), end: at('2026-10-01', 12) },
    { id: 'c', issueId: 10, start: at('2026-10-01', 13), end: at('2026-10-01', 14), comment: '  ' },
    { id: 'd', issueId: 11, start: at('2026-10-01', 15), end: at('2026-10-01', 16) },
    { id: 'e', issueId: 10, start: at('2026-09-30', 9), end: at('2026-09-30', 10) }
  ];
  assert.deepEqual(core.uncommentedIds(segs, 10, '2026-10-01'), ['b', 'c']);
  assert.deepEqual(core.uncommentedIds(segs, 12, '2026-10-01'), []);
});

test('resúmenes: horas redondeadas a 0,25 como se imputan, proyecto y comentarios', () => {
  const segs = [
    { issueId: 10, subject: 'A', project: 'Web', activityId: 9, start: at('2026-10-01', 9), end: at('2026-10-01', 9, 20), comment: 'Análisis' },
    { issueId: 10, subject: 'A', project: 'Web', activityId: 8, start: at('2026-10-01', 10), end: at('2026-10-01', 10, 20), comment: ' Pruebas ' },
    { issueId: 10, subject: 'A', project: 'Web', activityId: 8, start: at('2026-10-01', 11), end: at('2026-10-01', 11, 5), comment: 'Pruebas' },
    { issueId: 11, subject: 'B', project: 'BI', activityId: 9, start: at('2026-10-02', 9), end: at('2026-10-02', 10, 10) }
  ];
  const d = core.dailySummary(segs, '2026-10-01');
  // 20 min (act. 9) -> 0,25 h y 25 min (act. 8) -> 0,5 h: se imputan 0,75 h, no round(45 min).
  assert.deepEqual(d.issues.map(i => [i.issueId, i.project, i.hours, i.comments]), [[10, 'Web', 0.75, ['Análisis', 'Pruebas']]]);
  assert.equal(d.hours, 0.75);
  const w = core.weeklySummary(segs, '2026-10-01');
  const a = w.issues.find(i => i.issueId === 10), b = w.issues.find(i => i.issueId === 11);
  assert.equal(a.project, 'Web');
  assert.equal(a.perDayHours['2026-10-01'], 0.75);
  assert.equal(a.hours, 0.75);
  assert.equal(b.perDayHours['2026-10-02'], 1.25);
  assert.deepEqual([w.totalsHours['2026-10-01'], w.totalsHours['2026-10-02'], w.hours], [0.75, 1.25, 2]);
});
