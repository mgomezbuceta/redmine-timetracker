const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { RedmineClient } = require('../src/redmine');

function mockServer() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, key: req.headers['x-redmine-api-key'], body: body && JSON.parse(body) });
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/redmine/issues/42.json') return send(200, { issue: { id: 42, subject: 'Arreglar login', project: { name: 'Web' }, status: { name: 'Nueva' } } });
      if (u.pathname === '/redmine/projects.json') {
        const v = u.searchParams.get('v[id][]');
        if (u.searchParams.get('v[status][]') !== '1') return send(400, {});
        if (v === 'bookmarks') return send(200, { projects: [{ id: 2, name: 'Zeta' }, { id: 1, name: 'Alfa' }] });
        if (v === 'mine') return send(200, { projects: [{ id: 1, name: 'Alfa' }, { id: 3, name: 'Beta' }] });
      }
      if (u.pathname === '/redmine/issues.json' && u.searchParams.get('v[issue_id][]') === '42') return send(200, { issues: [{ id: 42, subject: 'Arreglar login', project: { name: 'Web' }, status: { name: 'Nueva' } }] });
      if (u.pathname === '/redmine/issues.json' && u.searchParams.get('v[issue_id][]') === '3') return send(200, { issues: [{ id: 3, subject: 'Épica', project: { name: 'BI' }, status: { name: 'Nueva' } }] });
      if (u.pathname === '/redmine/issues.json') return send(200, { issues: [{ id: 7, subject: 'Informe', project: { name: 'BI' }, status: { name: 'En curso' }, parent: { id: 3 } }] });
      if (u.pathname === '/redmine/enumerations/time_entry_activities.json') return send(200, { time_entry_activities: [{ id: 9, name: 'Desarrollo' }, { id: 10, name: 'Vieja', active: false }] });
      if (u.pathname === '/redmine/time_entries.json' && req.method === 'POST') {
        if (!JSON.parse(body).time_entry.activity_id) return send(422, { errors: ['Activity cannot be blank'] });
        return send(201, { time_entry: { id: 555 } });
      }
      send(404, {});
    });
  });
  return new Promise(r => srv.listen(0, () => r({ srv, calls, url: `http://127.0.0.1:${srv.address().port}/redmine` })));
}

test('cliente Redmine contra servidor simulado', async () => {
  const { srv, calls, url } = await mockServer();
  try {
    const c = new RedmineClient({ url, apiKey: 'k' });
    assert.deepEqual(await c.searchIssues('#42'), [{ id: 42, subject: 'Arreglar login', project: 'Web', status: 'Nueva', parentId: null }]);
    // Missing ancestors are fetched so the UI can keep the issue tree.
    assert.deepEqual(await c.searchIssues('infor'), [
      { id: 7, subject: 'Informe', project: 'BI', status: 'En curso', parentId: 3 },
      { id: 3, subject: 'Épica', project: 'BI', status: 'Nueva', parentId: null, context: true }
    ]);
    const q = new URL(calls.at(-2).url, 'http://x').searchParams;
    // Only bookmarked ("favoritos") projects, using the f[]/op/v query syntax.
    assert.deepEqual(q.getAll('f[]').sort(), ['project.status', 'project_id', 'status_id', 'subject']);
    assert.equal(q.get('op[project_id]'), '=');
    assert.equal(q.get('v[project_id][]'), 'bookmarks');
    assert.equal(q.get('op[subject]'), '~');
    assert.equal(q.get('v[subject][]'), 'infor');
    assert.equal(q.get('op[status_id]'), 'o');
    await c.searchIssues('');
    const mine = new URL(calls.at(-2).url, 'http://x').searchParams;
    assert.equal(mine.get('v[assigned_to_id][]'), 'me');
    assert.equal(mine.get('v[project_id][]'), 'bookmarks');
    // Issues of closed projects are never shown: every issue query filters by active project.
    const issueQueries = calls.filter(x => x.url.includes('/issues.json'));
    assert.ok(issueQueries.length >= 3);
    for (const x of issueQueries) assert.equal(new URL(x.url, 'http://x').searchParams.get('v[project.status][]'), '1', x.url);
    await c.searchIssues('x', { projectId: 3 });
    assert.equal(new URL(calls.at(-2).url, 'http://x').searchParams.get('v[project_id][]'), '3');
    // Project filter: active bookmarked (first) + active member projects, no duplicates.
    assert.deepEqual(await c.projects(), [
      { id: 1, name: 'Alfa', bookmarked: true },
      { id: 2, name: 'Zeta', bookmarked: true },
      { id: 3, name: 'Beta', bookmarked: false }
    ]);
    assert.equal((await c.activities()).length, 1);
    const te = await c.createTimeEntry({ issueId: 42, date: '2026-10-03', hours: 1.5, activityId: 9, comments: 'x' });
    assert.equal(te.id, 555);
    assert.deepEqual(calls.at(-1).body, { time_entry: { issue_id: 42, spent_on: '2026-10-03', hours: 1.5, activity_id: 9, comments: 'x' } });
    assert.ok(calls.every(x => x.key === 'k'));
    await assert.rejects(c.createTimeEntry({ issueId: 42, date: '2026-10-03', hours: 1 }), /rechazado los datos: Activity cannot be blank/);
  } finally { srv.close(); }
});

test('solo HTTPS (salvo en local): la API key nunca viaja en claro', () => {
  assert.throws(() => new RedmineClient({ url: 'http://redmine.example.com', apiKey: 'k' }), /https/);
  assert.throws(() => new RedmineClient({ url: 'ftp://redmine.example.com', apiKey: 'k' }), /https/);
  assert.ok(new RedmineClient({ url: 'https://redmine.example.com', apiKey: 'k' }));
  assert.ok(new RedmineClient({ url: 'http://localhost:3000', apiKey: 'k' }));
  assert.ok(new RedmineClient({ url: 'http://127.0.0.1:3000/redmine', apiKey: 'k' }));
});

test('respuestas demasiado grandes se cortan', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end(Buffer.alloc(11 * 1024 * 1024, 32)); });
  await new Promise(r => srv.listen(0, r));
  try {
    const c = new RedmineClient({ url: `http://127.0.0.1:${srv.address().port}`, apiKey: 'k' });
    await assert.rejects(c.request('GET', '/x.json'), /demasiado grande/);
  } finally { srv.close(); }
});

test('confía en las CAs del almacén del sistema (Windows, macOS y Linux)', { skip: !require('tls').getCACertificates && 'Node sin getCACertificates' }, () => {
  const { buildCaList } = require('../src/redmine');
  const list = new Set(buildCaList(null));
  for (const pem of require('tls').getCACertificates('system')) assert.ok(list.has(pem));
});
