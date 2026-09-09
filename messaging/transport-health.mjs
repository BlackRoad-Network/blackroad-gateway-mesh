import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import net from 'node:net';
import dns from 'node:dns/promises';

const DEFAULT_TIMEOUT_MS = 5000;

function now() { return new Date().toISOString(); }

function safeTail(text, max = 1200) {
  const clean = String(text ?? '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:token|password|passwd|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
  return clean.length > max ? clean.slice(-max) : clean;
}

async function commandExists(command) {
  const pathEntries = String(process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of pathEntries) {
    try {
      await access(`${dir}/${command}`);
      return `${dir}/${command}`;
    } catch {}
  }
  return null;
}

async function runCommand(command, args = [], options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env,
      cwd: options.cwd ?? process.cwd(),
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, signal: null, timedOut: false, stdout: '', stderr: safeTail(error.message), durationMs: Date.now() - startedAt });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, signal, timedOut, stdout: safeTail(stdout), stderr: safeTail(stderr), durationMs: Date.now() - startedAt });
    });
  });
}

async function listSerialCandidates() {
  if (process.platform === 'win32') return [];
  let entries = [];
  try { entries = await readdir('/dev'); } catch { return []; }
  const patterns = [
    /^cu\.usbmodem/i,
    /^cu\.usbserial/i,
    /^cu\.SLAB_USBtoUART/i,
    /^cu\.wchusbserial/i,
    /^ttyUSB/i,
    /^ttyACM/i,
    /^tty\.usbmodem/i,
    /^tty\.usbserial/i,
  ];
  return entries.filter((name) => patterns.some((p) => p.test(name))).map((name) => `/dev/${name}`).sort();
}

export async function probeRNode(input = {}) {
  const checkedAt = now();
  const ports = input.port ? [input.port] : await listSerialCandidates();
  const rnodeconf = await commandExists('rnodeconf');
  const rnstatus = await commandExists('rnstatus');
  const ret = {
    probe: 'rnode', checkedAt, state: 'UNKNOWN', identity: 'rnode',
    ports, tools: { rnodeconf: Boolean(rnodeconf), rnstatus: Boolean(rnstatus) }, evidence: [],
  };

  if (rnstatus) {
    const result = await runCommand(rnstatus, ['rnode'], { timeoutMs: input.timeoutMs ?? 5000 });
    ret.evidence.push({ source: 'rnstatus', ok: result.ok, timedOut: result.timedOut, exitCode: result.code, output: result.ok ? result.stdout : safeTail(result.stderr || result.stdout) });
    if (result.ok && /RNodeInterface/i.test(result.stdout) && /Status\s*:\s*Up/i.test(result.stdout)) {
      ret.state = 'VERIFIED';
      ret.reticulumInterfaceUp = true;
      return ret;
    }
  }

  if (!ports.length) {
    ret.state = rnodeconf || rnstatus ? 'NO_SERIAL_CANDIDATE' : 'TOOLS_AND_SERIAL_NOT_OBSERVED';
    return ret;
  }

  if (!rnodeconf) {
    ret.state = 'SERIAL_PRESENT_TOOL_MISSING';
    return ret;
  }

  for (const port of ports) {
    const result = await runCommand(rnodeconf, [port, '-i', '--nocheck'], { timeoutMs: input.timeoutMs ?? 7000 });
    ret.evidence.push({ source: 'rnodeconf-info', port, ok: result.ok, timedOut: result.timedOut, exitCode: result.code, output: result.ok ? result.stdout : safeTail(result.stderr || result.stdout) });
    if (result.ok) {
      ret.state = 'VERIFIED';
      ret.port = port;
      return ret;
    }
    if (result.timedOut) ret.state = 'TIMEOUT_UNKNOWN';
  }
  if (ret.state === 'UNKNOWN') ret.state = 'SERIAL_CANDIDATE_NOT_VERIFIED';
  return ret;
}

export async function probeTailscale(input = {}) {
  const checkedAt = now();
  const tailscale = await commandExists('tailscale');
  if (!tailscale) return { probe: 'tailscale', checkedAt, state: 'NOT_INSTALLED', evidence: [] };

  const status = await runCommand(tailscale, ['status', '--json'], { timeoutMs: input.timeoutMs ?? 5000 });
  const result = { probe: 'tailscale', checkedAt, state: status.timedOut ? 'TIMEOUT_UNKNOWN' : 'CLIENT_ERROR', evidence: [{ source: 'tailscale-status-json', ok: status.ok, timedOut: status.timedOut, exitCode: status.code }] };
  if (status.ok) {
    try {
      const data = JSON.parse(status.stdout);
      result.backendState = data.BackendState ?? null;
      result.self = data.Self ? { online: data.Self.Online ?? null, dnsName: data.Self.DNSName ?? null, tailscaleIPs: data.Self.TailscaleIPs ?? [] } : null;
      result.peerCount = data.Peer ? Object.keys(data.Peer).length : 0;
      result.state = (data.BackendState === 'Running' || data.Self?.Online === true) ? 'VERIFIED' : 'CLIENT_PRESENT_NOT_RUNNING';
    } catch {
      result.state = 'STATUS_PARSE_ERROR';
      result.evidence[0].output = safeTail(status.stdout);
    }
  } else {
    result.evidence[0].output = safeTail(status.stderr || status.stdout);
  }

  if (input.target) {
    const ping = await runCommand(tailscale, ['ping', '--c=1', '--timeout=5s', '--until-direct=false', String(input.target)], { timeoutMs: input.timeoutMs ?? 7000 });
    const path = /via\s+([^\s]+)/i.exec(ping.stdout)?.[1] ?? null;
    const latency = /in\s+([0-9.]+ms)/i.exec(ping.stdout)?.[1] ?? null;
    result.target = String(input.target);
    result.peerProbe = { ok: ping.ok, timedOut: ping.timedOut, path, latency, output: safeTail(ping.stdout || ping.stderr) };
    if (ping.ok) result.peerState = 'VERIFIED';
    else if (ping.timedOut) result.peerState = 'TIMEOUT_UNKNOWN';
    else result.peerState = 'NO_TAILSCALE_REPLY';
  }
  return result;
}

export async function probePing(input = {}) {
  const checkedAt = now();
  if (!input.target) throw Object.assign(new Error('target is required'), { code: 'TARGET_REQUIRED' });
  const ping = await commandExists('ping') ?? (process.platform === 'darwin' ? '/sbin/ping' : null);
  if (!ping) return { probe: 'ping', checkedAt, target: input.target, state: 'PING_TOOL_MISSING', evidence: [] };
  const result = await runCommand(ping, ['-c', '1', String(input.target)], { timeoutMs: input.timeoutMs ?? 5000 });
  const latency = /time[=<]([0-9.]+)\s*ms/i.exec(result.stdout)?.[1] ?? null;
  return {
    probe: 'ping', checkedAt, target: String(input.target),
    state: result.ok ? 'REACHABLE' : (result.timedOut ? 'TIMEOUT_UNKNOWN' : 'NO_ICMP_REPLY'),
    latencyMs: latency ? Number(latency) : null,
    evidence: [{ source: 'icmp-ping', ok: result.ok, timedOut: result.timedOut, exitCode: result.code, output: safeTail(result.stdout || result.stderr) }],
  };
}

export async function probeTcp(input = {}) {
  const checkedAt = now();
  if (!input.target) throw Object.assign(new Error('target is required'), { code: 'TARGET_REQUIRED' });
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('valid port is required'), { code: 'PORT_REQUIRED' });
  const timeoutMs = input.timeoutMs ?? 3000;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: String(input.target), port });
    let done = false;
    const finish = (state, error = null) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ probe: 'tcp', checkedAt, target: String(input.target), port, state, latencyMs: Date.now() - startedAt, error: error ? safeTail(error.message) : null });
    };
    socket.setTimeout(timeoutMs, () => finish('TIMEOUT_UNKNOWN'));
    socket.on('connect', () => finish('LISTENING'));
    socket.on('error', (error) => finish(error.code === 'ECONNREFUSED' ? 'REACHABLE_NO_LISTENER' : 'UNREACHABLE_CURRENTLY', error));
  });
}

export async function probeDns(input = {}) {
  const checkedAt = now();
  if (!input.target) throw Object.assign(new Error('target is required'), { code: 'TARGET_REQUIRED' });
  try {
    const rows = await dns.lookup(String(input.target), { all: true });
    return { probe: 'dns', checkedAt, target: String(input.target), state: rows.length ? 'RESOLVED' : 'EMPTY_OBSERVATION', addresses: rows };
  } catch (error) {
    return { probe: 'dns', checkedAt, target: String(input.target), state: 'UNRESOLVED_CURRENTLY', error: safeTail(error.message) };
  }
}

export async function probeHttp(input = {}) {
  const checkedAt = now();
  if (!input.url) throw Object.assign(new Error('url is required'), { code: 'URL_REQUIRED' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 5000);
  try {
    const response = await fetch(String(input.url), { method: input.method ?? 'HEAD', redirect: 'manual', signal: controller.signal });
    return { probe: 'http', checkedAt, url: String(input.url), state: 'REACHABLE', status: response.status, ok: response.ok, location: response.headers.get('location') };
  } catch (error) {
    return { probe: 'http', checkedAt, url: String(input.url), state: error.name === 'AbortError' ? 'TIMEOUT_UNKNOWN' : 'CHECKER_TRANSPORT_ERROR', error: safeTail(error.message) };
  } finally { clearTimeout(timer); }
}

export async function probeTransport(input = {}) {
  const kind = String(input.kind ?? '').toLowerCase();
  if (kind === 'rnode') return probeRNode(input);
  if (kind === 'tailscale') return probeTailscale(input);
  if (kind === 'ping') return probePing(input);
  if (kind === 'tcp') return probeTcp(input);
  if (kind === 'dns') return probeDns(input);
  if (kind === 'http' || kind === 'netlify') return probeHttp({ ...input, url: input.url ?? 'https://blackroad-plugin-gateway.netlify.app/' });
  throw Object.assign(new Error(`unsupported transport probe: ${kind || '<missing>'}`), { code: 'PROBE_KIND_UNSUPPORTED' });
}

export async function healthMatrix(input = {}) {
  const probes = [];
  probes.push(await probeRNode({ timeoutMs: input.timeoutMs }));
  probes.push(await probeTailscale({ target: input.tailscaleTarget ?? null, timeoutMs: input.timeoutMs }));
  probes.push(await probeHttp({ url: input.netlifyUrl ?? 'https://blackroad-plugin-gateway.netlify.app/', timeoutMs: input.timeoutMs }));
  if (input.pingTarget) probes.push(await probePing({ target: input.pingTarget, timeoutMs: input.timeoutMs }));
  if (input.tcpTarget && input.tcpPort) probes.push(await probeTcp({ target: input.tcpTarget, port: input.tcpPort, timeoutMs: input.timeoutMs }));
  return { schema: 'road-transport-health-v1', checkedAt: now(), probes };
}
