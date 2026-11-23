// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

// ---- shared line machinery (SPEC.md sections 3 and 5) ----

interface FileLines {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const fin = text.endsWith(br);
  if (fin) lines.pop();
  return { lines, br, fin };
}

function joinFile(fl: FileLines): string {
  return fl.lines.length === 0 ? '' : fl.lines.join(fl.br) + (fl.fin ? fl.br : '');
}

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

function occurrences(lines: string[], O: string[], tier: number, from: number, endAtFileEnd: boolean): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    if (endAtFileEnd && i + O.length !== lines.length) continue;
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (!lineEq(lines[i + k]!, O[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with every occurrence there. */
function findMatch(
  lines: string[],
  O: string[],
  strict: boolean,
  from: number,
  endAtFileEnd = false,
): { tier: number; pos: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const pos = occurrences(lines, O, tier, from, endAtFileEnd);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** One line of a replacement: a context line (ctx = its index in O) or a fresh line (ctx -1). */
interface NLine {
  text: string;
  ctx: number;
}

/** The lines actually written when O, matched at `at` in the file, is replaced by N (SPEC.md section 5). */
function buildN(N: NLine[], O: string[], fileLines: string[], at: number, tier: number): string[] {
  return N.map((n) => {
    if (n.ctx >= 0) return fileLines[at + n.ctx]!;
    if (tier === 2 && O.length > 0) {
      const f = leadWS(fileLines[at]!);
      const p = leadWS(O[0]!);
      if (n.text.trim() !== '' && n.text.startsWith(p)) return f + n.text.slice(p.length);
    }
    return n.text;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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
}

type Edit = (tree: Tree) => void;

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

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let scanFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const at = i;
    let eq = -1;
    let rep = -1;
    for (let j = at + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${at + 1}`);
    let path: string | null = null;
    for (let j = at - 1; j >= scanFrom; j--) {
      const t = lines[j]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${at + 1}`);
    const oldLines = lines.slice(at + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const fl = splitFile(before);
      const found = findMatch(fl.lines, oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const pos = found.pos[0]!;
      const written = buildN(
        newLines.map((t) => ({ text: t, ctx: -1 })),
        oldLines,
        fl.lines,
        pos,
        found.tier,
      );
      const out = [...fl.lines.slice(0, pos), ...written, ...fl.lines.slice(pos + oldLines.length)];
      tree.now.set(p, joinFile({ lines: out, br: fl.br, fin: fl.fin }));
    });
    prevPath = path;
    scanFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---- unified diffs (SPEC.md section 6) and V4A patches (SPEC.md section 8): filled in below ----

interface UBody {
  kind: ' ' | '-' | '+';
  text: string;
  noBreak: boolean;
}

interface UHunk {
  a: number;
  body: UBody[];
}

interface USection {
  gitOld: string | undefined;
  gitNew: string | undefined;
  pairOld: string | undefined;
  pairNew: string | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hasPair: boolean;
  hunks: UHunk[];
}

function applyHunks(fl: FileLines, hunks: UHunk[], strict: boolean, path: string): FileLines {
  let lines = [...fl.lines];
  let fin = fl.fin;
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: NLine[] = [];
    let lastN: UBody | null = null;
    for (const e of h.body) {
      if (e.kind === ' ') {
        O.push(e.text);
        N.push({ text: e.text, ctx: O.length - 1 });
        lastN = e;
      } else if (e.kind === '-') {
        O.push(e.text);
      } else {
        N.push({ text: e.text, ctx: -1 });
        lastN = e;
      }
    }
    if (O.length === 0) {
      if (N.length > 0) {
        const pos = Math.max(0, Math.min(h.a + d, lines.length));
        const atEnd = pos === lines.length;
        lines = [...lines.slice(0, pos), ...N.map((n) => n.text), ...lines.slice(pos)];
        if (atEnd) fin = !(lastN !== null && lastN.noBreak);
      }
    } else {
      const found = findMatch(lines, O, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const written = buildN(N, O, lines, best, found.tier);
      const runsToEnd = best + O.length === lines.length;
      lines = [...lines.slice(0, best), ...written, ...lines.slice(best + O.length)];
      if (runsToEnd) fin = N.length > 0 ? !(lastN !== null && lastN.noBreak) : lines.length > 0;
    }
    d += N.length - O.length;
  }
  return { lines, br: fl.br, fin };
}

function unifiedEdits(lines: string[], strict: boolean, moves: Array<readonly [string, string]>): Edit[] {
  const isPairAt = (j: number): boolean =>
    (lines[j] ?? '').startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  const headerPath = (l: string): string => {
    let t = l.slice(4);
    const tab = t.indexOf('\t');
    if (tab >= 0) t = t.slice(0, tab);
    return t.trim();
  };
  const newSection = (): USection => ({
    gitOld: undefined,
    gitNew: undefined,
    pairOld: undefined,
    pairNew: undefined,
    renOld: undefined,
    renNew: undefined,
    newFile: false,
    delFile: false,
    hasPair: false,
    hunks: [],
  });
  const sections: USection[] = [];
  let sec: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = newSection();
      sec.gitOld = m[1]!;
      sec.gitNew = m[2]!;
      sections.push(sec);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { a: parseInt(m[1]!, 10), body: [] };
      sec.hunks.push(hunk);
      i++;
      const raw: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (isPairAt(i)) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          raw.push(bl);
          i++;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      let prev: UBody | null = null;
      for (const r of raw) {
        if (r.startsWith('\\')) {
          if (prev !== null) prev.noBreak = true;
          continue;
        }
        const e: UBody = { kind: r === '' ? ' ' : (r[0] as ' ' | '-' | '+'), text: r === '' ? '' : r.slice(1), noBreak: false };
        hunk.body.push(e);
        prev = e;
      }
      continue;
    }
    if (line.startsWith('--- ')) {
      if (isPairAt(i)) {
        if (sec !== null && sec.hunks.length === 0 && !sec.hasPair) {
          sec.pairOld = headerPath(line);
          sec.pairNew = headerPath(lines[i + 1]!);
          sec.hasPair = true;
        } else {
          sec = newSection();
          sec.pairOld = headerPath(line);
          sec.pairNew = headerPath(lines[i + 1]!);
          sec.hasPair = true;
          sections.push(sec);
        }
        i += 2;
        continue;
      }
      if (sec !== null && sec.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (line.startsWith('rename from ')) sec.renOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.delFile = true;
    }
    i++;
  }
  const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  return sections.map((s): Edit => {
    const oldRaw = s.pairOld !== undefined ? stripAB(s.pairOld) : s.renOld !== undefined ? s.renOld : s.gitOld;
    const newRaw = s.pairNew !== undefined ? stripAB(s.pairNew) : s.renNew !== undefined ? s.renNew : s.gitNew;
    const creation = s.newFile || oldRaw === '/dev/null';
    const deletion = s.delFile || newRaw === '/dev/null';
    if (creation) {
      return (tree) => {
        if (oldRaw !== undefined && oldRaw !== '/dev/null' && !safe(oldRaw)) throw new Fail('unsafe', oldRaw);
        const np = newRaw!;
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        let lastPlus: UBody | null = null;
        for (const h of s.hunks) {
          for (const e of h.body) {
            if (e.kind === '+') {
              plus.push(e.text);
              lastPlus = e;
            }
          }
        }
        const fin = !(lastPlus !== null && lastPlus.noBreak);
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (fin ? '\n' : ''));
      };
    }
    if (deletion) {
      return (tree) => {
        const op = oldRaw!;
        if (!safe(op)) throw new Fail('unsafe', op);
        if (newRaw !== undefined && newRaw !== '/dev/null' && !safe(newRaw)) throw new Fail('unsafe', newRaw);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      };
    }
    if (oldRaw !== newRaw) {
      return (tree) => {
        const op = oldRaw!;
        const np = newRaw!;
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const before = tree.get(op);
        if (before === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const out = applyHunks(splitFile(before), s.hunks, strict, op);
        tree.now.set(np, joinFile(out));
        tree.now.set(op, null);
        moves.push([op, np]);
      };
    }
    return (tree) => {
      const p = oldRaw!;
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const out = applyHunks(splitFile(before), s.hunks, strict, p);
      tree.now.set(p, joinFile(out));
    };
  });
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  addLines: string[];
  moveTo: string | undefined;
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean, moves: Array<readonly [string, string]>): Edit[] {
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      lastNB = j;
      break;
    }
  }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = (l: string): { kind: VSection['kind']; path: string } | null => {
    const kinds = [
      ['*** Add File:', 'add'],
      ['*** Delete File:', 'delete'],
      ['*** Update File:', 'update'],
    ] as const;
    for (const [pre, kind] of kinds) {
      if (l.startsWith(pre)) return { kind, path: l.slice(pre.length).trim() };
    }
    return null;
  };
  const sections: VSection[] = [];
  let i = firstNB + 1;
  while (i < lastNB) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const st = secStart(l);
    if (st === null) throw new Exit2(`error: parse ${i + 1}`);
    const lineNo = i + 1;
    i++;
    const content: { text: string; no: number }[] = [];
    while (i < lastNB && secStart(lines[i]!) === null) {
      content.push({ text: lines[i]!, no: i + 1 });
      i++;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (st.kind === 'add') {
      const addLines: string[] = [];
      for (const c of content) {
        if (c.text.startsWith('+')) addLines.push(c.text.slice(1));
        else if (c.text === '') addLines.push('');
        else throw new Exit2(`error: parse ${c.no}`);
      }
      sections.push({ kind: 'add', path: st.path, lineNo, addLines, moveTo: undefined, chunks: [] });
    } else if (st.kind === 'delete') {
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.no}`);
      sections.push({ kind: 'delete', path: st.path, lineNo, addLines: [], moveTo: undefined, chunks: [] });
    } else {
      let moveTo: string | undefined;
      let ci = 0;
      if (content.length > 0 && content[0]!.text.startsWith('*** Move to:')) {
        moveTo = content[0]!.text.slice('*** Move to:'.length).trim();
        ci = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let started = false;
      const close = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; ci < content.length; ci++) {
        const c = content[ci]!;
        const t = c.text;
        if (t.trim() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, O: [], N: [] };
            started = true;
          }
          cur.eof = true;
          close();
          continue;
        }
        if (t.startsWith('@@')) {
          close();
          const a = t.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, O: [], N: [] };
          started = true;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            if (started) throw new Exit2(`error: parse ${c.no}`);
            cur = { anchor: null, eof: false, O: [], N: [] };
            started = true;
          }
          if (t === '' || t[0] === ' ') {
            const txt = t === '' ? '' : t.slice(1);
            cur.O.push(txt);
            cur.N.push({ text: txt, ctx: cur.O.length - 1 });
          } else if (t[0] === '-') {
            cur.O.push(t.slice(1));
          } else {
            cur.N.push({ text: t.slice(1), ctx: -1 });
          }
          continue;
        }
        throw new Exit2(`error: parse ${c.no}`);
      }
      close();
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${lineNo}`);
      sections.push({ kind: 'update', path: st.path, lineNo, addLines: [], moveTo, chunks });
    }
  }
  return sections.map((s): Edit => {
    if (s.kind === 'add') {
      return (tree) => {
        if (!safe(s.path)) throw new Fail('unsafe', s.path);
        if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
        tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      };
    }
    if (s.kind === 'delete') {
      return (tree) => {
        if (!safe(s.path)) throw new Fail('unsafe', s.path);
        if (tree.get(s.path) === null) throw new Fail('missing', s.path);
        tree.now.set(s.path, null);
      };
    }
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (s.moveTo !== undefined && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      const before = tree.get(s.path);
      if (before === null) throw new Fail('missing', s.path);
      if (s.moveTo !== undefined && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
      const fl = splitFile(before);
      let lines = [...fl.lines];
      let cursor = 0;
      for (const ch of s.chunks) {
        if (ch.anchor !== null) {
          const found = findMatch(lines, [ch.anchor], strict, cursor);
          if (found === null) throw new Fail('no-match', s.path);
          cursor = found.pos[0]! + 1;
        }
        if (ch.O.length === 0) {
          const pos = ch.eof ? lines.length : cursor;
          const add = ch.N.map((n) => n.text);
          lines = [...lines.slice(0, pos), ...add, ...lines.slice(pos)];
          cursor = pos + add.length;
        } else {
          const found = findMatch(lines, ch.O, strict, cursor, ch.eof);
          if (found === null) throw new Fail('no-match', s.path);
          const at = found.pos[0]!;
          const written = buildN(ch.N, ch.O, lines, at, found.tier);
          lines = [...lines.slice(0, at), ...written, ...lines.slice(at + ch.O.length)];
          cursor = at + written.length;
        }
      }
      const out = joinFile({ lines, br: fl.br, fin: fl.fin });
      if (s.moveTo !== undefined) {
        tree.now.set(s.moveTo, out);
        tree.now.set(s.path, null);
        moves.push([s.path, s.moveTo]);
      } else {
        tree.now.set(s.path, out);
      }
    };
  });
}

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
  const moves: Array<readonly [string, string]> = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'search-replace'
          ? srEdits(lines, strict)
          : kind === 'v4a'
            ? v4aEdits(lines, strict, moves)
            : unifiedEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const rowIndex = new Map<string, number>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowIndex.set(p, rows.length);
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // A successful move replaces its D and A rows with one R row, sorted by the new path (section 2).
  const replaced = new Set<number>();
  for (const [o, n] of moves) {
    if (tree.original(o) === null || tree.get(o) !== null || tree.original(n) !== null || tree.get(n) === null) continue;
    const di = rowIndex.get(o);
    const ai = rowIndex.get(n);
    if (di === undefined || ai === undefined) continue;
    replaced.add(di);
    replaced.add(ai);
    rows.push({ key: n, text: `R ${o} -> ${n}` });
  }
  const out = rows
    .filter((_, i) => !replaced.has(i))
    .sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)))
    .map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
