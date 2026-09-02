#!/usr/bin/env node
import { join } from 'node:path';
import {
  acknowledgeHandoff,
  classifyObservation,
  CollaborationError,
  completeClaim,
  createHandoff,
  doctorState,
  finishHandoff,
  heartbeatSession,
  publicStatus,
  registerSession,
  requestClaim,
} from './core.mjs';
import { ensureHome, loadState, mutateState, readRecentJsonLines, stateFiles } from './store.mjs';

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const flags = {};
  const positionals = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const raw = token.slice(2);
    const equals = raw.indexOf('=');
    let key;
    let value;
    if (equals >= 0) {
      key = raw.slice(0, equals);
      value = raw.slice(equals + 1);
    } else {
      key = raw;
      const next = rest[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        index += 1;
      } else {
        value = true;
      }
    }
    if (flags[key] === undefined) flags[key] = value;
    else if (Array.isArray(flags[key])) flags[key].push(value);
    else flags[key] = [flags[key], value];
  }
  return { command, flags, positionals };
}

function required(flags, name) {
  const value = flags[name];
  if (value === undefined || value === true || value === '') {
    throw new CollaborationError('MISSING_ARGUMENT', `--${name} is required`);
  }
  return String(value);
}

function optional(flags, name, fallback = undefined) {
  const value = flags[name];
  if (value === undefined || value === true) return fallback;
  return String(value);
}

function list(flags, name) {
  const raw = flags[name];
  if (raw === undefined || raw === true) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.flatMap((value) => String(value).split(',')).map((value) => value.trim()).filter(Boolean);
}

function number(flags, name, fallback) {
  const value = optional(flags, name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new CollaborationError('INVALID_NUMBER', `--${name} must be an integer`);
  return parsed;
}

function home(flags) {
  const workspace = optional(flags, 'workspace', process.env.ROAD_WORKSPACE || '/Users/alexa/workspace');
  return optional(flags, 'home', process.env.ROAD_COLLAB_HOME || join(workspace, '.road-agents', 'collaboration'));
}

function print(value, plain = false) {
  if (plain && typeof value === 'string') process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help() {
  process.stdout.write(`road-collab: BlackRoad six-agent collaboration control plane\n\n`);
  process.stdout.write(`Commands:\n`);
  process.stdout.write(`  init [--workspace PATH]\n`);
  process.stdout.write(`  register --agent agent-instance-N --runtime claude|chatgpt|codex|roadie|human [--session ID] [--model NAME]\n`);
  process.stdout.write(`  heartbeat --session ID\n`);
  process.stdout.write(`  claim --session ID --connector ID --target REF --mode write|deploy|admin|secret|public-exposure --operation NAME --idempotency KEY\n`);
  process.stdout.write(`  complete --session ID --claim ID --result succeeded|failed|unknown|cancelled|compensated [--evidence REF]\n`);
  process.stdout.write(`  handoff --from-session ID --to-agent agent-instance-N --kind NAME --summary TEXT [--required-action TEXT]\n`);
  process.stdout.write(`  ack --session ID --handoff ID\n`);
  process.stdout.write(`  finish-handoff --session ID --handoff ID [--result completed|rejected]\n`);
  process.stdout.write(`  status [--public]\n`);
  process.stdout.write(`  doctor\n`);
  process.stdout.write(`  events [--limit N]\n`);
  process.stdout.write(`  receipts [--limit N]\n`);
  process.stdout.write(`  classify --kind timeout|zero|auth-rejected|forbidden|connection-refused|not-found|success [--count N] [--error-code CODE]\n`);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const stateHome = home(flags);

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      help();
      return;
    case 'init':
      ensureHome(stateHome);
      print({ ok: true, home: stateHome, files: stateFiles });
      return;
    case 'register': {
      const result = mutateState(stateHome, (state) => registerSession(state, {
        agentId: required(flags, 'agent'),
        runtime: required(flags, 'runtime'),
        sessionId: optional(flags, 'session'),
        model: optional(flags, 'model'),
        workspace: optional(flags, 'workspace', process.env.ROAD_WORKSPACE || '/Users/alexa/workspace'),
        ttlSeconds: number(flags, 'ttl', 3600),
        capabilities: list(flags, 'capability'),
        correlationId: optional(flags, 'correlation'),
      }));
      print({ ok: true, replay: result.replay, session: result.session });
      return;
    }
    case 'heartbeat': {
      const result = mutateState(stateHome, (state) => heartbeatSession(state, {
        sessionId: required(flags, 'session'),
        ttlSeconds: number(flags, 'ttl', 3600),
      }));
      print({ ok: true, session: result.session });
      return;
    }
    case 'claim': {
      const result = mutateState(stateHome, (state) => requestClaim(state, {
        sessionId: required(flags, 'session'),
        connectorId: required(flags, 'connector'),
        targetRef: required(flags, 'target'),
        mode: required(flags, 'mode'),
        operation: required(flags, 'operation'),
        idempotencyKey: required(flags, 'idempotency'),
        operationId: optional(flags, 'operation-id'),
        correlationId: optional(flags, 'correlation'),
        causationId: optional(flags, 'causation'),
        expectedVersion: optional(flags, 'expected-version'),
        summary: optional(flags, 'summary'),
        evidenceRefs: list(flags, 'evidence'),
        ttlSeconds: number(flags, 'ttl', 900),
      }));
      print({ ok: true, replay: result.replay, claim: result.claim });
      return;
    }
    case 'complete': {
      const result = mutateState(stateHome, (state) => completeClaim(state, {
        sessionId: required(flags, 'session'),
        claimId: required(flags, 'claim'),
        result: required(flags, 'result'),
        observedVersion: optional(flags, 'observed-version'),
        resultingVersion: optional(flags, 'resulting-version'),
        evidenceRefs: list(flags, 'evidence'),
        errorCode: optional(flags, 'error-code'),
        redactions: list(flags, 'redaction'),
      }));
      print({ ok: true, receipt: result.receipt });
      return;
    }
    case 'handoff': {
      const result = mutateState(stateHome, (state) => createHandoff(state, {
        fromSessionId: required(flags, 'from-session'),
        toAgentId: required(flags, 'to-agent'),
        kind: required(flags, 'kind'),
        summary: required(flags, 'summary'),
        requiredAction: optional(flags, 'required-action'),
        connectorIds: list(flags, 'connector'),
        targetRefs: list(flags, 'target'),
        evidenceRefs: list(flags, 'evidence'),
        correlationId: optional(flags, 'correlation'),
        causationId: optional(flags, 'causation'),
        ttlSeconds: number(flags, 'ttl', 86400),
      }));
      print({ ok: true, handoff: result.handoff });
      return;
    }
    case 'ack': {
      const result = mutateState(stateHome, (state) => acknowledgeHandoff(state, {
        sessionId: required(flags, 'session'),
        handoffId: required(flags, 'handoff'),
      }));
      print({ ok: true, handoff: result.handoff });
      return;
    }
    case 'finish-handoff': {
      const result = mutateState(stateHome, (state) => finishHandoff(state, {
        sessionId: required(flags, 'session'),
        handoffId: required(flags, 'handoff'),
        result: optional(flags, 'result', 'completed'),
        evidenceRefs: list(flags, 'evidence'),
      }));
      print({ ok: true, handoff: result.handoff });
      return;
    }
    case 'status': {
      const state = loadState(stateHome);
      print(flags.public ? publicStatus(state) : doctorState(state));
      return;
    }
    case 'doctor': {
      const result = mutateState(stateHome, (state) => doctorState(state));
      print({ ok: result.ok, issues: result.issues, counts: result.counts });
      if (!result.ok) process.exitCode = 2;
      return;
    }
    case 'events':
      print({ events: readRecentJsonLines(stateHome, stateFiles.events, number(flags, 'limit', 20)) });
      return;
    case 'receipts':
      print({ receipts: readRecentJsonLines(stateHome, stateFiles.receipts, number(flags, 'limit', 20)) });
      return;
    case 'classify':
      print(classifyObservation({
        kind: required(flags, 'kind'),
        count: number(flags, 'count', undefined),
        errorCode: optional(flags, 'error-code'),
        ok: flags.ok === true || flags.ok === 'true',
      }));
      return;
    default:
      throw new CollaborationError('UNKNOWN_COMMAND', `Unknown command: ${command}`);
  }
}

main().catch((error) => {
  const payload = error instanceof CollaborationError
    ? { ok: false, error: error.code, message: error.message, details: error.details }
    : { ok: false, error: 'UNEXPECTED_ERROR', message: error.message };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});
