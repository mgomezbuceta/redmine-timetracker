// Cliente mínimo de la API REST de Redmine usando https/http de Node
// (así podemos añadir la CA interna sin tocar el sistema).
const https = require('https');
const http = require('http');
const tls = require('tls');
const fs = require('fs');
const { X509Certificate } = require('crypto');

// Ubuntu guarda aquí las CAs del sistema, incluidas las añadidas con update-ca-certificates.
const SYSTEM_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

// Node solo confía en su lista interna de CAs: le añadimos las del sistema (almacén de Windows,
// llavero de macOS o bundle de Linux, donde suele estar ya la CA de la empresa) y la de Ajustes.
function buildCaList(caPath) {
  const list = [...tls.rootCertificates];
  try { list.push(...tls.getCACertificates('system')); } catch { /* Node antiguo: sin acceso al almacén */ }
  try { list.push(...(fs.readFileSync(SYSTEM_BUNDLE, 'utf8').match(PEM_RE) || [])); } catch { /* sin bundle del sistema */ }
  if (caPath) {
    let buf;
    try { buf = fs.readFileSync(caPath); } catch (e) {
      throw new Error(`No se puede leer el certificado ${caPath}: ${e.code === 'ENOENT' ? 'no existe' : e.code === 'EACCES' ? 'sin permiso de lectura' : e.message}`);
    }
    let certs = buf.toString('latin1').match(PEM_RE);
    if (!certs) {
      // Sin cabecera PEM: se prueba como DER (binario), habitual en .crt exportados en Windows.
      try { certs = [new X509Certificate(buf).toString()]; } catch {
        throw new Error(`El fichero ${caPath} no es un certificado válido (ni PEM ni DER).`);
      }
    }
    if (!certs.some(pem => { try { return new X509Certificate(pem).ca; } catch { return false; } })) {
      throw new Error(`${caPath} es el certificado del propio servidor, no el de la CA que lo firma. En el navegador, abre el candado → certificado → pestaña de jerarquía o ruta de certificación, selecciona el de arriba del todo (la CA raíz) y expórtalo.`);
    }
    list.push(...certs);
  }
  return list;
}

const NET_ERRORS = {
  SELF_SIGNED_CERT_IN_CHAIN: 'El servidor usa una CA que no es de confianza. Revisa que el certificado de Ajustes sea la CA raíz de la cadena (no una intermedia).',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'El servidor usa un certificado autofirmado que no es de confianza.',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'Falta la CA que firma el certificado del servidor. Indica su .crt en Ajustes.',
  UNABLE_TO_GET_ISSUER_CERT: 'Falta la CA que firma el certificado del servidor. Indica su .crt en Ajustes.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'No se puede verificar el certificado del servidor: probablemente el servidor no envía la CA intermedia. Indica en Ajustes la cadena completa.',
  CERT_HAS_EXPIRED: 'El certificado del servidor ha caducado.',
  CERT_NOT_YET_VALID: 'El certificado del servidor aún no es válido (revisa la hora del equipo).',
  ERR_TLS_CERT_ALTNAME_INVALID: 'El certificado del servidor no corresponde a esa dirección. Revisa la URL.',
  ENOTFOUND: 'No se encuentra el servidor. ¿Está la VPN conectada y la URL bien escrita?',
  EAI_AGAIN: 'No se puede resolver el nombre del servidor. ¿Está la VPN conectada?',
  ECONNREFUSED: 'El servidor ha rechazado la conexión.',
  ECONNRESET: 'Se ha cortado la conexión con el servidor.',
  EHOSTUNREACH: 'No se llega al servidor. ¿Está la VPN conectada?',
  ETIMEDOUT: 'Tiempo de espera agotado conectando con el servidor. ¿Está la VPN conectada?'
};

const HTTP_ERRORS = {
  401: 'API key incorrecta o la API REST está desactivada en Redmine.',
  403: 'Tu usuario no tiene permiso para esta operación en Redmine.',
  404: 'No encontrado en Redmine (¿existe la tarea y tienes acceso?).',
  422: 'Redmine ha rechazado los datos'
};

function spanishNetError(err) {
  const msg = NET_ERRORS[err.code];
  return msg ? new Error(`${msg} [${err.code}]`) : err;
}

const MAX_RESPONSE = 10 * 1024 * 1024; // 10 MB: de sobra para la API, corta respuestas anómalas

class RedmineClient {
  constructor({ url, apiKey, caPath }) {
    if (!url) throw new Error('Falta la URL de Redmine');
    if (!apiKey) throw new Error('Falta la API key');
    this.base = RedmineClient.checkUrl(url);
    this.apiKey = apiKey;
    this.ca = buildCaList(caPath);
  }

  // La API key va en cada petición: sin TLS viajaría en claro. HTTP solo en el propio equipo.
  static checkUrl(url) {
    let base;
    try { base = new URL(url.endsWith('/') ? url : url + '/'); } catch { throw new Error('La URL de Redmine no es válida.'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) {
      throw new Error('La URL de Redmine debe empezar por https:// (por seguridad, la API key no se envía sin cifrar).');
    }
    return base;
  }

  request(method, path, body) {
    const u = new URL(path.replace(/^\//, ''), this.base);
    const lib = u.protocol === 'http:' ? http : https;
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      headers: {
        'X-Redmine-API-Key': this.apiKey,
        'Accept': 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      },
      timeout: 15000
    };
    if (this.ca) opts.ca = this.ca;
    return new Promise((resolve, reject) => {
      const req = lib.request(u, opts, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => {
          data += c;
          if (data.length > MAX_RESPONSE) req.destroy(new Error('Respuesta de Redmine demasiado grande.'));
        });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* no JSON */ }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
          const detail = json?.errors ? json.errors.join(', ') : '';
          const base = HTTP_ERRORS[res.statusCode] || `Error HTTP ${res.statusCode} en ${method} ${u.pathname}`;
          reject(new Error(detail ? `${base}: ${detail}` : base));
        });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', err => reject(spanishNetError(err)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  async currentUser() {
    return (await this.request('GET', '/users/current.json')).user;
  }

  async activities() {
    const r = await this.request('GET', '/enumerations/time_entry_activities.json');
    return (r.time_entry_activities || []).filter(a => a.active !== false);
  }

  static mapIssue(i) {
    return { id: i.id, subject: i.subject, project: i.project?.name || '', status: i.status?.name || '', parentId: i.parent?.id || null };
  }

  // Consulta de tareas con la sintaxis f[]/op/v (la única que admite "bookmarks";
  // con project_id=bookmarks Redmine da 404). Siempre excluye proyectos cerrados
  // o archivados: el estado del proyecto prima sobre todo lo demás.
  async findIssues(filters) {
    const params = new URLSearchParams({ sort: 'updated_on:desc', limit: '100' });
    for (const [field, op, value] of [['project.status', '=', '1'], ...filters]) {
      params.append('f[]', field);
      params.set(`op[${field}]`, op);
      if (value !== undefined) params.append(`v[${field}][]`, value);
    }
    const r = await this.request('GET', `/issues.json?${params}`);
    return (r.issues || []).map(RedmineClient.mapIssue);
  }

  // Búsqueda por ID (si es numérico) o por título (filtro "contiene"),
  // por defecto solo en los proyectos favoritos del usuario.
  async searchIssues(q, { onlyOpen = true, projectId = null } = {}) {
    q = String(q || '').trim().replace(/^#/, '');
    if (/^\d+$/.test(q)) return this.findIssues([['issue_id', '=', q], ['status_id', '*']]);
    const list = await this.findIssues([
      ['project_id', '=', projectId ? String(projectId) : 'bookmarks'],
      ['status_id', onlyOpen ? 'o' : '*'],
      q ? ['subject', '~', q] : ['assigned_to_id', '=', 'me']
    ]);
    return this.withAncestors(list);
  }

  // Añade (marcados como `context`) los padres que no vinieron en el resultado,
  // para poder pintar el árbol de tareas completo.
  async withAncestors(list) {
    const seen = new Set(list.map(i => i.id));
    for (let depth = 0; depth < 5; depth++) { // ponytail: 5 niveles de anidación como máximo
      const missing = [...new Set(list.map(i => i.parentId).filter(id => id && !seen.has(id)))];
      if (!missing.length) break;
      const parents = await this.findIssues([['issue_id', '=', missing.join(',')], ['status_id', '*']]);
      missing.forEach(id => seen.add(id));
      list = [...list, ...parents.map(i => ({ ...i, context: true }))];
    }
    return list;
  }

  // Proyectos activos para el filtro: favoritos primero y luego en los que participo.
  async projects() {
    const list = async which => {
      const params = new URLSearchParams({ 'f[]': 'id', 'op[id]': '=', 'v[id][]': which, limit: '100' });
      params.append('f[]', 'status'); params.set('op[status]', '='); params.set('v[status][]', '1');
      return (await this.request('GET', `/projects.json?${params}`)).projects || [];
    };
    const [bookmarked, mine] = await Promise.all([list('bookmarks'), list('mine')]);
    const byName = (a, b) => a.name.localeCompare(b.name, 'es');
    const ids = new Set(bookmarked.map(p => p.id));
    return [
      ...bookmarked.sort(byName).map(p => ({ id: p.id, name: p.name, bookmarked: true })),
      ...mine.filter(p => !ids.has(p.id)).sort(byName).map(p => ({ id: p.id, name: p.name, bookmarked: false }))
    ];
  }

  async createTimeEntry({ issueId, date, hours, activityId, comments }) {
    const r = await this.request('POST', '/time_entries.json', {
      time_entry: {
        issue_id: issueId,
        spent_on: date,
        hours,
        activity_id: activityId,
        comments: (comments || '').slice(0, 1024)
      }
    });
    return r.time_entry;
  }
}

module.exports = { RedmineClient, buildCaList };
