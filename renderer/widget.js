const $ = id => document.getElementById(id);
let state = null;

const fmt = (sec, withSec = true) => {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  const mm = String(m).padStart(2, '0');
  return withSec ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${h}:${mm}`;
};

function render() {
  if (!state) return;
  const c = state.current;
  const running = (c ? (Date.now() - c.start) / 1000 : 0);
  $('timer').textContent = fmt(running);
  $('today').textContent = 'hoy ' + fmt(state.todayBaseSeconds + running, false);
  $('toggle').textContent = c ? '■' : '▶';
  $('toggle').className = 'btn ' + (c ? 'stop' : 'play');
  if (c) {
    $('title').textContent = `#${c.issue.id} ${c.issue.subject}`;
    $('sub').textContent = [c.issue.project, c.activityName || 'sin actividad'].filter(Boolean).join(' · ');
  } else if (state.lastIssue) {
    $('title').textContent = `#${state.lastIssue.id} ${state.lastIssue.subject}`;
    $('sub').textContent = 'Parado · ▶ para reanudar';
  } else {
    $('title').textContent = 'Sin tarea';
    $('sub').textContent = state.configured ? 'Pulsa aquí para buscar una tarea' : 'Configura Redmine en Ajustes';
  }
  const p = state.idlePrompt;
  $('prompt').classList.toggle('hidden', !p);
  if (p) $('promptText').textContent = `Inactivo ${p.minutes} min en #${p.issue.id}. ¿Qué hago con ese tiempo?`;
  // Comentario del trabajo recién parado: se enfoca solo al aparecer, para no robar el foco cada segundo.
  const cp = state.commentPrompt;
  const wasHidden = $('comment').classList.contains('hidden');
  $('comment').classList.toggle('hidden', !cp);
  if (cp && wasHidden) {
    $('commentText').value = '';
    $('commentText').placeholder = `¿Qué has hecho en #${cp.issue.id}?`;
    $('commentText').focus();
  }
}

tt.on('state', s => { state = s; render(); });
tt.call('state:get').then(s => { state = s; render(); });
setInterval(render, 1000);

$('toggle').onclick = () => tt.call('timer:toggle');
$('task').onclick = () => tt.call('panel:open', 'tasks');
$('menu').onclick = () => tt.call('widget:menu');
document.querySelectorAll('#prompt button').forEach(b => (b.onclick = () => tt.call('idle:resolve', b.dataset.c)));
$('comment').onsubmit = e => {
  e.preventDefault();
  if ($('commentText').value.trim()) tt.call('comment:save', $('commentText').value);
};
$('commentSkip').onclick = () => tt.call('comment:skip');
$('commentText').onkeydown = e => { if (e.key === 'Escape') tt.call('comment:skip'); };
