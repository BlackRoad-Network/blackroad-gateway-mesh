#!/usr/bin/env node
import { loadFabric } from '../src/catalog.mjs';
import { planConnectorAction } from '../src/planner.mjs';

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
} else if (command === 'check') {
  const fabric = await loadFabric();
  const badRoles = fabric.connectors.filter(({ role }) => !['discussion', 'delivery', 'event', 'control', 'decision', 'reference-only'].includes(role));
  if (badRoles.length) throw new Error(`invalid roles: ${badRoles.map(({ id }) => id).join(', ')}`);
  console.log(`connector fabric ${fabric.version}: ${fabric.connectors.length} contracts valid`);
} else {
  throw new Error(`unknown command: ${command}`);
}
