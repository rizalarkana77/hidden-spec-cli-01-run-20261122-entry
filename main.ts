// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.
// Reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits,
// finds each edit's old lines at the first of three matching tiers, and
// writes every change or none. The trial hand-over at the bottom is the
// kit's runner hook: keep it as it is.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Original path -> current path for files a move edit moved. */
  readonly moves = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  move(oldP: string, newP: string): void {
    let orig = oldP;
    for (const [o, c] of this.moves) {
      if (c === oldP) {
        orig = o;
        break;
      }
    }
    this.moves.set(orig, newP);
    this.now.set(oldP, null);
  }
}

type Edit = (tree: Tree) => void;

/** A file split into lines: its break, its lines, whether it ends with a break. */
interface FileState {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/* ---- Matching (SPEC.md section 5) ---- */

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrencesAt(lines: string[], o: string[], tier: number, from = 0): number[] {
  const pos: number[] = [];
  if (o.length === 0) return pos;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier (0 only when strict) with an occurrence at or after `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const p = occurrencesAt(lines, o, t, from);
    if (p.length > 0) return { tier: t, pos: p };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/**
 * Replace O at `at` by N. A context line is written as the file's own matched
 * line (its `oi` is its index in O, since added lines shift N past O);
 * any other line of N is re-indented at tier 2: the leading spaces and
 * tabs of O's first line are replaced by those of the file's first matched line.
 */
function replaceLines(f: FileState, o: string[], n: { text: string; ctx: boolean; oi: number }[], at: number, tier: number): string[] {
  const out: string[] = f.lines.slice(0, at);
  const pfx = o.length > 0 ? leadingWs(o[0]!) : '';
  const ffx = o.length > 0 ? leadingWs(f.lines[at]!) : '';
  for (let j = 0; j < n.length; j++) {
    const line = n[j]!;
    if (line.ctx) {
      out.push(f.lines[at + line.oi]!);
      continue;
    }
    let t = line.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(pfx)) t = ffx + t.slice(pfx.length);
    out.push(t);
  }
  out.push(...f.lines.slice(at + o.length));
  return out;
}

/* ---- Format detection (section 4) ---- */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---- JSON edits (section 9) ---- */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Unified diffs (section 6) ---- */

interface HunkBodyLine {
  ch: ' ' | '-' | '+';
  text: string;
  noNl: boolean;
}
interface Hunk {
  a: number;
  body: HunkBodyLine[];
}
interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

function headerPath(l: string): string {
  return l.slice(4).split('\t')[0]!.trim();
}

function stripAB(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[]): UniSection[] {
  const isDiffGit = (l: string): boolean => l.startsWith('diff --git ');
  const isFileHeader = (l: string, j: number): boolean => l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  const sections: UniSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (isDiffGit(l) || isFileHeader(l, i)) break;
    i++;
  }
  while (i < lines.length) {
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let creation = false;
    let deletion = false;
    let headerPair = false;
    if (isDiffGit(lines[i]!)) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[i]!);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      oldPath = m[1]!;
      newPath = m[2]!;
      i++;
    } else if (isFileHeader(lines[i]!, i)) {
      // A bare section: its own ---/+++ pair is its header.
      oldPath = stripAB(headerPath(lines[i]!));
      newPath = stripAB(headerPath(lines[i + 1]!));
      headerPair = true;
      i += 2;
    }
    const hunks: Hunk[] = [];
    let inSection = true;
    while (i < lines.length && inSection) {
      const l = lines[i]!;
      if (l.startsWith('@@')) {
        const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?: |$)/.exec(l);
        if (!hm) throw new Exit2(`error: parse ${i + 1}`);
        const a = Number(hm[1]);
        i++;
        const body: HunkBodyLine[] = [];
        while (i < lines.length) {
          const b = lines[i]!;
          if (isDiffGit(b) || isFileHeader(b, i)) break;
          if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
            body.push({ ch: b === '' ? ' ' : (b[0] as ' ' | '-' | '+'), text: b === '' ? '' : b.slice(1), noNl: false });
            i++;
          } else if (b.startsWith('\\')) {
            if (body.length > 0) body[body.length - 1]!.noNl = true;
            i++;
          } else break;
        }
        while (body.length > 0) {
          const last = body[body.length - 1]!;
          if (last.ch === ' ' && last.text === '') body.pop();
          else break;
        }
        hunks.push({ a, body });
        continue;
      }
      if (isDiffGit(l)) {
        inSection = false;
        break;
      }
      if (isFileHeader(l, i)) {
        if (headerPair) {
          // A later pair starts a new section; the first pair is this section's header.
          inSection = false;
          break;
        }
        oldPath = stripAB(headerPath(l));
        newPath = stripAB(headerPath(lines[i + 1]!));
        headerPair = true;
        i += 2;
        continue;
      }
      if (l.startsWith('--- ')) {
        // Still in the header only while no hunk has been seen.
        if (hunks.length > 0) {
          i++;
          continue;
        }
        const nx = lines[i + 1];
        if (nx === undefined || !nx.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        oldPath = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        newPath = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        creation = true;
        i++;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        deletion = true;
        i++;
        continue;
      }
      i++;
    }
    sections.push({ oldPath, newPath, creation, deletion, hunks });
  }
  return sections;
}

/** Apply a section's hunks in order to a file's text. */
function applyUnifiedHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const n: { text: string; ctx: boolean; oi: number }[] = [];
    let lastCtxPlus = -1;
    for (let k = 0; k < h.body.length; k++) {
      const b = h.body[k]!;
      if (b.ch === ' ') {
        o.push(b.text);
        n.push({ text: b.text, ctx: true, oi: o.length - 1 });
        lastCtxPlus = k;
      } else if (b.ch === '-') {
        o.push(b.text);
      } else {
        n.push({ text: b.text, ctx: false, oi: -1 });
        lastCtxPlus = k;
      }
    }
    const backslash = lastCtxPlus >= 0 && h.body[lastCtxPlus]!.noNl;
    if (o.length === 0) {
      const at = Math.min(h.a + d, f.lines.length);
      const toEnd = at === f.lines.length;
      const lines = [...f.lines.slice(0, at), ...n.map((x) => x.text), ...f.lines.slice(at)];
      f = { ...f, lines, final: toEnd ? !backslash : f.final };
    } else {
      const found = findTier(f.lines, o, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const toEnd = best + o.length === f.lines.length;
      const lines = replaceLines(f, o, n, best, found.tier);
      f = { ...f, lines, final: toEnd ? !backslash : f.final };
    }
    d += n.length - o.length;
  }
  return joinFile(f);
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = sec.creation || oldP === null;
    const isDelete = !isCreate && (sec.deletion || newP === null);
    if (isCreate) {
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastPlusNoNl = false;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.ch === '+') {
            plus.push(b.text);
            lastPlusNoNl = b.noNl;
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      // Move.
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyUnifiedHunks(cur, sec.hunks, strict, oldP);
      tree.move(oldP, newP);
      tree.now.set(newP, out);
      return;
    }
    const p = oldP ?? newP;
    if (p === null) return;
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    tree.now.set(p, applyUnifiedHunks(cur, sec.hunks, strict, p));
  };
}

/* ---- SEARCH/REPLACE blocks (section 7) ---- */

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
  searchLine: number;
}

function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let end = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (eq < 0 || end < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, end), searchLine: s + 1 });
    prevEnd = end + 1;
    prevPath = path;
    i = end + 1;
  }
  return blocks;
}

function srEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const f = splitFile(cur);
    const found = findTier(f.lines, b.oldLines, strict);
    if (!found) throw new Fail('no-match', b.path);
    if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
    const n = b.newLines.map((t) => ({ text: t, ctx: false, oi: -1 }));
    const outLines = replaceLines(f, b.oldLines, n, found.pos[0]!, found.tier);
    tree.now.set(b.path, joinFile({ ...f, lines: outLines }));
  };
}

/* ---- V4A patches (section 8) ---- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: { ch: ' ' | '-' | '+'; text: string }[];
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
  lineNo: number;
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSecStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i++;
      const flines: string[] = [];
      while (i < last) {
        const b = lines[i]!;
        if (isSecStart(b) || b.trim() === '*** End Patch') break;
        if (b === '') {
          flines.push('');
          i++;
          continue;
        }
        if (b.startsWith('+')) {
          flines.push(b.slice(1));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (flines.length > 0 && flines[flines.length - 1] === '') flines.pop();
      sections.push({ kind: 'add', path, moveTo: null, addLines: flines, chunks: [], lineNo: i + 1 });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last && blank(lines[i]!)) i++;
      if (i < last && !isSecStart(lines[i]!) && lines[i]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${i + 1}`);
      sections.push({ kind: 'delete', path, moveTo: null, addLines: [], chunks: [], lineNo: i + 1 });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const lineNo = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let firstChunk = true;
      const endChunk = (dropTrailing: boolean): void => {
        if (cur === null) return;
        if (dropTrailing) {
          while (cur.body.length > 0) {
            const b = cur.body[cur.body.length - 1]!;
            if (b.ch === ' ' && b.text === '') cur.body.pop();
            else break;
          }
        }
        chunks.push(cur);
        cur = null;
      };
      while (i < last) {
        const b = lines[i]!;
        if (isSecStart(b) || b.trim() === '*** End Patch') break;
        if (b.startsWith('@@')) {
          endChunk(false);
          const anchor = b.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          firstChunk = false;
          i++;
          continue;
        }
        if (b.trim() === '*** End of File') {
          if (cur === null) cur = { anchor: null, eof: true, body: [] };
          else cur.eof = true;
          endChunk(false);
          firstChunk = false;
          i++;
          continue;
        }
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (cur === null) {
            if (!firstChunk) {
              // A blank line between chunks is ignored; a body line is not.
              if (b === '') {
                i++;
                continue;
              }
              throw new Exit2(`error: parse ${i + 1}`);
            }
            cur = { anchor: null, eof: false, body: [] };
            firstChunk = false;
          }
          cur.body.push({ ch: b === '' ? ' ' : (b[0] as ' ' | '-' | '+'), text: b === '' ? '' : b.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      endChunk(true);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${lineNo}`);
      sections.push({ kind: 'update', path, moveTo, addLines: [], chunks, lineNo });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections;
}

function applyV4aChunks(text: string, chunks: VChunk[], strict: boolean, path: string): string {
  let f = splitFile(text);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let idx = -1;
      const top = strict ? 0 : 2;
      for (let t = 0; t <= top && idx < 0; t++) {
        for (let k = cursor; k < f.lines.length; k++) {
          if (normLine(f.lines[k]!, t) === normLine(ch.anchor, t)) {
            idx = k;
            break;
          }
        }
      }
      if (idx < 0) throw new Fail('no-match', path);
      cursor = idx + 1;
    }
    const o: string[] = [];
    const n: { text: string; ctx: boolean; oi: number }[] = [];
    for (const b of ch.body) {
      if (b.ch === ' ') {
        o.push(b.text);
        n.push({ text: b.text, ctx: true, oi: o.length - 1 });
      } else if (b.ch === '-') {
        o.push(b.text);
      } else {
        n.push({ text: b.text, ctx: false, oi: -1 });
      }
    }
    if (o.length === 0) {
      const at = ch.eof ? f.lines.length : cursor;
      const outLines = [...f.lines.slice(0, at), ...n.map((x) => x.text), ...f.lines.slice(at)];
      f = { ...f, lines: outLines };
      cursor = at + n.length;
    } else {
      const found = findTier(f.lines, o, strict, cursor);
      let pos = found ? found.pos : [];
      if (ch.eof && found) pos = pos.filter((p) => p + o.length === f.lines.length);
      if (pos.length === 0 || !found) throw new Fail('no-match', path);
      const at = pos[0]!;
      const outLines = replaceLines(f, o, n, at, found.tier);
      f = { ...f, lines: outLines };
      cursor = at + n.length;
    }
  }
  return joinFile(f);
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (sec.kind === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const cur = tree.get(sec.path);
    if (cur === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const out = applyV4aChunks(cur, sec.chunks, strict, sec.path);
    if (sec.moveTo !== null) {
      tree.move(sec.path, sec.moveTo);
      tree.now.set(sec.moveTo, out);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

/* ---- Run (sections 1, 2, 10) ---- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines).map((b) => srEdit(b, strict));
    else edits = parseV4a(lines).map((s) => v4aEdit(s, strict));
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const consumed = new Set<string>();
  for (const [orig, cur] of tree.moves) {
    if (tree.original(orig) !== null && tree.get(orig) === null && tree.original(cur) === null && tree.get(cur) !== null) {
      rows.push({ key: cur, text: `R ${orig} -> ${cur}` });
      consumed.add(orig);
      consumed.add(cur);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
