'use strict';

const { CURRENT_SAVE_SCHEMA_VERSION } = require('./legacy-save-cutover');
const MAX_SAVE_REVISION = 2147483646; // PostgreSQL INTEGER max minus one increment.
const SAVE_REQUEST_KEYS = new Set(['schemaVersion', 'baseRevision', 'preferences']);
const STORED_SAVE_KEYS = new Set(['schemaVersion', 'preferences']);
const PREFERENCE_KEYS = new Set(['lastAddress']);
const INTERNAL_ADDRESSES = new Set([
  'router://admin',
  'bank-info://local',
  'ftpcash://local'
]);
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_ADDRESS_PATTERN = new RegExp(`^(?=.{1,253}$)${HOST_LABEL}(?:\\.${HOST_LABEL})*$`, 'i');

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowedKeys) {
  return Object.keys(value).every(key => allowedKeys.has(key));
}

function normalisePreferences(value) {
  if (!isPlainObject(value) || !exactKeys(value, PREFERENCE_KEYS)) {
    return { ok: false, error: 'Only explicitly allowlisted save preferences are accepted.' };
  }

  const preferences = {};
  if (Object.prototype.hasOwnProperty.call(value, 'lastAddress')) {
    if (typeof value.lastAddress !== 'string') {
      return { ok: false, error: 'preferences.lastAddress must be a string.' };
    }
    const address = value.lastAddress.trim().toLowerCase();
    if (address.length < 1 || address.length > 253 || /[\u0000-\u001f\u007f\s]/.test(address)) {
      return { ok: false, error: 'preferences.lastAddress is not a valid in-game address.' };
    }
    if (!INTERNAL_ADDRESSES.has(address) && !HOST_ADDRESS_PATTERN.test(address)) {
      return { ok: false, error: 'preferences.lastAddress is not a valid in-game address.' };
    }
    preferences.lastAddress = address;
  }

  return { ok: true, preferences };
}

function validateSaveRequest(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, code: 'SAVE_PAYLOAD_INVALID', error: 'Save payload must be a JSON object.' };
  }
  if (payload.schemaVersion !== CURRENT_SAVE_SCHEMA_VERSION) {
    return { ok: false, code: 'SAVE_SCHEMA_UNSUPPORTED', error: 'This save schema is not supported.' };
  }
  if (!exactKeys(payload, SAVE_REQUEST_KEYS)) {
    return { ok: false, code: 'SAVE_FIELDS_NOT_ALLOWED', error: 'Only schemaVersion, baseRevision and allowlisted preferences may be submitted.' };
  }
  if (!Number.isSafeInteger(payload.baseRevision) || payload.baseRevision < 0 || payload.baseRevision > MAX_SAVE_REVISION) {
    return { ok: false, code: 'SAVE_REVISION_INVALID', error: 'baseRevision must be a valid non-negative save revision.' };
  }
  const preferenceResult = normalisePreferences(payload.preferences);
  if (!preferenceResult.ok) {
    return { ok: false, code: 'SAVE_PREFERENCES_INVALID', error: preferenceResult.error };
  }
  return {
    ok: true,
    baseRevision: payload.baseRevision,
    save: { schemaVersion: CURRENT_SAVE_SCHEMA_VERSION, preferences: preferenceResult.preferences }
  };
}

function normaliseStoredSave(value) {
  if (!isPlainObject(value) || value.schemaVersion !== CURRENT_SAVE_SCHEMA_VERSION || !exactKeys(value, STORED_SAVE_KEYS)) {
    return null;
  }
  const preferenceResult = normalisePreferences(value.preferences);
  if (!preferenceResult.ok) return null;
  return { schemaVersion: CURRENT_SAVE_SCHEMA_VERSION, preferences: preferenceResult.preferences };
}

module.exports = {
  CURRENT_SAVE_SCHEMA_VERSION,
  MAX_SAVE_REVISION,
  normalisePreferences,
  normaliseStoredSave,
  validateSaveRequest
};
