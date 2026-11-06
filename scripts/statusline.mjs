// minimalist-hud: statusline em caixa para o Claude Code.
//
// Lê o JSON da sessão no stdin e imprime a caixa no stdout:
//   ╭──────────────── ~/projeto ────────────────╮
//   │ [Sonnet 5.5 ◑ high]   [▤ Context 16%]   ◷ 2h [5h ████░░░ 55%] │
//   │ [CAVEMAN:ULTRA]                         ◷ 3d [7d ██████░ 88%] │
//   ╰───────────────────────────────────────────╯
//
// Colunas da grade: modelo/badges | contexto | limites 5h/7d (com o tempo de reset).
// As colunas da direita somem conforme a largura (COLUMNS ou o terminal) diminui.
// Badges: o do caveman (some sozinho se o plugin não existir) e os extras definidos em
// <config>/statusline-badges.json. Qualquer falha termina em silêncio com exit 0.
import { readFileSync, lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ESC = '\x1b[';
const wrap = (code, s) => `${ESC}${code}m${s}${ESC}0m`;
const SGR = /\x1b\[[0-9;]*m/;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// Controles C0/C1 e marcas bidi: nunca devem chegar ao terminal.
const CONTROL = /[\x00-\x1F\x7F-\x9F‪-‮⁦-⁩]/g;
const clean = (s) => String(s).replace(CONTROL, '');

// ---- largura visual ----
// 0 para combinantes e caracteres de largura zero, 2 para CJK/emoji, 1 para o resto.
function charWidth(cp) {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x483 && cp <= 0x489) ||
    (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0xfeff || (cp >= 0xe0100 && cp <= 0xe01ef)
  ) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}
const textWidth = (s) => { let w = 0; for (const ch of s) w += charWidth(ch.codePointAt(0)); return w; };
const vis = (s) => textWidth(strip(s));

// Trunca para no máximo n colunas visuais, preservando as sequências SGR.
// Se cortar algo, termina com ESC[0m para a cor não vazar para a borda.
function clip(s, n) {
  if (n <= 0) return '';
  if (vis(s) <= n) return s;
  let out = '';
  let w = 0;
  for (let i = 0; i < s.length;) {
    if (s[i] === '\x1b') {
      const m = SGR.exec(s.slice(i, i + 32));
      if (m && m.index === 0) { out += m[0]; i += m[0].length; continue; }
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cwid = charWidth(cp);
    if (w + cwid > n) break;
    out += ch;
    w += cwid;
    i += ch.length;
  }
  return out + `${ESC}0m`;
}

// ---- cores (ajuste aqui) ----
const LEVEL = { medium: 50, high: 80 }; // % a partir da qual o uso é médio / alto
const COLOR = {
  model: '38;2;217;119;87', // laranja Claude
  low: '38;2;80;190;110',    // verde: uso baixo
  medium: '38;2;90;160;235', // azul: uso médio
  high: '38;2;158;38;66',    // vermelho bordô: perto do limite
  path: '38;2;176;182;194', // texto do path
  clock: '38;2;112;116;128', // cinza opaco: relógio + tempo de reset
  label: '38;2;196;200;210', // cinza claro: Context, 5h, 7d e colchetes
  track: '38;2;66;70;80',   // trilho vazio das barras e bordas da caixa
  badge: '38;5;172',        // padrão dos badges
};
const paint = (code, s) => wrap(code, s);
// Aceita número (paleta 0-255) ou string de parâmetros SGR; o resto cai no padrão.
function toCode(c) {
  if (typeof c === 'number' && Number.isInteger(c) && c >= 0 && c <= 255) return `38;5;${c}`;
  if (typeof c === 'string' && /^[0-9;]{1,40}$/.test(c)) return c;
  return COLOR.badge;
}

const CLAUDE_DIR = (process.env.CLAUDE_CONFIG_DIR || '').trim() || join(homedir(), '.claude');
const SYMBOLS = { low: '○', medium: '◔', high: '◑', xhigh: '◕', max: '●' };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function readStdin() {
  try {
    const v = JSON.parse(readFileSync(0, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

// ---- badges ----
// Cada badge devolve uma string já colorida ou ''.
function safeFirstLine(path, max = 64) {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile() || st.size > max) return '';
  return clean(readFileSync(path, 'utf8').split(/\r?\n/)[0]).trim();
}

function cavemanBadge() {
  try {
    const mode = safeFirstLine(join(CLAUDE_DIR, '.caveman-active')).toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!mode || mode === 'off') return '';
    let out = mode === 'full' ? '[CAVEMAN]' : `[CAVEMAN:${mode.toUpperCase()}]`;
    try {
      const sfx = safeFirstLine(join(CLAUDE_DIR, '.caveman-statusline-suffix'));
      if (sfx) out += ` ${sfx}`;
    } catch {}
    return paint(COLOR.badge, out);
  } catch { return ''; }
}

// Badges extras em <config>/statusline-badges.json:
// { "badges": [
//   { "file": "~/.claude/.meu-badge", "format": "[MEU:{}]", "color": 213 }
// ] }
// "file": a primeira linha do arquivo vira {} (só letras, números e : . - espaço);
// se o arquivo não existir ou estiver vazio, o badge some. "~" no início vira o home.
// "color": número da paleta 0-255 ou parâmetros SGR (ex.: "38;2;255;0;128").
function extraBadges() {
  let cfg;
  try { cfg = JSON.parse(readFileSync(join(CLAUDE_DIR, 'statusline-badges.json'), 'utf8')); } catch { return []; }
  const list = cfg && Array.isArray(cfg.badges) ? cfg.badges : [];
  const out = [];
  for (const b of list) {
    try {
      if (!b || typeof b.file !== 'string' || !b.file) continue;
      const file = b.file === '~' || /^~[\\/]/.test(b.file) ? join(homedir(), b.file.slice(1)) : b.file;
      const v = safeFirstLine(file, 256);
      if (!v) continue;
      const fmt = clean(typeof b.format === 'string' ? b.format : '[{}]');
      const val = v.replace(/[^\w:.\- ]/g, '');
      const text = fmt.replace('{}', () => val);
      if (text) out.push(paint(toCode(b.color), text));
    } catch {}
  }
  return out;
}

// ---- barras e segmentos ----
const br = (x) => (x ? paint(COLOR.label, '[') + x + paint(COLOR.label, ']') : '');
function bar(pct, width, code) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round((p / 100) * width);
  const m = /38;2;(\d+);(\d+);(\d+)/.exec(code);
  const track = m ? `38;2;${Math.round(m[1] * 0.32)};${Math.round(m[2] * 0.32)};${Math.round(m[3] * 0.32)}` : COLOR.track;
  return paint(code, '█'.repeat(filled)) + paint(track, '░'.repeat(width - filled));
}

// Porcentagem inteira, ou null se ausente/não numérica (nunca NaN).
function pctOf(v) {
  if (v == null || (typeof v !== 'number' && typeof v !== 'string') || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// uso baixo = verde, médio = azul, alto (perto do limite) = vermelho bordô
function levelColor(p) {
  return p >= LEVEL.high ? COLOR.high : p >= LEVEL.medium ? COLOR.medium : COLOR.low;
}
function seg(label, pct, width) {
  const p = pctOf(pct);
  if (p === null) return null;
  const color = levelColor(p);
  return `${paint(COLOR.label, label)} ${bar(p, width, color)} ${paint(color, p + '%')}`;
}

// ---- effort: cores iguais ao /effort do Claude Code, aproximadas ----
// Níveis com 1 cor: low, medium, high. Níveis com gradiente/brilho: xhigh, max, ultracode.
const EFFORT_STYLE = {
  low:       { stops: [[255, 200, 40]] },                  // dourado
  medium:    { stops: [[60, 200, 90]] },                   // verde
  high:      { stops: [[120, 200, 255]] },                 // azul claro
  xhigh:     { stops: [[170, 110, 255]], shimmer: true },  // roxo
  max:       { rainbow: true },                            // arco-íris, cores trocando rápido
  ultracode: { stops: [[190, 150, 255]], shimmer: true },
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
function sample(stops, t) {
  if (stops.length === 1) return stops[0];
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return mix(stops[i], stops[i + 1], x - i);
}
const RAINBOW = [[255, 80, 80], [255, 160, 50], [255, 230, 70], [80, 220, 100], [70, 170, 255], [170, 110, 255]];
// Uma "onda" de brilho percorre as letras (avança 1 letra por segundo).
function effortPaint(text, style) {
  const chars = [...text];
  const n = chars.length;
  const sec = Math.floor(Date.now() / 1000);
  const head = sec % n;
  return chars.map((ch, i) => {
    if (ch === ' ') return ch;
    if (style.rainbow) {
      const rgb = RAINBOW[(i + sec * 2) % RAINBOW.length];
      return wrap('1;38;2;' + rgb.join(';'), ch);
    }
    let rgb = sample(style.stops, n > 1 ? i / (n - 1) : 0);
    if (style.shimmer && i === head) rgb = mix(rgb, [255, 255, 255], 0.65); // só a letra da vez clareia
    return wrap(`1;38;2;${rgb[0]};${rgb[1]};${rgb[2]}`, ch);
  }).join('');
}

// ultracode: lê o fim do transcript e vê o último enter/exit
function ultracodeActive(transcriptPath) {
  let fd;
  try {
    const p = transcriptPath;
    if (!p || typeof p !== 'string') return false;
    const st = lstatSync(p);
    if (!st.isFile()) return false;
    const len = Math.min(st.size, 262144);
    const buf = Buffer.alloc(len);
    fd = openSync(p, 'r');
    readSync(fd, buf, 0, len, st.size - len);
    let active = false;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('ultra') && !line.includes('effort level')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e?.type === 'attachment') {
        if (e.attachment?.type === 'ultra_effort_enter') active = true;
        if (e.attachment?.type === 'ultra_effort_exit') active = false;
      } else if (e?.type === 'user' && typeof e.message?.content === 'string') {
        const m = /^<local-command-stdout>Set effort level to (\w+)/.exec(e.message.content);
        if (m) active = m[1].toLowerCase() === 'ultracode';
      }
    }
    return active;
  } catch { return false; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}

// tempo restante em 1 valor só (maior unidade): 3d, 2h, 45m
function until(ts) {
  if (!ts) return '';
  const sec = Math.round(Number(ts) - Date.now() / 1000);
  if (!(sec > 0)) return '';
  const m = Math.floor(sec / 60), h = Math.floor(m / 60), dd = Math.floor(h / 24);
  if (dd >= 1) return dd + 'd';
  if (h >= 1) return h + 'h';
  return m + 'm';
}

// ---- path ----
// Troca o home por "~" só na fronteira de "/" (ignora maiúsculas no Windows).
function shortenHome(dir) {
  const home = homedir().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!home) return dir;
  const ci = process.platform === 'win32';
  const a = ci ? dir.toLowerCase() : dir;
  const h = ci ? home.toLowerCase() : home;
  if (a === h) return '~';
  return a.startsWith(h + '/') ? '~' + dir.slice(home.length) : dir;
}

// Corta o início do path para caber em max colunas visuais, com "…" na frente.
function fitPath(p, max) {
  if (textWidth(p) <= max) return p;
  const chars = [...p];
  let w = 1; // o "…"
  let i = chars.length;
  while (i > 0) {
    const cw = charWidth(chars[i - 1].codePointAt(0));
    if (w + cw > max) break;
    w += cw;
    i--;
  }
  return '…' + chars.slice(i).join('');
}

function main() {
  const d = readStdin();
  const envCols = parseInt(process.env.COLUMNS ?? '', 10);
  const termCols = envCols > 0 ? envCols : (process.stdout.columns || 120);
  const outer = Math.min(termCols, 500) - 4; // margem: evita corte na borda direita
  const inner = outer - 4;                   // largura útil entre "│ " e " │"

  const model = clean(d.model?.display_name ?? '');
  const level = String(d.effort?.level ?? '').toLowerCase().replace(/[^a-z0-9()-]/g, '');
  const rawDir = d.workspace?.current_dir ?? d.cwd;
  const dir = clean(typeof rawDir === 'string' && rawDir ? rawDir : process.cwd()).replace(/\\/g, '/');
  const pathText = shortenHome(dir);

  const ultra = ultracodeActive(d.transcript_path);
  const shownLevel = ultra ? 'ultracode' : level;
  const symbol = has(SYMBOLS, level) ? SYMBOLS[level] : '';
  const effortText = shownLevel
    ? (ultra ? `${symbol} ultracode(${level})` : `${symbol} ${level}`).trim()
    : '';
  const effortStyle = has(EFFORT_STYLE, shownLevel) ? EFFORT_STYLE[shownLevel] : undefined;
  const modelSeg = model
    ? (effortStyle && effortText
        ? effortPaint('[' + model + ' ' + effortText + ']', effortStyle) // modelo segue a cor/gradiente do effort
        : paint(COLOR.model, '[' + model + (effortText ? ' ' + effortText : '') + ']'))
    : '';

  const ctxPct = pctOf(d.context_window?.used_percentage);
  const five = d.rate_limits?.five_hour?.used_percentage;
  const week = d.rate_limits?.seven_day?.used_percentage;
  const fiveReset = d.rate_limits?.five_hour?.resets_at;
  const weekReset = d.rate_limits?.seven_day?.resets_at;
  // Context sem barra, ao lado do effort
  const ctxText = ctxPct === null ? '' : paint(COLOR.label, '▤ Context') + ' ' + paint(levelColor(ctxPct), ctxPct + '%');

  const badges = [cavemanBadge(), ...extraBadges()].filter(Boolean).join(' ');

  // Linha do path, sozinha: ╭──── ~/path ────╮
  function pathLine() {
    const rule = (n) => paint(COLOR.track, '─'.repeat(Math.max(0, n)));
    const corner = (c) => paint(COLOR.track, c);
    const width = outer - 2; // entre ╭ e ╮
    const max = width - 8;
    if (max < 6) return corner('╭') + rule(width) + corner('╮');
    const label = ` ${fitPath(pathText, max)} `;
    const lw = textWidth(label);
    const lead = Math.floor((width - lw) / 2);
    return corner('╭') + rule(lead) + paint(COLOR.path, label) + rule(width - lead - lw) + corner('╮');
  }

  // Grade 2 linhas x N colunas, com espaçamento igual entre as colunas:
  //   modelo      | [Context]  | ◷ reset [5h ...]
  //   badges      |            | ◷ reset [7d ...]
  function gridRows() {
    const MIN_GAP = 3;
    const reset = (ts) => { const r = until(ts); return r ? paint(COLOR.clock, '◷ ' + r) : ''; };
    const modelCol = [modelSeg, badges];
    const resets = [reset(fiveReset), reset(weekReset)];
    const mkUsage = (w) => [br(seg('5h', five, w)), br(seg('7d', week, w))];
    const ctxCol = [br(ctxText), ''];
    // reset colado ao usage (mesma coluna): ◷ 2h [5h ...]
    const rw = Math.max(...resets.map(vis));
    const mkCombined = (w) => {
      const u = mkUsage(w);
      return u.map((cell, i) => (cell && resets[i] ? resets[i] + ' '.repeat(rw - vis(resets[i])) + ' ' + cell : cell ? ' '.repeat(rw ? rw + 1 : 0) + cell : ''));
    };
    const variants = [
      [modelCol, ctxCol, mkCombined(7)],
      [modelCol, ctxCol, mkCombined(6)],
      [modelCol, ctxCol, mkUsage(7)],
      [modelCol, ctxCol, mkUsage(6)],
      [modelCol, ctxCol, mkUsage(4)],
      [modelCol, mkUsage(4)],
      [modelCol, ctxCol],
      [modelCol],
    ].map((cs) => cs.filter((c) => c.some(Boolean)));
    const width = (c) => Math.max(...c.map(vis));
    const total = (cs) => cs.reduce((n, c) => n + width(c), 0) + MIN_GAP * (cs.length - 1);
    const chosen = variants.find((cs) => cs.length && total(cs) <= inner) ?? variants.at(-1);
    if (!chosen.length) return [' '.repeat(inner)];
    const widths = chosen.map(width);
    const free = inner - widths.reduce((n, w) => n + w, 0);
    const slots = Math.max(1, chosen.length - 1);
    const base = Math.floor(free / slots);
    let extra = free - base * slots;
    const gaps = chosen.map((_, i) => (i === chosen.length - 1 ? 0 : Math.max(1, base + (extra-- > 0 ? 1 : 0))));
    const rows = [];
    for (let r = 0; r < 2; r++) {
      let line = '';
      chosen.forEach((c, i) => {
        const cell = clip(c[r] || '', inner);
        line += cell + ' '.repeat(Math.max(0, widths[i] - vis(cell)));
        if (i < chosen.length - 1) line += ' '.repeat(gaps[i]);
      });
      line = clip(line, inner);
      rows.push(line + ' '.repeat(Math.max(0, inner - vis(line))));
    }
    return rows.filter((l, i) => i === 0 || strip(l).trim() !== '');
  }

  // Largura mínima para desenhar a caixa; abaixo disso, uma linha simples cortada.
  if (inner < 1) {
    const text = modelSeg || paint(COLOR.path, pathText);
    return clip(text, Math.max(1, termCols - 1)) + '\n';
  }

  const side = paint(COLOR.track, '│');
  const boxed = (line) => side + ' ' + line + ' ' + side;
  const out = [pathLine()];
  for (const row of gridRows()) out.push(boxed(row));
  out.push(paint(COLOR.track, '╰' + '─'.repeat(Math.max(0, outer - 2)) + '╯'));
  return out.join('\n') + '\n';
}

// Nunca imprime stack trace: qualquer erro vira saída vazia com exit 0.
process.stdout.on('error', () => {});
try {
  process.stdout.write(main());
} catch {}
process.exitCode = 0;
