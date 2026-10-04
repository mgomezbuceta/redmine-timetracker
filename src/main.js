const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, powerMonitor, safeStorage, nativeImage, screen, nativeTheme, shell, session
} = require('electron');
const path = require('path');
const https = require('https');
const { JsonFile } = require('./store');
const { RedmineClient } = require('./redmine');
const { createKeyStore } = require('./secret');
const { getIdleSeconds } = require('./idle');
const core = require('./core');

// En Wayland una ventana no puede ponerse "siempre encima" ni recordar posición:
// forzamos XWayland. (El script npm start ya pasa el flag; esto cubre otros arranques.)
if (process.platform === 'linux' && !app.commandLine.hasSwitch('ozone-platform')) {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

// Mismo nombre en desarrollo (npm start) y en los instaladores (que usan productName):
// así comparten ~/.config/redmine-timetracker y la entrada del llavero de la API key.
app.setName('redmine-timetracker');

if (!app.requestSingleInstanceLock()) app.quit();

// Únicos enlaces externos que la interfaz puede abrir (en el navegador del sistema).
const REPO = 'https://github.com/mgomezbuceta/redmine-timetracker';
const LINKS = {
  repo: REPO,
  releases: `${REPO}/releases`,
  issues: `${REPO}/issues`,
  license: `${REPO}/blob/main/LICENSE`,
  author: 'https://github.com/mgomezbuceta'
};

const WIDGET_W = 380, WIDGET_H = 56, WIDGET_H_PROMPT = 112;
const HEARTBEAT_MS = 30_000, IDLE_POLL_MS = 15_000;

let settings, data, keys, tray, widgetWin, panelWin;
let idlePrompt = null; // { idleStart, issue, activityId }
let update = null; // { version } si hay una versión publicada más nueva

// ---------- settings / datos ----------

function loadStores() {
  const dir = app.getPath('userData');
  settings = new JsonFile(path.join(dir, 'settings.json'), {
    url: '',
    apiKeyEnc: null,
    apiKeyPlain: null,
    caPath: '',
    defaultActivityId: null,
    idleMinutes: 5,
    rounding: 'nearest',
    onlyOpen: true,
    writeEnabled: false,
    checkUpdates: true,
    dismissedUpdate: null,
    widgetPos: null
  });
  keys = createKeyStore(safeStorage, settings.data);
  if (keys.migrate()) settings.save(); // clave antigua en claro → cifrada
  data = new JsonFile(path.join(dir, 'data.json'), {
    segments: [],
    current: null,
    lastIssue: null,
    lastActivityId: null,
    recent: [],
    activities: [],
    submissions: {}
  });
}

function getApiKey() {
  return keys.get();
}

function client() {
  return new RedmineClient({ url: settings.data.url, apiKey: getApiKey(), caPath: settings.data.caPath || null });
}

function isConfigured() {
  return Boolean(settings.data.url && getApiKey());
}

function activityName(id) {
  return data.data.activities.find(a => a.id === id)?.name || '';
}

// ---------- aviso de versión nueva ----------

// Última release publicada en GitHub (solo se lee su etiqueta; nunca se descarga nada).
function latestReleaseTag() {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://api.github.com/repos/mgomezbuceta/redmine-timetracker/releases/latest`, {
      headers: { 'User-Agent': 'redmine-timetracker', Accept: 'application/vnd.github+json' }, timeout: 10_000
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; if (body.length > 1_000_000) req.destroy(new Error('Respuesta demasiado grande')); });
      res.on('end', () => { try { resolve(JSON.parse(body).tag_name); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function checkForUpdate() {
  const tag = await latestReleaseTag();
  update = core.isNewer(tag, app.getVersion()) ? { version: String(tag).replace(/^v/, '') } : null;
  pushState();
  return update;
}

function pendingUpdate() {
  return update && update.version !== settings.data.dismissedUpdate ? update : null;
}

// ---------- temporizador ----------

function addSegment(issue, activityId, start, end) {
  if (end - start < 1000) return;
  for (const s of core.splitByDay({ issueId: issue.id, subject: issue.subject, project: issue.project, activityId, start, end })) {
    data.data.segments.push({ id: `${s.start}-${s.issueId}`, ...s });
  }
}

function rememberRecent(issue) {
  const r = data.data.recent.filter(i => i.id !== issue.id);
  r.unshift(issue);
  data.data.recent = r.slice(0, 15);
}

function startTimer(issue, activityId, at = Date.now()) {
  stopTimer(at);
  idlePrompt = null;
  activityId = activityId ?? settings.data.defaultActivityId ?? null;
  data.data.current = { issue, activityId, start: at, heartbeat: at };
  data.data.lastIssue = issue;
  data.data.lastActivityId = activityId;
  rememberRecent(issue);
  data.save();
  pushState();
}

function stopTimer(at = Date.now()) {
  const c = data.data.current;
  if (!c) return;
  addSegment(c.issue, c.activityId, c.start, at);
  data.data.current = null;
  data.save();
  pushState();
}

function pauseForIdle(idleStart) {
  const c = data.data.current;
  if (!c) return;
  stopTimer(idleStart);
  idlePrompt = { idleStart, issue: c.issue, activityId: c.activityId };
  pushState();
}

function resolveIdle(choice) {
  if (!idlePrompt) return;
  const { idleStart, issue, activityId } = idlePrompt;
  const now = Date.now();
  idlePrompt = null;
  if (choice === 'keep') {
    addSegment(issue, activityId, idleStart, now);
    startTimer(issue, activityId, now);
  } else if (choice === 'discard') {
    startTimer(issue, activityId, now);
  } else {
    data.save();
    pushState();
  }
}

async function idleTick() {
  const c = data.data.current;
  if (!c) return;
  const idle = await getIdleSeconds(powerMonitor);
  if (idle >= settings.data.idleMinutes * 60) pauseForIdle(Date.now() - idle * 1000);
}

function heartbeat() {
  if (!data.data.current) return;
  data.data.current.heartbeat = Date.now();
  data.save();
}

// Si la app se cerró de golpe con un temporizador activo, se corta en el último latido
// y se pregunta qué hacer con el hueco.
function recoverFromCrash() {
  const c = data.data.current;
  if (!c) return;
  addSegment(c.issue, c.activityId, c.start, c.heartbeat);
  data.data.current = null;
  idlePrompt = { idleStart: c.heartbeat, issue: c.issue, activityId: c.activityId };
  data.save();
}

// ---------- ventanas ----------

function todaySeconds() {
  const today = core.localDate(Date.now());
  let s = core.segmentsOfDate(data.data.segments, today).reduce((a, x) => a + (x.end - x.start) / 1000, 0);
  if (data.data.current) s += (Date.now() - data.data.current.start) / 1000;
  return s;
}

function stateSnapshot() {
  const c = data.data.current;
  return {
    current: c ? { ...c, activityName: activityName(c.activityId) } : null,
    idlePrompt: idlePrompt ? { ...idlePrompt, minutes: Math.round((Date.now() - idlePrompt.idleStart) / 60000) } : null,
    lastIssue: data.data.lastIssue,
    todayBaseSeconds: todaySeconds() - (c ? (Date.now() - c.start) / 1000 : 0),
    configured: isConfigured(),
    writeEnabled: settings.data.writeEnabled,
    update: pendingUpdate()
  };
}

function pushState() {
  const st = stateSnapshot();
  for (const w of [widgetWin, panelWin]) if (w && !w.isDestroyed()) w.webContents.send('state', st);
  if (widgetWin && !widgetWin.isDestroyed()) {
    const [x, y] = widgetWin.getPosition();
    widgetWin.setBounds({ x, y, width: WIDGET_W, height: idlePrompt ? WIDGET_H_PROMPT : WIDGET_H });
  }
  updateTray();
}

const webPrefs = {
  preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
  devTools: !app.isPackaged // sin herramientas de desarrollador en la versión instalada
};

function createWidget() {
  const area = screen.getPrimaryDisplay().workArea;
  const pos = settings.data.widgetPos || { x: area.x + area.width - WIDGET_W - 24, y: area.y + 24 };
  widgetWin = new BrowserWindow({
    x: pos.x, y: pos.y, width: WIDGET_W, height: WIDGET_H,
    frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false,
    webPreferences: webPrefs
  });
  widgetWin.setAlwaysOnTop(true, 'floating');
  widgetWin.setVisibleOnAllWorkspaces(true);
  widgetWin.loadFile(path.join(__dirname, '../renderer/widget.html'));
  widgetWin.once('ready-to-show', () => widgetWin.showInactive());
  let t;
  widgetWin.on('move', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const [x, y] = widgetWin.getPosition();
      settings.data.widgetPos = { x, y };
      settings.save();
    }, 500);
  });
}

function openPanel(tab = 'tasks') {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.show(); panelWin.focus();
    panelWin.webContents.send('tab', tab);
    return;
  }
  panelWin = new BrowserWindow({
    width: 1060, height: 720, minWidth: 820, minHeight: 520,
    title: 'Timetracker Redmine', autoHideMenuBar: true, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15171c' : '#f4f5f7',
    webPreferences: webPrefs
  });
  panelWin.loadFile(path.join(__dirname, '../renderer/panel.html'), { query: { tab } });
  panelWin.once('ready-to-show', () => panelWin.show());
}

function trayIcon(running) {
  return nativeImage.createFromPath(path.join(__dirname, `../assets/tray-${running ? 'on' : 'off'}.png`));
}

function updateTray() {
  if (!tray) return;
  const c = data.data.current;
  tray.setImage(trayIcon(Boolean(c)));
  tray.setToolTip(c ? `#${c.issue.id} ${c.issue.subject}` : 'Timetracker parado');
  tray.setContextMenu(buildMenu());
}

function buildMenu() {
  const c = data.data.current;
  const last = data.data.lastIssue;
  const upd = pendingUpdate();
  return Menu.buildFromTemplate([
    ...(upd ? [{ label: `⬆ Nueva versión ${upd.version} disponible`, click: () => shell.openExternal(LINKS.releases) }, { type: 'separator' }] : []),
    c ? { label: `Parar #${c.issue.id}`, click: () => stopTimer() }
      : { label: last ? `Reanudar #${last.id}` : 'Reanudar', enabled: Boolean(last), click: () => startTimer(last, data.data.lastActivityId) },
    { type: 'separator' },
    { label: 'Buscar tarea…', click: () => openPanel('tasks') },
    { label: 'Revisión del día', click: () => openPanel('review') },
    { label: 'Resúmenes', click: () => openPanel('summary') },
    { label: 'Ajustes', click: () => openPanel('settings') },
    { label: 'Acerca de', click: () => openPanel('about') },
    { type: 'separator' },
    { label: 'Mostrar/ocultar widget', click: () => widgetWin.isVisible() ? widgetWin.hide() : widgetWin.showInactive() },
    { label: 'Salir', click: () => { stopTimer(); app.exit(0); } }
  ]);
}

// ---------- IPC ----------

function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
}

function registerIpc() {
  handle('state:get', () => stateSnapshot());
  handle('timer:start', (issue, activityId) => startTimer(issue, activityId));
  handle('timer:stop', () => stopTimer());
  handle('timer:toggle', () => {
    if (data.data.current) return stopTimer();
    if (idlePrompt) return resolveIdle('discard');
    if (data.data.lastIssue) return startTimer(data.data.lastIssue, data.data.lastActivityId);
    openPanel('tasks');
  });
  handle('timer:setActivity', activityId => {
    const c = data.data.current;
    if (!c || c.activityId === activityId) return;
    const now = Date.now();
    addSegment(c.issue, c.activityId, c.start, now);
    data.data.current = { ...c, activityId, start: now, heartbeat: now };
    data.data.lastActivityId = activityId;
    data.save(); pushState();
  });
  handle('idle:resolve', choice => resolveIdle(choice));
  handle('panel:open', tab => openPanel(tab));
  handle('widget:menu', () => buildMenu().popup({ window: widgetWin }));

  handle('issues:search', async (q, projectId) => {
    const issues = await client().searchIssues(q, { onlyOpen: settings.data.onlyOpen, projectId: Number(projectId) || null });
    return issues;
  });
  // Filtro de proyectos (favoritos + en los que participo, solo activos). Sin conexión: última lista conocida.
  handle('projects:list', async () => {
    try {
      data.data.projects = await client().projects();
      data.save();
    } catch (err) {
      if (!data.data.projects) throw err;
    }
    return data.data.projects;
  });
  // Recientes sin las de proyectos cerrados. Sin conexión se muestra la lista local tal cual.
  handle('issues:recent', async () => {
    const recent = data.data.recent;
    if (!recent.length || !isConfigured()) return recent;
    try {
      const active = new Set((await client().findIssues([['issue_id', '=', recent.map(i => i.id).join(',')], ['status_id', '*']])).map(i => i.id));
      return recent.filter(i => active.has(i.id));
    } catch {
      return recent;
    }
  });
  handle('activities:get', () => data.data.activities);
  handle('activities:refresh', async () => {
    data.data.activities = await client().activities();
    data.save();
    return data.data.activities;
  });

  handle('review:get', date => ({
    rows: core.buildReview(data.data.segments, date, {
      rounding: settings.data.rounding, submissions: data.data.submissions[date] || []
    }),
    segments: core.segmentsOfDate(data.data.segments, date).sort((a, b) => a.start - b.start),
    writeEnabled: settings.data.writeEnabled
  }));
  handle('segments:delete', id => {
    data.data.segments = data.data.segments.filter(s => s.id !== id);
    data.save(); pushState();
  });
  // Tiempo añadido a mano, sin contador. Pasa por la revisión como cualquier otro tramo.
  handle('segments:addManual', entry => {
    const busy = [...data.data.segments];
    if (data.data.current) busy.push({ start: data.data.current.start, end: Date.now() }); // contador en marcha
    const seg = core.manualSegment(entry, busy);
    data.data.segments.push({ id: `${seg.start}-${seg.issueId}-m`, ...seg });
    rememberRecent({ id: seg.issueId, subject: seg.subject, project: seg.project });
    data.save(); pushState();
    return seg;
  });
  handle('segments:suggestStart', date => core.suggestStart(data.data.segments, date));
  handle('segments:setComment', (id, comment) => {
    const s = data.data.segments.find(x => x.id === id);
    if (!s) throw new Error('Tramo no encontrado');
    s.comment = String(comment || '').trim().slice(0, 500);
    data.save();
    return s.comment;
  });
  handle('segments:setActivity', (id, activityId) => {
    const s = data.data.segments.find(x => x.id === id);
    if (s) { s.activityId = activityId; data.save(); }
  });
  handle('review:submit', async (date, rows) => {
    if (!settings.data.writeEnabled) throw new Error('La escritura en Redmine está desactivada en Ajustes.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('Fecha no válida.');
    // Tarea y comentarios salen de los tramos guardados; horas y actividad se validan.
    rows = core.prepareSubmission(Array.isArray(rows) ? rows : [], core.buildReview(data.data.segments, date),
      data.data.activities.map(a => a.id));
    if (!rows.length) throw new Error('No hay filas marcadas para enviar.');
    const total = rows.reduce((a, r) => a + r.hours, 0);
    const { response } = await dialog.showMessageBox(panelWin, {
      type: 'question', buttons: ['Cancelar', 'Enviar'], defaultId: 0, cancelId: 0,
      message: `¿Imputar ${total} h en ${rows.length} entradas para el ${date}?`,
      detail: rows.map(r => `#${r.issueId}  ${r.hours} h  ${activityName(r.activityId)}`).join('\n')
    });
    if (response !== 1) return { cancelled: true };
    const results = [];
    const subs = (data.data.submissions[date] ||= []);
    const c = client();
    for (const r of rows) {
      if (subs.some(s => s.key === r.key)) { results.push({ key: r.key, ok: false, error: 'Ya enviada' }); continue; }
      try {
        const te = await c.createTimeEntry({ issueId: r.issueId, date, hours: r.hours, activityId: r.activityId, comments: r.comments });
        subs.push({ key: r.key, issueId: r.issueId, activityId: r.activityId, hours: r.hours, timeEntryId: te?.id ?? null, at: Date.now() });
        data.save();
        results.push({ key: r.key, ok: true, id: te?.id });
      } catch (err) {
        results.push({ key: r.key, ok: false, error: err.message });
      }
    }
    return { results };
  });

  handle('summary:get', date => ({
    daily: core.dailySummary(data.data.segments, date, settings.data.rounding),
    weekly: core.weeklySummary(data.data.segments, date, settings.data.rounding)
  }));

  handle('settings:get', () => {
    const { apiKeyEnc, apiKeyPlain, widgetPos, ...rest } = settings.data;
    return { ...rest, ...keys.status() };
  });
  handle('settings:save', s => {
    if (s.url) RedmineClient.checkUrl(String(s.url)); // solo https
    if (s.apiKey) keys.set(s.apiKey); // valida y cifra antes de tocar nada más
    const allowed = ['url', 'caPath', 'defaultActivityId', 'idleMinutes', 'rounding', 'onlyOpen', 'writeEnabled', 'checkUpdates'];
    for (const k of allowed) if (k in s) settings.data[k] = s[k];
    settings.data.idleMinutes = Math.max(1, Number(settings.data.idleMinutes) || 5);
    settings.save();
    pushState();
  });
  handle('settings:clearKey', () => {
    keys.clear();
    settings.save();
    pushState();
  });
  handle('settings:test', async () => {
    const u = await client().currentUser();
    data.data.activities = await client().activities();
    data.save();
    return { user: `${u.firstname} ${u.lastname} (${u.login})`, activities: data.data.activities.length };
  });
  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`
  }));
  handle('update:check', async () => {
    await checkForUpdate();
    return { current: app.getVersion(), latest: update?.version || null };
  });
  handle('update:dismiss', () => {
    settings.data.dismissedUpdate = update?.version || null;
    settings.save();
    pushState();
  });
  handle('app:open', key => {
    if (!Object.hasOwn(LINKS, key)) throw new Error('Enlace no permitido');
    return shell.openExternal(LINKS[key]);
  });
  handle('settings:pickCa', async () => {
    const r = await dialog.showOpenDialog(panelWin, { properties: ['openFile'], filters: [{ name: 'Certificados', extensions: ['crt', 'pem', 'cer'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
}

// ---------- arranque ----------

app.on('second-instance', () => openPanel('tasks'));

// Las ventanas solo muestran los ficheros locales de la app: ni navegan a otra
// página ni abren ventanas nuevas (los enlaces externos pasan por 'app:open').
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', e => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
});
app.on('window-all-closed', e => e.preventDefault?.());

app.whenReady().then(() => {
  // La app no usa cámara, micrófono, notificaciones ni ningún otro permiso del navegador.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  loadStores();
  recoverFromCrash();
  registerIpc();
  createWidget();
  try {
    tray = new Tray(trayIcon(false));
    tray.on('click', () => openPanel('tasks'));
  } catch { tray = null; } // sin soporte de bandeja: el widget tiene su propio menú
  updateTray();

  powerMonitor.on('suspend', () => pauseForIdle(Date.now()));
  powerMonitor.on('lock-screen', () => pauseForIdle(Date.now()));
  setInterval(idleTick, IDLE_POLL_MS);
  setInterval(heartbeat, HEARTBEAT_MS);
  setInterval(pushState, 60_000); // refresca minutos de inactividad en el aviso

  // Aviso de versión nueva: al poco de arrancar y cada 6 h (se puede desactivar en Ajustes).
  const autoCheck = () => { if (settings.data.checkUpdates) checkForUpdate().catch(() => {}); };
  setTimeout(autoCheck, 15_000);
  setInterval(autoCheck, 6 * 3600_000);

  if (!isConfigured()) openPanel('settings');
  else if (!data.data.activities.length) client().activities().then(a => { data.data.activities = a; data.save(); }).catch(() => {});
});

app.on('before-quit', () => stopTimer());
