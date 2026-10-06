// Comprueba la confianza en una CA interna con una PKI de prueba (raíz -> intermedia -> servidor).
const test = require('node:test');
const assert = require('node:assert');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { RedmineClient } = require('../src/redmine');

function hasOpenssl() {
  try { execFileSync('openssl', ['version']); return true; } catch { return false; }
}

function makePki(dir) {
  const ssl = args => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'ca.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  fs.writeFileSync(path.join(dir, 'leaf.ext'), 'subjectAltName=DNS:localhost\n');
  ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.crt', '-days', '2', '-subj', '/CN=Raiz', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  ssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'inter.key', '-out', 'inter.csr', '-subj', '/CN=Intermedia']);
  ssl(['x509', '-req', '-in', 'inter.csr', '-CA', 'root.crt', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'inter.crt', '-days', '2', '-extfile', 'ca.ext']);
  ssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=localhost']);
  ssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'inter.crt', '-CAkey', 'inter.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '2', '-extfile', 'leaf.ext']);
  const r = f => fs.readFileSync(path.join(dir, f), 'utf8');
  return { key: r('leaf.key'), chain: r('leaf.crt') + r('inter.crt') + r('root.crt') };
}

test('CA interna: funciona con la raíz y da errores en español si falta', { skip: !hasOpenssl() && 'sin openssl' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-pki-'));
  const { key, chain } = makePki(dir);
  const srv = https.createServer({ key, cert: chain }, (q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('{"user":{"login":"yo"}}'); });
  await new Promise(r => srv.listen(0, r));
  const url = `https://localhost:${srv.address().port}`;
  try {
    assert.equal((await new RedmineClient({ url, apiKey: 'k', caPath: path.join(dir, 'root.crt') }).currentUser()).login, 'yo');
    await assert.rejects(new RedmineClient({ url, apiKey: 'k' }).currentUser(), /CA que no es de confianza.*SELF_SIGNED_CERT_IN_CHAIN/);
    await assert.rejects(new RedmineClient({ url, apiKey: 'k', caPath: path.join(dir, 'inter.crt') }).currentUser(), /Falta la CA/);
    execFileSync('openssl', ['x509', '-in', 'root.crt', '-outform', 'DER', '-out', 'root.der'], { cwd: dir });
    assert.equal((await new RedmineClient({ url, apiKey: 'k', caPath: path.join(dir, 'root.der') }).currentUser()).login, 'yo');
    assert.throws(() => new RedmineClient({ url, apiKey: 'k', caPath: path.join(dir, 'leaf.key') }), /no es un certificado válido/);
    // Error habitual: exportar desde el navegador el certificado del servidor en vez del de la CA.
    assert.throws(() => new RedmineClient({ url, apiKey: 'k', caPath: path.join(dir, 'leaf.crt') }), /certificado del propio servidor/);
    assert.throws(() => new RedmineClient({ url, apiKey: 'k', caPath: path.join(dir, 'no-existe.crt') }), /no existe/);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
