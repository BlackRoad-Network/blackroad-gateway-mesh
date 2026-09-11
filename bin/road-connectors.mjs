#!/usr/bin/env node
import { loadFabric } from '../src/catalog.mjs';
import { planConnectorAction } from '../src/planner.mjs';
import { ConnectorRuntime } from '../src/runtime.mjs';
import { auditConnectors } from '../src/audit.mjs';
import { routeTask, validateRoutingProfiles } from '../src/router.mjs';
import { getNativeTarget, nativeCoverage, planNativeExit, validateNativeCapabilities } from '../src/native.mjs';
import { describeAppSurface, loadAppSurfaceRegistry, validateAppSurfaceRegistry } from '../src/apps.mjs';

const [command = 'status', ...args] = process.argv.slice(2);

if (command === 'list') {
  const fabric = await loadFabric();
  for (const connector of fabric.connectors) console.log(`${connector.id}\t${connector.role}\t${connector.state}`);
} else if (command === 'status') {
  const fabric = await loadFabric();
  const counts = fabric.connectors.reduce((result, connector) => {
    result[connector.state] = (result[connector.state] ?? 0) + 1;
    return result;
  }, {});
  console.log(JSON.stringify({
    version: fabric.version,
    total: fabric.connectors.length,
    states: counts
  }, null, 2));
} else if (command === 'plan') {
  const [id, operation = 'read', ...flags] = args;
  if (!id) throw new Error('usage: road-connectors plan <connector> <read|write> [--evidence=name]');
  const evidence = Object.fromEntries(flags.filter((flag) => flag.startsWith('--evidence=')).map((flag) => [flag.slice(11), true]));
  console.log(JSON.stringify(await planConnectorAction(id, operation, evidence), null, 2));
} else if (command === 'describe') {
  const [id] = args;
  if (!id) throw new Error('usage: road-connectors describe <connector>');
  const fabric = await loadFabric();
  const connector = fabric.connectors.find((entry) => entry.id === id);
  if (!connector) throw new Error(`unknown connector: ${id}`);
  console.log(JSON.stringify(connector, null, 2));
} else if (command === 'audit') {
  const concurrencyFlag = args.find((arg) => arg.startsWith('--concurrency='));
  const concurrency = concurrencyFlag ? Number(concurrencyFlag.slice(14)) : 4;
  const runtime = new ConnectorRuntime();
  console.log(JSON.stringify(await auditConnectors({ runtime, concurrency }), null, 2));
} else if (command === 'route') {
  const [task, operation = 'read', ...flags] = args;
  if (!task) throw new Error('usage: road-connectors route <task> <read|write> [--preferred=connector]');
  const preferredFlag = flags.find((flag) => flag.startsWith('--preferred='));
  console.log(JSON.stringify(await routeTask({ task, operation, preferred: preferredFlag?.slice(12) ?? null }), null, 2));
} else if (command === 'native') {
  const [subcommand = 'status', id, ...flags] = args;
  if (subcommand === 'status') {
    console.log(JSON.stringify(await nativeCoverage(), null, 2));
  } else if (subcommand === 'describe') {
    if (!id) throw new Error('usage: road-connectors native describe <connector>');
    const target = await getNativeTarget(id);
    if (!target) throw new Error(`unknown connector bridge: ${id}`);
    console.log(JSON.stringify(target, null, 2));
  } else if (subcommand === 'plan') {
    if (!id) throw new Error('usage: road-connectors native plan <connector> [--evidence=name]');
    const evidence = Object.fromEntries(flags.filter((flag) => flag.startsWith('--evidence=')).map((flag) => [flag.slice(11), true]));
    console.log(JSON.stringify(await planNativeExit(id, evidence), null, 2));
  } else {
    throw new Error(`unknown native command: ${subcommand}`);
  }
} else if (command === 'apps') {
  const [subcommand = 'status', id] = args;
  if (subcommand === 'status') {
    const registry = await loadAppSurfaceRegistry();
    const validation = await validateAppSurfaceRegistry();
    console.log(JSON.stringify({ ...validation, version: registry.version, observedAt: registry.observedAt, availabilityIsAuthentication: registry.availabilityIsAuthentication }, null, 2));
  } else if (subcommand === 'describe') {
    if (!id) throw new Error('usage: road-connectors apps describe <app>');
    const app = await describeAppSurface(id);
    if (!app) throw new Error(`unknown app surface: ${id}`);
    console.log(JSON.stringify(app, null, 2));
  } else {
    throw new Error(`unknown apps command: ${subcommand}`);
  }
} else if (command === 'check') {
  const fabric = await loadFabric();
  const badRoles = fabric.connectors.filter(({ role }) => !['discussion', 'delivery', 'event', 'control', 'decision', 'reference-only'].includes(role));
  if (badRoles.length) throw new Error(`invalid roles: ${badRoles.map(({ id }) => id).join(', ')}`);
  const routing = await validateRoutingProfiles();
  if (!routing.valid) throw new Error(`invalid routing profiles: ${routing.errors.join('; ')}`);
  const native = await validateNativeCapabilities();
  if (!native.valid) throw new Error(`invalid native capabilities: ${native.errors.join('; ')}`);
  const apps = await validateAppSurfaceRegistry();
  if (!apps.valid) throw new Error(`invalid app surface registry: ${apps.errors.join('; ')}`);
  console.log(`connector fabric ${fabric.version}: ${fabric.connectors.length} contracts, ${routing.profiles} routes, ${native.capabilities} native capabilities, and ${apps.apps} app surfaces valid`);
} else {
  throw new Error(`unknown command: ${command}`);
}
