const test = require('node:test');
const assert = require('node:assert');
const { createKeyStore } = require('../src/secret');

const KEY = 'a'.repeat(20) + '0123456789abcdef0123';
function fakeSafeStorage({ available = true, backend = 'gnome_libsecret', broken = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: s => Buffer.from('v11' + [...s].reverse().join('')),
    decryptString: b => {
      if (broken) throw new Error('keyring locked');
      return [...b.toString().slice(3)].reverse().join('');
    }
  };
}

test('guarda la API key cifrada con el llavero y nunca en claro', () => {
  const data = { apiKeyEnc: null, apiKeyPlain: null };
  const store = createKeyStore(fakeSafeStorage(), data);
  store.set(`  ${KEY}\n`);
  assert.equal(data.apiKeyPlain, null);
  assert.ok(data.apiKeyEnc && !data.apiKeyEnc.includes(KEY));
  assert.equal(store.get(), KEY);
  assert.deepEqual(store.status(), { hasApiKey: true, storage: 'llavero de GNOME', error: null });
  store.clear();
  assert.equal(store.get(), null);
  assert.equal(data.apiKeyEnc, null);
});

test('rechaza guardar si el llavero no es seguro o la clave no tiene formato de Redmine', () => {
  for (const ss of [fakeSafeStorage({ available: false }), fakeSafeStorage({ backend: 'basic_text' })]) {
    const data = { apiKeyEnc: null, apiKeyPlain: null };
    assert.throws(() => createKeyStore(ss, data).set(KEY), /llavero/);
    assert.deepEqual(data, { apiKeyEnc: null, apiKeyPlain: null });
  }
  assert.throws(() => createKeyStore(fakeSafeStorage(), {}).set('no-es-una-clave'), /40 caracteres/);
});

test('informa del error si no puede descifrar, y migra claves antiguas en claro', () => {
  const data = { apiKeyEnc: null, apiKeyPlain: null };
  createKeyStore(fakeSafeStorage(), data).set(KEY);
  const locked = createKeyStore(fakeSafeStorage({ broken: true }), data);
  assert.equal(locked.get(), null);
  assert.match(locked.status().error, /keyring locked/);

  const legacy = { apiKeyEnc: null, apiKeyPlain: KEY };
  const store = createKeyStore(fakeSafeStorage(), legacy);
  assert.equal(store.migrate(), true);
  assert.equal(legacy.apiKeyPlain, null);
  assert.equal(store.get(), KEY);
  assert.equal(store.migrate(), false);
});
