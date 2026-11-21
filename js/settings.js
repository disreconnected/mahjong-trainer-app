// Saved preferences: validation and localStorage access. No DOM; imports under Node.
import { DEFAULT_SETTINGS } from './controller.js';
import { deviceNameOf } from './store.js';

export const SETTINGS_STORAGE_KEY = 'mahjong-trainer.settings.v2'; // v2: autoSort now defaults to off

// Allowed values of every saved setting (the first default comes from DEFAULT_SETTINGS).
// claimWindow 0 means "Off".
export const SETTING_OPTIONS = Object.freeze({
  botLevel: Object.freeze(['easy', 'normal']),
  tileNumbers: Object.freeze(['chinese', 'arabic']),
  view: Object.freeze(['2d', '3d']),
  claimHelp: Object.freeze([true, false]),
  sound: Object.freeze([true, false]),
  autoSort: Object.freeze([true, false]),
  botSpeed: Object.freeze(['slow', 'normal', 'fast']),
  claimWindow: Object.freeze([5, 7, 10, 15, 20, 30, 0]),
});

export const SAVED_KEYS = Object.freeze([...Object.keys(SETTING_OPTIONS), 'device']);

// Any value -> a complete, valid settings object. Each key keeps its value only when it is
// exactly one of the allowed values (no type coercion); otherwise it falls back to the
// default. Unknown keys are dropped. device (the phone's log file name part) is cleaned like a
// server device name and is null until it is set.
export function sanitizeSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const key of Object.keys(SETTING_OPTIONS)) {
    const v = Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined;
    out[key] = SETTING_OPTIONS[key].includes(v) ? v : DEFAULT_SETTINGS[key];
  }
  out.device = deviceNameOf(src.device);
  return out;
}

// Reads saved settings; never throws (missing, blocked or corrupted storage -> defaults).
export function loadSettings(storage) {
  try {
    const text = storage ? storage.getItem(SETTINGS_STORAGE_KEY) : null;
    return sanitizeSettings(text ? JSON.parse(text) : null);
  } catch {
    return sanitizeSettings(null);
  }
}

// Writes the sanitized settings; returns false instead of throwing when storage fails.
export function saveSettings(storage, settings) {
  try {
    if (!storage) return false;
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(sanitizeSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

// The stored settings with one change applied on top: only the patched keys change.
export function mergeSettings(stored, patch) {
  return sanitizeSettings({ ...sanitizeSettings(stored), ...patch });
}

// Saves a change without overwriting what another tab saved since this page loaded: re-reads
// the stored settings, applies only the patch, saves that, and returns it. Without storage,
// `fallback` (this page's copy) stands in for the stored settings.
export function saveSettingsPatch(storage, patch, fallback = null) {
  const merged = mergeSettings(storage ? loadSettings(storage) : fallback, patch);
  saveSettings(storage, merged);
  return merged;
}
