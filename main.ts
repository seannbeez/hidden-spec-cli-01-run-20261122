// mend — one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, the V4A
// patch format, text-editor tool calls as JSON) and applies it to the tree of text
// files rooted at the working directory. Every file changes or none does. The whole
// contract is SPEC.md (version 1) in this repository: exit codes, stdout, the files
// left behind, and the three matching tiers are all decided there, sentence by
// sentence. Node 22, standard library only; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and this
// file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: the one line to print, nothing else. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's failure: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const stripEnd = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** A patch's lines: split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One file as lines: its own break, its lines, and whether it ended with a break. */
interface FileText {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const firstNl = text.indexOf('\n');
  const br = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function renderFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** A file an edit creates: LF breaks, ending with one unless it has no lines. */
function renderCreated(lines: string[]): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + '\n';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; next: string }[] = [];
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
  snapshot(): { now: Map<string, string | null>; moves: { old: string; next: string }[] } {
    return { now: new Map(this.now), moves: this.moves.map((m) => ({ ...m })) };
  }
  restore(s: { now: Map<string, string | null>; moves: { old: string; next: string }[] }): void {
    this.now.clear();
    for (const [k, v] of s.now) this.now.set(k, v);
    this.moves.length = 0;
    for (const m of s.moves) this.moves.push({ ...m });
  }
}

type Edit = (tree: Tree) => void;

/** One body line of a hunk or chunk: context, removed, added, or a backslash line. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  /** The line's text after its one-character marker ('' for an empty context line). */
  text: string;
  /** True when the patch line itself was empty (a bare context line). */
  bare: boolean;
}

const oldLinesOf = (items: BodyLine[]): string[] =>
  items.filter((b) => b.kind === 'ctx' || b.kind === 'del').map((b) => b.text);

/** Whether two lines are equal at a tier: 0 exact, 1 trailing space/tab stripped, 2 both ends stripped. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripEnd(a) === stripEnd(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every position where the pattern occurs in the lines, from `from` on; occurrences may overlap. */
function occurrences(lines: string[], pat: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  for (let i = from; i + pat.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < pat.length; j += 1) {
      if (!lineEq(lines[i + j]!, pat[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 under --strict) at which the pattern occurs, from `from` on. */
function findAtTier(
  lines: string[],
  pat: string[],
  strict: boolean,
  from: number,
): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrences(lines, pat, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/**
 * The replacement for a matched block: context lines are written as the file's own
 * matched lines, never the patch's; at tier 2 every other new line is re-indented,
 * replacing the leading spaces/tabs P of the pattern's first line with F, the leading
 * spaces/tabs of the file's first matched line. A line that starts with P has that P
 * replaced by F — with P empty that prepends F, exactly as SPEC.md's sentence says.
 */
function buildReplacement(fileLines: string[], at: number, items: BodyLine[], tier: number): string[] {
  const o = oldLinesOf(items);
  const f = tier === 2 && o.length > 0 ? leadWs(fileLines[at]!) : '';
  const p = tier === 2 && o.length > 0 ? leadWs(o[0]!) : '';
  const out: string[] = [];
  let oi = 0;
  for (const b of items) {
    if (b.kind === 'ctx') {
      out.push(fileLines[at + oi]!);
      oi += 1;
    } else if (b.kind === 'del') {
      oi += 1;
    } else if (b.kind === 'add') {
      if (tier === 2 && b.text !== '' && b.text.trim() !== '' && b.text.startsWith(p)) {
        out.push(f + b.text.slice(p.length));
      } else {
        out.push(b.text);
      }
    }
  }
  return out;
}

/** Whether a backslash line follows the hunk's last context or added line (it refers to that line). */
function backslashAfterLastNew(items: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i]!.kind === 'ctx' || items[i]!.kind === 'add') last = i;
  }
  if (last < 0) return false;
  return items[last + 1] !== undefined && items[last + 1]!.kind === 'bs';
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const readExisting = (tree: Tree): string => {
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
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = readExisting(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = readExisting(tree);
      const f = parseFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, renderFile(f));
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

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

interface UnifiedHunk {
  /** The old start line A of `@@ -A[,B] +C[,D] @@`. B and D are not used. */
  a: number;
  body: BodyLine[];
}

interface UnifiedSection {
  /** null: the header named /dev/null; undefined: the header named no path. */
  oldRaw: string | null | undefined;
  newRaw: string | null | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UnifiedHunk[];
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a `--- ` or `+++ ` line names: after its four characters, up to the first tab, trimmed. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function isBodyLine(l: string): boolean {
  return l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
}

function toBodyLine(l: string): BodyLine {
  if (l === '') return { kind: 'ctx', text: '', bare: true };
  if (l[0] === ' ') return { kind: 'ctx', text: l.slice(1), bare: false };
  if (l[0] === '-') return { kind: 'del', text: l.slice(1), bare: false };
  if (l[0] === '+') return { kind: 'add', text: l.slice(1), bare: false };
  return { kind: 'bs', text: l.slice(1), bare: false };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inBody = false;
  const startSection = (): UnifiedSection => {
    const s: UnifiedSection = { oldRaw: undefined, newRaw: undefined, newFile: false, deletedFile: false, hunks: [] };
    sections.push(s);
    return s;
  };
  const closeBody = (): void => {
    if (!inBody || cur === null || cur.hunks.length === 0) {
      inBody = false;
      return;
    }
    const body = cur.hunks[cur.hunks.length - 1]!.body;
    while (body.length > 0) {
      const last = body[body.length - 1]!;
      if (last.kind === 'ctx' && last.text === '' && last.bare) body.pop();
      else break;
    }
    inBody = false;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (inBody) {
      // A `diff --git` line, or a `--- ` line followed by a `+++ ` line, ends the
      // body even though the `--- ` line starts with `-`: it is a new section.
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        closeBody();
        continue;
      }
      if (isBodyLine(line)) {
        cur!.hunks[cur!.hunks.length - 1]!.body.push(toBodyLine(line));
        i += 1;
        continue;
      }
      closeBody();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = startSection();
      cur.oldRaw = m[1]!;
      cur.newRaw = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.hunks.push({ a: Number(m[1]), body: [] });
      inBody = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0) {
        cur = startSection();
      }
      cur.oldRaw = headerPath(line);
      cur.newRaw = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.oldRaw = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.newRaw = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i += 1;
  }
  closeBody();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply one section's hunks to a file's lines, in order, tracking the drift d. */
function applyHunks(f: FileText, hunks: UnifiedHunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    const o = oldLinesOf(h.body);
    const nLen = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'add').length;
    if (o.length > 0) {
      const found = findAtTier(f.lines, o, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.at[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.at) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const runsToEnd = best + o.length === f.lines.length;
      const repl = buildReplacement(f.lines, best, h.body, found.tier);
      f.lines.splice(best, o.length, ...repl);
      if (runsToEnd) f.finalBreak = !backslashAfterLastNew(h.body);
      d += nLen - o.length;
    } else {
      const at = Math.min(h.a + d, f.lines.length);
      const runsToEnd = at === f.lines.length;
      const repl = buildReplacement(f.lines, at, h.body, 0);
      f.lines.splice(at, 0, ...repl);
      if (runsToEnd) f.finalBreak = !backslashAfterLastNew(h.body);
      d += nLen;
    }
  }
}

function unifiedEdit(s: UnifiedSection, strict: boolean): Edit {
  const isCreate = s.oldRaw === null || s.newFile;
  const isDelete = !isCreate && (s.newRaw === null || s.deletedFile);
  const oldPath = s.oldRaw === undefined ? undefined : s.oldRaw;
  const newPath = s.newRaw === undefined ? undefined : s.newRaw;
  if (isCreate) {
    const p = newPath === undefined || newPath === null ? '/dev/null' : newPath;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const added: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.kind === 'add') added.push(b.text);
      if (added.length === 0) {
        tree.now.set(p, '');
        return;
      }
      let noBreak = false;
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi -= 1) {
        const body = s.hunks[hi]!.body;
        for (let bi = body.length - 1; bi >= 0; bi -= 1) {
          if (body[bi]!.kind === 'add') {
            noBreak = body[bi + 1] !== undefined && body[bi + 1]!.kind === 'bs';
            break outer;
          }
        }
      }
      tree.now.set(p, added.join('\n') + (noBreak ? '' : '\n'));
    };
  }
  if (isDelete) {
    const p = oldPath === undefined || oldPath === null ? '/dev/null' : oldPath;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const oldP = oldPath === undefined ? newPath : oldPath;
  const newP = newPath === undefined ? oldPath : newPath;
  if (
    oldP !== undefined &&
    newP !== undefined &&
    oldP !== null &&
    newP !== null &&
    oldP !== newP
  ) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const f = parseFile(before);
      applyHunks(f, s.hunks, oldP, strict);
      tree.now.set(oldP, null);
      tree.now.set(newP, renderFile(f));
      tree.moves.push({ old: oldP, next: newP });
    };
  }
  const p = (oldP === undefined || oldP === null ? newP : oldP) ?? '/dev/null';
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = parseFile(before);
    applyHunks(f, s.hunks, p, strict);
    tree.now.set(p, renderFile(f));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

const isSearchLine = (l: string): boolean => l.trimEnd() === '<<<<<<< SEARCH';
const isSepLine = (l: string): boolean => l.trimEnd() === '=======';
const isReplaceLine = (l: string): boolean => l.trimEnd() === '>>>>>>> REPLACE';

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (let s = 0; s < lines.length; s += 1) {
    if (!isSearchLine(lines[s]!)) continue;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let sep = -1;
    let end = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      if (isSepLine(lines[k]!)) {
        sep = k;
        break;
      }
      if (isReplaceLine(lines[k]!)) throw new Exit2(`error: parse ${s + 1}`);
    }
    if (sep < 0) throw new Exit2(`error: parse ${s + 1}`);
    for (let k = sep + 1; k < lines.length; k += 1) {
      if (isReplaceLine(lines[k]!)) {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    prevEnd = end;
    prevPath = path;
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  const items: BodyLine[] = [
    ...oldLines.map((t): BodyLine => ({ kind: 'del' as const, text: t, bare: false })),
    ...newLines.map((t): BodyLine => ({ kind: 'add' as const, text: t, bare: false })),
  ];
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, renderCreated(newLines));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = parseFile(before);
    const found = findAtTier(f.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const repl = buildReplacement(f.lines, found.at[0]!, items, found.tier);
    f.lines.splice(found.at[0]!, oldLines.length, ...repl);
    tree.now.set(path, renderFile(f));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  /** null: the chunk has no @@ line (first chunk starting at a body line). */
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

type V4aSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[] };

const ADD_PREFIX = '*** Add File: ';
const DELETE_PREFIX = '*** Delete File: ';
const UPDATE_PREFIX = '*** Update File: ';
const MOVE_PREFIX = '*** Move to: ';

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = lines.findLastIndex((l) => !blank(l));
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith(ADD_PREFIX)) {
      kind = 'add';
      path = line.slice(ADD_PREFIX.length).trim();
    } else if (line.startsWith(DELETE_PREFIX)) {
      kind = 'delete';
      path = line.slice(DELETE_PREFIX.length).trim();
    } else if (line.startsWith(UPDATE_PREFIX)) {
      kind = 'update';
      path = line.slice(UPDATE_PREFIX.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i;
    i += 1;
    const raw: { text: string; no: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith(ADD_PREFIX) || l.startsWith(DELETE_PREFIX) || l.startsWith(UPDATE_PREFIX)) break;
      raw.push({ text: l, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      sections.push({ kind, path, lines: fileLines });
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.no}`);
      }
      sections.push({ kind, path });
    } else {
      let moveTo: string | null = null;
      let at = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith(MOVE_PREFIX)) {
        moveTo = raw[0]!.text.slice(MOVE_PREFIX.length).trim();
        at = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; at < raw.length; at += 1) {
        const r = raw[at]!;
        const l = r.text;
        if (l.startsWith('@@')) {
          closeChunk();
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.no}`);
          cur.eof = true;
          closeChunk();
          continue;
        }
        if (cur === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
          cur = { anchor: null, body: [], eof: false };
        }
        if (l === '') cur.body.push({ kind: 'ctx', text: '', bare: true });
        else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1), bare: false });
        else if (l[0] === '-') cur.body.push({ kind: 'del', text: l.slice(1), bare: false });
        else if (l[0] === '+') cur.body.push({ kind: 'add', text: l.slice(1), bare: false });
        else throw new Exit2(`error: parse ${r.no}`);
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine + 1}`);
      sections.push({ kind, path, moveTo, chunks });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: V4aSection, strict: boolean): Edit {
  if (s.kind === 'add') {
    const p = s.path;
    const fileLines = s.lines;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, renderCreated(fileLines));
    };
  }
  if (s.kind === 'delete') {
    const p = s.path;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const p = s.path;
  const moveTo = s.moveTo;
  const chunks = s.chunks;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findAtTier(f.lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', p);
        cursor = found.at[0]! + 1;
      }
      const o = oldLinesOf(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const repl = buildReplacement(f.lines, at, ch.body, 0);
        f.lines.splice(at, 0, ...repl);
        cursor = at + repl.length;
        continue;
      }
      let picked: { tier: number; at: number } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const at = occurrences(f.lines, o, t, cursor);
        const good = ch.eof ? at.filter((x) => x + o.length === f.lines.length) : at;
        if (good.length > 0) {
          picked = { tier: t, at: good[0]! };
          break;
        }
      }
      if (picked === null) throw new Fail('no-match', p);
      const repl = buildReplacement(f.lines, picked.at, ch.body, picked.tier);
      f.lines.splice(picked.at, o.length, ...repl);
      cursor = picked.at + repl.length;
    }
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, renderFile(f));
      tree.moves.push({ old: p, next: moveTo });
    } else {
      tree.now.set(p, renderFile(f));
    }
  };
}

// ---------------------------------------------------------------------------
// Command line, output and exit codes (sections 1 and 2)
// ---------------------------------------------------------------------------

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
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.restore(before);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const covered = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.original(m.next) === null && tree.get(m.old) === null && tree.get(m.next) !== null) {
      rows.push({ key: m.next, text: `R ${m.old} -> ${m.next}` });
      covered.add(m.old);
      covered.add(m.next);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
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
