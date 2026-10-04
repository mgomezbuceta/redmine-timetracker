// Segundos de inactividad. En GNOME (Wayland o X11) se pregunta a Mutter por D-Bus,
// que es fiable; si no está disponible se usa el powerMonitor de Electron.
const { execFile } = require('child_process');

let mutterOk = true;

function mutterIdle() {
  return new Promise(resolve => {
    execFile('gdbus', [
      'call', '--session',
      '--dest', 'org.gnome.Mutter.IdleMonitor',
      '--object-path', '/org/gnome/Mutter/IdleMonitor/Core',
      '--method', 'org.gnome.Mutter.IdleMonitor.GetIdletime'
    ], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /uint64\s+(\d+)/.exec(stdout);
      resolve(m ? Math.floor(Number(m[1]) / 1000) : null);
    });
  });
}

async function getIdleSeconds(powerMonitor) {
  if (mutterOk) {
    const s = await mutterIdle();
    if (s !== null) return s;
    mutterOk = false;
  }
  return powerMonitor.getSystemIdleTime();
}

module.exports = { getIdleSeconds };
