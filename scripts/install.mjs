#!/usr/bin/env node
// Instalador da statusline minimalist-hud.
//
// Uso: install.mjs <install|uninstall|status> [--replace] [--dry-run] [--refresh N]
// Saída: um único objeto JSON no stdout.
// Exit: 0 ok, 2 precisa de --replace (há outra statusline), 1 erro.
//
// O script statusline.mjs é copiado para <config>/plugins/minimalist-hud/ porque o
// caminho do plugin (${CLAUDE_PLUGIN_ROOT}) muda a cada versão; o settings.json aponta
// para a cópia estável. Para atualizar a cópia, rode a instalação de novo.
import {
  existsSync, readFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync,
  renameSync, unlinkSync, copyFileSync, realpathSync, rmdirSync, constants,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'statusline.mjs');
const SAMPLE = JSON.stringify({
  model: { display_name: 'Teste' },
  effort: { level: 'high' },
  cwd: homedir(),
  context_window: { used_percentage: 12 },
  rate_limits: {
    five_hour: { used_percentage: 34, resets_at: Math.floor(Date.now() / 1000) + 7200 },
    seven_day: { used_percentage: 56, resets_at: Math.floor(Date.now() / 1000) + 259200 },
  },
});

class Fail extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

// ---- argumentos ----
function parseArgs(argv) {
  const a = { action: null, replace: false, dryRun: false, refresh: 1 };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--replace') a.replace = true;
    else if (t === '--dry-run') a.dryRun = true;
    else if (t === '--refresh') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 3600) throw new Fail('--refresh exige um inteiro entre 1 e 3600');
      a.refresh = n;
    } else if (!a.action && ['install', 'uninstall', 'status'].includes(t)) a.action = t;
    else throw new Fail(`argumento desconhecido: ${t}`);
  }
  if (!a.action) throw new Fail('uso: install.mjs <install|uninstall|status> [--replace] [--dry-run] [--refresh N]');
  return a;
}

// ---- caminhos ----
function configDir() {
  const env = (process.env.CLAUDE_CONFIG_DIR || '').trim();
  return env ? resolve(env) : join(homedir(), '.claude');
}
const slash = (p) => p.replace(/\\/g, '/');

// ---- utilidades de arquivo ----
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Escrita atômica: tmp no mesmo diretório, fsync, rename (com retentativas no Windows).
function atomicWrite(target, data) {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, 'w');
    try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    let lastErr;
    for (let i = 0; i < 8; i++) {
      try { renameSync(tmp, target); return; } catch (e) {
        lastErr = e;
        if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
        sleep(50 * (i + 1));
      }
    }
    throw lastErr;
  } finally {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
  }
}

// ---- settings ----
function readSettings(path) {
  if (!existsSync(path)) return { exists: false, obj: {}, indent: 2, real: path };
  const real = realpathSync(path);
  let raw = readFileSync(real, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let obj;
  try { obj = JSON.parse(raw); } catch (e) {
    throw new Fail(`settings.json não é um JSON válido (${e.message}); nada foi alterado`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Fail('settings.json não contém um objeto JSON; nada foi alterado');
  }
  const m = /^([ \t]+)"/m.exec(raw);
  return { exists: true, obj, indent: m ? m[1] : 2, real };
}

function classify(obj) {
  const sl = obj.statusLine;
  if (sl === undefined || sl === null) return { kind: 'none', command: null };
  const command = typeof sl === 'string' ? sl : (sl && typeof sl.command === 'string' ? sl.command : '');
  if (command.includes('minimalist-hud') && command.includes('statusline.mjs')) return { kind: 'ours', command };
  return { kind: 'other', command };
}

function backupSettings(real) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let n = 0; n < 100; n++) {
    const bak = join(dirname(real), `${basename(real)}.minimalist-hud.${stamp}${n ? '-' + n : ''}.bak`);
    try { copyFileSync(real, bak, constants.COPYFILE_EXCL); return bak; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Fail('não foi possível criar o backup do settings.json');
}

// Grava, relê e confere. Devolve o objeto relido.
function writeSettings(s, obj) {
  atomicWrite(s.real, JSON.stringify(obj, null, s.indent) + '\n');
  let raw = readFileSync(s.real, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw);
}

// ---- comando gravado ----
function buildCommand(dest) {
  const target = `"${slash(dest)}"`;
  const r = spawnSync('node', ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const major = r.status === 0 ? parseInt(String(r.stdout).trim().replace(/^v/, ''), 10) : NaN;
  if (major >= 18) return { command: `node ${target}`, runtime: 'node (PATH)' };
  const bashLike = Boolean(process.env.MSYSTEM) || /(^|[\\/])(ba|z)?sh(\.exe)?$/.test(process.env.SHELL || '');
  const prefix = process.platform === 'win32' && !bashLike ? '& ' : '';
  return { command: `${prefix}"${slash(process.execPath)}" ${target}`, runtime: 'process.execPath' };
}

function smokeTest(dest) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [dest], {
    input: SAMPLE, encoding: 'utf8', timeout: 5000, windowsHide: true,
    env: { ...process.env, COLUMNS: '100' },
  });
  const out = String(r.stdout || '');
  return {
    ok: r.status === 0 && out.includes('╭') && out.includes('╰') && !r.stderr,
    exit: r.status,
    ms: Date.now() - t0,
    lines: out.split('\n').filter(Boolean).length,
    error: r.error ? String(r.error.message) : undefined,
  };
}

// ---- ações ----
function doStatus(ctx) {
  const s = readSettings(ctx.settingsPath);
  const c = classify(s.obj);
  return {
    ok: true, action: 'status', configDir: ctx.cfg, settingsPath: ctx.settingsPath,
    settingsExists: s.exists, statusLine: c.kind,
    currentCommand: c.command === null ? null : c.command.slice(0, 500),
    copyInstalled: existsSync(ctx.dest), previousSaved: existsSync(ctx.prev), copyPath: slash(ctx.dest),
  };
}

function doInstall(ctx, args) {
  const s = readSettings(ctx.settingsPath); // JSON inválido aborta aqui, antes de qualquer escrita
  const c = classify(s.obj);
  const res = {
    ok: true, action: 'install', dryRun: args.dryRun, configDir: ctx.cfg, settingsPath: ctx.settingsPath,
    statusLineBefore: c.kind,
  };
  if (c.kind === 'other' && !args.replace) {
    res.ok = false; res.needsReplace = true; res.currentCommand = c.command.slice(0, 500);
    res.error = 'há outra statusline configurada; confirme com o usuário e rode de novo com --replace';
    res.exit = 2;
    return res;
  }
  const { command, runtime } = buildCommand(ctx.dest);
  const entry = { type: 'command', command, refreshInterval: args.refresh };
  const saveOld = c.kind === 'other';
  res.command = command; res.runtime = runtime; res.copyPath = slash(ctx.dest);
  res.savesPrevious = saveOld;
  if (args.dryRun) { res.backup = s.exists ? '(seria criado)' : null; return res; }

  // Ordem: backup, previous, cópia, settings. Qualquer falha antes do último passo deixa o settings intacto.
  res.backup = s.exists ? slash(backupSettings(s.real)) : null;
  if (saveOld) {
    atomicWrite(ctx.prev, JSON.stringify(s.obj.statusLine, null, 2) + '\n');
    res.previousPath = slash(ctx.prev);
  }
  atomicWrite(ctx.dest, readFileSync(SOURCE));
  const next = { ...s.obj };
  const old = c.kind === 'ours' && typeof s.obj.statusLine === 'object' ? s.obj.statusLine : {};
  next.statusLine = { ...old, ...entry };
  const back = writeSettings(s, next);
  res.verified = JSON.stringify(back.statusLine) === JSON.stringify(next.statusLine) &&
    JSON.stringify(Object.keys(back)) === JSON.stringify(Object.keys(next));
  if (!res.verified) { res.ok = false; res.error = 'a verificação após a escrita falhou; restaure pelo backup'; res.exit = 1; }
  res.smokeTest = smokeTest(ctx.dest);
  return res;
}

function doUninstall(ctx, args) {
  const s = readSettings(ctx.settingsPath);
  const c = classify(s.obj);
  const res = { ok: true, action: 'uninstall', dryRun: args.dryRun, configDir: ctx.cfg, settingsPath: ctx.settingsPath, statusLineBefore: c.kind };
  if (c.kind !== 'ours') {
    res.changed = false;
    res.note = 'a statusLine atual não é do minimalist-hud; nada foi tocado';
    return res;
  }
  let previous; let hasPrevious = false;
  if (existsSync(ctx.prev)) {
    try { previous = JSON.parse(readFileSync(ctx.prev, 'utf8').replace(/^﻿/, '')); hasPrevious = previous !== null && previous !== undefined; } catch (e) {
      throw new Fail(`previous-statusline.json ilegível (${e.message}); nada foi alterado`);
    }
  }
  res.restores = hasPrevious ? 'previous' : 'removeKey';
  if (args.dryRun) return res;
  res.backup = s.exists ? slash(backupSettings(s.real)) : null;
  const next = { ...s.obj };
  if (hasPrevious) next.statusLine = previous; else delete next.statusLine;
  const back = writeSettings(s, next);
  res.verified = JSON.stringify(back) === JSON.stringify(next);
  if (!res.verified) { res.ok = false; res.error = 'a verificação após a escrita falhou; restaure pelo backup'; res.exit = 1; return res; }
  for (const f of [ctx.dest, ctx.prev]) { try { if (existsSync(f)) unlinkSync(f); } catch {} }
  try { rmdirSync(ctx.dataDir); } catch {}
  res.changed = true;
  return res;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = configDir();
  const dataDir = join(cfg, 'plugins', 'minimalist-hud');
  const ctx = {
    cfg: slash(cfg), settingsPath: join(cfg, 'settings.json'), dataDir,
    dest: join(dataDir, 'statusline.mjs'), prev: join(dataDir, 'previous-statusline.json'),
  };
  if (args.action === 'status') return doStatus(ctx);
  if (args.action === 'install') return doInstall(ctx, args);
  return doUninstall(ctx, args);
}

let result;
try {
  result = main();
} catch (e) {
  result = { ok: false, error: e instanceof Fail ? e.message : `erro inesperado: ${e && e.message ? e.message : e}`, exit: e instanceof Fail ? e.code : 1 };
}
const code = result.exit ?? 0;
delete result.exit;
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exitCode = code;
