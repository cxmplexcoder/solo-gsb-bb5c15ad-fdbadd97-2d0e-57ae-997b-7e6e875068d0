import type { Cue } from '../types';
import { MIN_DURATION } from './time';

const EPS = 1e-6;

/** 支持拆分的内联标签名（须正确嵌套） */
const KNOWN_TAGS = new Set(['b', 'i', 'u', 'c', 'v', 'lang']);

/** WebVTT 实体：命名实体与十/十六进制数字实体，各计 1 字、原样保留 */
const ENTITY_RE = /^&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);/;

/** 内联时间戳，如 <00:00:01.000> */
const TIMESTAMP_RE = /^\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}/;

export type Token =
  | { kind: 'text'; value: string } // 可见文本（按 Unicode 码点计字，换行计 1 字）
  | { kind: 'entity'; value: string } // 实体：计 1 字、原样保留
  | { kind: 'open'; value: string; name: string } // 开标签（value 为原文，重开时原样使用）
  | { kind: 'close'; value: string; name: string }; // 闭合标签

export type OpenToken = Extract<Token, { kind: 'open' }>;

export type TokenizeResult =
  | { ok: true; tokens: Token[] }
  | { ok: false; error: string };

/**
 * 把字幕正文切分为 文本 / 实体 / 标签 token，并校验标签合法性：
 * - 仅支持 b/i/u/c/v/lang，且须正确嵌套（闭合标签匹配最内层开标签、结尾无未闭合标签）；
 * - 未知标签、不配对/交错标签、不完整标签、内联时间戳一律报错。
 */
export function tokenizeCueText(text: string): TokenizeResult {
  const tokens: Token[] = [];
  let buf = '';
  const flush = () => {
    if (buf !== '') {
      tokens.push({ kind: 'text', value: buf });
      buf = '';
    }
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '<') {
      const gt = text.indexOf('>', i + 1);
      if (gt === -1) return { ok: false, error: '存在不完整的标签（< 后缺少 >）' };
      const inner = text.slice(i + 1, gt);
      const raw = text.slice(i, gt + 1);
      if (TIMESTAMP_RE.test(inner)) {
        return { ok: false, error: `不支持内联时间戳 ${raw}，请先移除后再拆分` };
      }
      const m = inner.match(/^(\/)?([A-Za-z][A-Za-z0-9]*)([\s\S]*)$/);
      if (!m) return { ok: false, error: `无法识别的标签 ${raw}` };
      const isClose = m[1] === '/';
      const name = m[2].toLowerCase();
      if (!KNOWN_TAGS.has(name)) {
        return { ok: false, error: `不支持的标签 ${raw}（仅支持 b/i/u/c/v/lang）` };
      }
      if (isClose && m[3].trim() !== '') {
        return { ok: false, error: `闭合标签 ${raw} 不能带类名或注解` };
      }
      flush();
      tokens.push(
        isClose
          ? { kind: 'close', value: raw, name }
          : { kind: 'open', value: raw, name },
      );
      i = gt + 1;
    } else if (ch === '&') {
      const m = text.slice(i).match(ENTITY_RE);
      if (m) {
        flush();
        tokens.push({ kind: 'entity', value: m[0] });
        i += m[0].length;
      } else {
        buf += ch; // 裸露的 & 不是实体，按普通可见字符计
        i++;
      }
    } else {
      buf += ch;
      i++;
    }
  }
  flush();

  // 校验正确嵌套：闭合标签必须匹配最内层未闭合的开标签
  const stack: OpenToken[] = [];
  for (const t of tokens) {
    if (t.kind === 'open') {
      stack.push(t);
    } else if (t.kind === 'close') {
      const top = stack[stack.length - 1];
      if (!top || top.name !== t.name) {
        return { ok: false, error: `标签 ${t.value} 与开标签不配对或嵌套交错` };
      }
      stack.pop();
    }
  }
  if (stack.length > 0) {
    return { ok: false, error: `标签 ${stack[stack.length - 1].value} 未闭合` };
  }
  return { ok: true, tokens };
}

/** 统计 token 序列的可见字数：文本按 Unicode 码点计，实体计 1，标签不计 */
export function countTokens(tokens: Token[]): number {
  let n = 0;
  for (const t of tokens) {
    if (t.kind === 'text') n += [...t.value].length;
    else if (t.kind === 'entity') n += 1;
  }
  return n;
}

export interface SplitPreview {
  total: number; // 总可见字数
  splitTime: number; // 分割点（秒，已四舍五入到毫秒）
  leftStart: number;
  leftEnd: number;
  rightStart: number;
  rightEnd: number;
  leftCount: number; // 左段可见字数（= N）
  rightCount: number; // 右段可见字数（= total − N）
  leftText: string;
  rightText: string;
}

export type SplitResult =
  | { ok: true; preview: SplitPreview }
  | { ok: false; error: string };

/**
 * 预览按切点 N 拆分一条字幕：
 * - N 按可见 Unicode 码点计（换行计 1 字、标签不计、实体各计 1 字），须为整数且两段非空；
 * - 切点处仍开放的标签按嵌套顺序闭合左段、按原顺序原样重开右段；
 * - 分割时间 = 原起点 + 原时长 × N / 总字数，四舍五入到毫秒；两段首尾相接、保留原起止；
 * - 任一段不足 300ms 时报错（禁止应用）。
 */
export function previewSplit(cue: Cue, n: number): SplitResult {
  const tk = tokenizeCueText(cue.text);
  if (!tk.ok) return tk;
  const total = countTokens(tk.tokens);
  if (total < 2) {
    return { ok: false, error: '可见文本不足 2 字，无法拆分为两段非空字幕' };
  }
  if (!Number.isInteger(n)) {
    return { ok: false, error: '切点 N 须为整数' };
  }
  if (n < 1 || n > total - 1) {
    return { ok: false, error: `切点 N 须在 1 ~ ${total - 1} 之间（共 ${total} 字，两段均须非空）` };
  }

  const [leftTokens, rightTokens] = splitTokens(tk.tokens, n);
  const splitTime =
    Math.round((cue.start + ((cue.end - cue.start) * n) / total) * 1000) / 1000;
  const leftMs = Math.round((splitTime - cue.start) * 1000);
  const rightMs = Math.round((cue.end - splitTime) * 1000);
  if (
    splitTime - cue.start < MIN_DURATION - EPS ||
    cue.end - splitTime < MIN_DURATION - EPS
  ) {
    return {
      ok: false,
      error: `拆分后两段为 ${leftMs}ms / ${rightMs}ms，任一段不足 300ms，禁止应用`,
    };
  }

  return {
    ok: true,
    preview: {
      total,
      splitTime,
      leftStart: cue.start,
      leftEnd: splitTime,
      rightStart: splitTime,
      rightEnd: cue.end,
      leftCount: n,
      rightCount: total - n,
      leftText: stringify(leftTokens),
      rightText: stringify(rightTokens),
    },
  };
}

/**
 * 应用拆分：用两条新 id 的字幕在原位置替换原条，其他字幕保持原引用。
 * 校验失败或找不到目标时原样返回（相同引用 ⇒ 撤销历史不产生记录）。
 */
export function applySplit(cues: Cue[], id: string, n: number): Cue[] {
  const idx = cues.findIndex((c) => c.id === id);
  if (idx === -1) return cues;
  const r = previewSplit(cues[idx], n);
  if (!r.ok) return cues;
  const p = r.preview;
  const orig = cues[idx];
  const left: Cue = { ...orig, id: makeId(), start: p.leftStart, end: p.leftEnd, text: p.leftText };
  const right: Cue = { ...orig, id: makeId(), start: p.rightStart, end: p.rightEnd, text: p.rightText };
  const next = [...cues];
  next.splice(idx, 1, left, right);
  return next;
}

/**
 * 在可见第 N 字之后切开 token 序列。
 * 归一化：切点处的闭合标签归入左段、开标签归入右段；
 * 仍开放的标签在左段末尾按嵌套逆序闭合，在右段开头按原顺序原样重开。
 */
function splitTokens(tokens: Token[], n: number): [Token[], Token[]] {
  const left: Token[] = [];
  const right: Token[] = [];
  let count = 0;
  let i = 0;

  // 1) 消费左侧，直到可见字数恰好达到 N（文本 token 可按码点切开，实体不可拆散）
  while (i < tokens.length && count < n) {
    const t = tokens[i];
    if (t.kind === 'text') {
      const chars = [...t.value];
      const need = n - count;
      if (chars.length <= need) {
        left.push(t);
        count += chars.length;
      } else {
        left.push({ kind: 'text', value: chars.slice(0, need).join('') });
        right.push({ kind: 'text', value: chars.slice(need).join('') });
        count = n;
      }
    } else if (t.kind === 'entity') {
      left.push(t);
      count += 1;
    } else {
      left.push(t); // 标签不计字，先放左侧，下方归一化
    }
    i++;
  }
  for (; i < tokens.length; i++) right.push(tokens[i]);

  // 2) 切点处的闭合标签属于左侧已开启的标签，移入左段（避免右段出现空标签对）
  while (right.length > 0 && right[0].kind === 'close') {
    left.push(right.shift()!);
  }
  // 3) 防御性归一化：左段末尾未包裹任何可见字符的开标签移入右段
  while (left.length > 0 && left[left.length - 1].kind === 'open') {
    right.unshift(left.pop()!);
  }

  // 4) 切点处仍开放的标签：左段按嵌套逆序闭合，右段按原顺序原样重开
  const openStack: OpenToken[] = [];
  for (const t of left) {
    if (t.kind === 'open') openStack.push(t);
    else if (t.kind === 'close') openStack.pop();
  }
  for (let k = openStack.length - 1; k >= 0; k--) {
    const t = openStack[k];
    left.push({ kind: 'close', value: `</${t.name}>`, name: t.name });
  }
  for (let k = openStack.length - 1; k >= 0; k--) {
    right.unshift(openStack[k]);
  }
  return [left, right];
}

function stringify(tokens: Token[]): string {
  return tokens.map((t) => t.value).join('');
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `cue-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
