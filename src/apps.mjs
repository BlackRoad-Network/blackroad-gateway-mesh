import { readFile } from 'node:fs/promises';
import { loadNativeCapabilities } from './native.mjs';

const registryUrl = new URL('../data/app-surface-registry.json', import.meta.url);
const APP_ID = /^[a-z0-9][a-z0-9-]*$/;

export async function loadAppSurfaceRegistry() {
  return JSON.parse(await readFile(registryUrl, 'utf8'));
}

export async function validateAppSurfaceRegistry() {
  const [registry, native] = await Promise.all([loadAppSurfaceRegistry(), loadNativeCapabilities()]);
  const errors = [];
  const labels = new Set();
  for (const [id, app] of Object.entries(registry.apps ?? {})) {
    if (!APP_ID.test(id)) errors.push(`${id}: invalid app id`);
    if (!app || typeof app.label !== 'string' || !app.label) errors.push(`${id}: label required`);
    if (labels.has(app?.label)) errors.push(`${id}: duplicate label`);
    labels.add(app?.label);
    if (!native.capabilities[app?.capability]) errors.push(`${id}: unknown native capability ${app?.capability}`);
  }
  return Object.freeze({ valid: errors.length === 0, apps: Object.keys(registry.apps ?? {}).length, errors });
}

export async function describeAppSurface(id) {
  const [registry, native] = await Promise.all([loadAppSurfaceRegistry(), loadNativeCapabilities()]);
  const app = registry.apps?.[id];
  if (!app) return null;
  const capability = native.capabilities[app.capability];
  return Object.freeze({
    id,
    label: app.label,
    providerSurface: 'available-unverified',
    nativeCapability: { id: app.capability, ...capability },
    relationship: 'connected-tool-surface-is-a-bridge-not-owned-state'
  });
}
