// Almacenamiento de la API key como una contraseña: siempre cifrada con el
// llavero del sistema (safeStorage de Electron) y nunca en claro en disco.
// En Linux, "basic_text" cifra con una clave fija conocida: no se acepta.
const INSECURE_BACKENDS = new Set(['basic_text', 'unknown']);
const LABELS = {
  gnome_libsecret: 'llavero de GNOME',
  kwallet: 'KWallet', kwallet5: 'KWallet', kwallet6: 'KWallet'
};
const REDMINE_KEY = /^[0-9a-f]{40}$/i;

function keyring(safeStorage) {
  if (!safeStorage.isEncryptionAvailable()) return { secure: false };
  const backend = safeStorage.getSelectedStorageBackend?.(); // solo existe en Linux
  if (backend && INSECURE_BACKENDS.has(backend)) return { secure: false };
  return { secure: true, label: LABELS[backend] || 'llavero del sistema' };
}

function createKeyStore(safeStorage, data) {
  let error = null;

  function set(raw) {
    const key = String(raw || '').trim();
    if (!REDMINE_KEY.test(key)) throw new Error('La API key de Redmine debe tener 40 caracteres hexadecimales (Mi cuenta → Clave de acceso a la API).');
    if (!keyring(safeStorage).secure) throw new Error('No hay un llavero del sistema seguro disponible (GNOME Keyring o KWallet). Por seguridad, la API key no se guarda.');
    data.apiKeyEnc = safeStorage.encryptString(key).toString('base64');
    data.apiKeyPlain = null;
    error = null;
  }

  function get() {
    if (data.apiKeyEnc) {
      try {
        const key = safeStorage.decryptString(Buffer.from(data.apiKeyEnc, 'base64'));
        error = null;
        return key;
      } catch (e) {
        error = `No se pudo descifrar la API key con el llavero (${e.message}). ¿Está desbloqueado? Si persiste, vuelve a introducirla.`;
        return null;
      }
    }
    return data.apiKeyPlain || null; // solo hasta que migrate() la cifre
  }

  return {
    set,
    get,
    clear() { data.apiKeyEnc = null; data.apiKeyPlain = null; error = null; },
    // Cifra una clave antigua guardada en claro. Devuelve true si hay que guardar ajustes.
    migrate() {
      if (!data.apiKeyPlain || !keyring(safeStorage).secure) return false;
      set(data.apiKeyPlain);
      return true;
    },
    status() {
      const hasApiKey = Boolean(get());
      return { hasApiKey, storage: hasApiKey && data.apiKeyEnc ? keyring(safeStorage).label || null : null, error };
    }
  };
}

module.exports = { createKeyStore };
