// Persistencia en JSON dentro de ~/.config/<app>/ con escritura atómica.
const fs = require('fs');
const path = require('path');

class JsonFile {
  constructor(file, defaults) {
    this.file = file;
    this.data = structuredClone(defaults);
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Fichero corrupto: se guarda copia y se empieza limpio.
        try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch {}
      }
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { JsonFile };
