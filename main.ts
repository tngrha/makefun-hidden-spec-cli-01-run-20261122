// mend: applies an AI-written edit (unified diff, SEARCH/REPLACE blocks, V4A patch, or JSON
// text-editor calls) to a tree of text files, exactly as SPEC.md version 1 says.
// Node 22 standard library only. Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---------- small text helpers ----------

function isBlank(s: string): boolean {
  return /^\s*$/.test(s);
}

function stripSpaces(s: string): string {
  return s.replace(/^ +/, '').replace(/ +$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// A patch's lines: split at \n, one trailing \r removed from each, no empty piece after a final \n.
function patchLinesOf(text: string): string[] {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// ---------- file model (SPEC section 3) ----------

interface FileParts {
  brk: string;
  lines: string[];
  finalBreak: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { brk: '\n', lines: [], finalBreak: false };
  const idx = text.indexOf('\n');
  const brk = idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(brk);
  const lines = text.split(brk);
  if (finalBreak) lines.pop();
  return { brk, lines, finalBreak };
}

function joinFile(lines: string[], brk: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(brk) + (finalBreak ? brk : '');
}

function fileBreakOf(text: string): string {
  const idx = text.indexOf('\n');
  return idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
}

// ---------- line matching (SPEC section 5) ----------

interface LineItem {
  text: string;
  context: boolean;
}

function tierForm(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrencesAt(fileLines: string[], o: LineItem[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const of = o.map((x) => tierForm(x.text, tier));
  const ff = fileLines.map((x) => tierForm(x, tier));
  for (let i = 0; i + o.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (ff[i + k] !== of[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Match {
  tier: number;
  positions: number[];
}

// First tier (0, then 1, then 2; tier 0 only when strict) with at least one acceptable occurrence.
function matchO(
  fileLines: string[],
  o: LineItem[],
  strict: boolean,
  accept: (pos: number) => boolean,
): Match | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrencesAt(fileLines, o, tier).filter(accept);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// The lines N writes in place of the matched O at pos: context lines become the file's own
// matched lines; at tier 2 every other qualifying line is re-indented from P to F.
function buildReplacement(fileLines: string[], pos: number, o: LineItem[], n: LineItem[], tier: number): string[] {
  const ctxFileLines: string[] = [];
  for (let k = 0; k < o.length; k += 1) {
    if (o[k].context) ctxFileLines.push(fileLines[pos + k]);
  }
  const f = leadingWs(fileLines[pos]);
  const p = leadingWs(o[0].text);
  let ci = 0;
  return n.map((item) => {
    if (item.context) {
      const v = ctxFileLines[ci];
      ci += 1;
      return v;
    }
    if (tier === 2) {
      const line = item.text;
      if (line !== '' && !/^\s*$/.test(line) && line.startsWith(p)) {
        return f + line.slice(p.length);
      }
    }
    return item.text;
  });
}

function spliceLines(lines: string[], pos: number, remove: number, insert: string[]): string[] {
  return [...lines.slice(0, pos), ...insert, ...lines.slice(pos + remove)];
}

// ---------- tree snapshot ----------

function readTree(): Map<string, string> {
  const tree = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, rel);
      else if (st.isFile()) {
        try {
          tree.set(rel, readFileSync(full, 'utf8'));
        } catch {
          // unreadable file: leave it out of the tree
        }
      }
    }
  };
  walk('.', '');
  return tree;
}

function writeTreeChanges(before: Map<string, string>, after: Map<string, string>): void {
  for (const [p, text] of after) {
    if (before.get(p) !== text) {
      const full = join('.', ...p.split('/'));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
  }
  for (const p of before.keys()) {
    if (!after.has(p)) {
      try {
        rmSync(join('.', ...p.split('/')));
      } catch {
        // already gone
      }
    }
  }
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------- edits ----------

interface Hunk {
  a: number;
  body: { t: string; text: string }[];
}

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: LineItem[];
  kinds: string[];
}

type Edit =
  | { kind: 'u-create'; newPath: string; lines: string[]; finalBreak: boolean }
  | { kind: 'u-delete'; oldPath: string }
  | { kind: 'u-change'; oldPath: string; newPath: string; hunks: Hunk[] }
  | { kind: 'sr'; path: string; oldLines: string[]; newLines: string[] }
  | { kind: 'v-add'; path: string; lines: string[] }
  | { kind: 'v-delete'; path: string }
  | { kind: 'v-update'; path: string; moveTo: string | null; chunks: Chunk[] }
  | { kind: 'j-create'; path: string; fileText: string }
  | { kind: 'j-replace'; path: string; oldStr: string; newStr: string }
  | { kind: 'j-insert'; path: string; insertLine: number; newStr: string };

class ParseFault {
  line: number;
  constructor(line: number) {
    this.line = line;
  }
}

interface Failure {
  code: string;
  path: string;
}

// ---------- JSON edits (SPEC section 9) ----------

function validateJsonEdit(obj: unknown): Edit | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  const path = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { kind: 'j-create', path, fileText: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    let newStr = '';
    if ('new_str' in o) {
      if (typeof o.new_str !== 'string') return null;
      newStr = o.new_str;
    }
    return { kind: 'j-replace', path, oldStr: o.old_str, newStr };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { kind: 'j-insert', path, insertLine: o.insert_line, newStr: o.new_str };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isBlank(lines[i])) {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank >= 0 && lines[firstNonBlank].trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseFault(firstNonBlank + 1);
    }
    if (!Array.isArray(parsed)) throw new ParseFault(firstNonBlank + 1);
    const edits: Edit[] = [];
    for (const item of parsed) {
      const e = validateJsonEdit(item);
      if (e === null) throw new ParseFault(firstNonBlank + 1);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (isBlank(lines[i])) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      throw new ParseFault(i + 1);
    }
    const e = validateJsonEdit(obj);
    if (e === null) throw new ParseFault(i + 1);
    edits.push(e);
  }
  return edits;
}

function countOverlapping(hay: string, needle: string): { count: number; at: number } {
  let count = 0;
  let at = -1;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    if (at < 0) at = i;
    count += 1;
    from = i + 1;
  }
  return { count, at };
}

// ---------- SEARCH/REPLACE blocks (SPEC section 7) ----------

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let eqAt = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trimEnd() === '=======') {
        eqAt = j;
        break;
      }
    }
    if (eqAt < 0) throw new ParseFault(searchAt + 1);
    let repAt = -1;
    for (let j = eqAt + 1; j < lines.length; j += 1) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
        repAt = j;
        break;
      }
    }
    if (repAt < 0) throw new ParseFault(searchAt + 1);
    let path: string | null = null;
    for (let b = searchAt - 1; b > prevReplace; b -= 1) {
      if (isBlank(lines[b])) continue;
      const t = lines[b].trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(searchAt + 1);
      path = prevPath;
    }
    edits.push({
      kind: 'sr',
      path,
      oldLines: lines.slice(searchAt + 1, eqAt),
      newLines: lines.slice(eqAt + 1, repAt),
    });
    prevPath = path;
    prevReplace = repAt;
    i = repAt + 1;
  }
  return edits;
}

// ---------- unified diffs (SPEC section 6) ----------

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  minusPath: string | null | undefined;
  plusPath: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
  seenHunk: boolean;
}

function newSection(): Section {
  return {
    gitOld: null,
    gitNew: null,
    minusPath: undefined,
    plusPath: undefined,
    renameFrom: null,
    renameTo: null,
    newFileMode: false,
    deletedFileMode: false,
    hunks: [],
    seenHunk: false,
  };
}

function isDiffGitLine(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

function headerPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = stripSpaces(rest);
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function isBodyLine(line: string): boolean {
  return line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\';
}

function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const pairAt = (i: number): boolean =>
    i + 1 < lines.length && lines[i].startsWith('--- ') && lines[i + 1].startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isDiffGitLine(line)) {
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      cur = newSection();
      cur.gitOld = m[1];
      cur.gitNew = m[2];
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseFault(i + 1);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      if (m === null || (m[3] !== '' && m[3][0] !== ' ' && m[3][0] !== '\t')) throw new ParseFault(i + 1);
      const body: { t: string; text: string }[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j];
        if (isDiffGitLine(bl)) break;
        if (pairAt(j)) break;
        if (!isBodyLine(bl)) break;
        if (bl === '') body.push({ t: ' ', text: '' });
        else body.push({ t: bl[0], text: bl.slice(1) });
        j += 1;
      }
      while (body.length > 0 && lines[j - 1] === '' && body[body.length - 1].t === ' ' && body[body.length - 1].text === '') {
        // trailing empty lines are not part of the body; identify them by the raw line
        body.pop();
        j -= 1;
      }
      cur.hunks.push({ a: Number(m[1]), body });
      cur.seenHunk = true;
      i = j;
      continue;
    }
    if (pairAt(i)) {
      if (cur !== null && !cur.seenHunk && cur.minusPath === undefined && cur.plusPath === undefined) {
        cur.minusPath = headerPath(lines[i]);
        cur.plusPath = headerPath(lines[i + 1]);
      } else {
        cur = newSection();
        cur.minusPath = headerPath(lines[i]);
        cur.plusPath = headerPath(lines[i + 1]);
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (cur !== null && !cur.seenHunk) {
      if (line.startsWith('--- ')) throw new ParseFault(i + 2);
      if (line.startsWith('+++ ')) {
        if (cur.plusPath === undefined) cur.plusPath = headerPath(line);
      } else if (line.startsWith('rename from ')) {
        cur.renameFrom = stripSpaces(line.slice('rename from '.length));
      } else if (line.startsWith('rename to ')) {
        cur.renameTo = stripSpaces(line.slice('rename to '.length));
      } else if (line.startsWith('new file mode')) {
        cur.newFileMode = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.deletedFileMode = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map(sectionToEdit);
}

function sectionPaths(s: Section): { oldPath: string | null; newPath: string | null } {
  const oldPath = s.minusPath !== undefined ? s.minusPath : s.renameFrom !== null ? s.renameFrom : s.gitOld;
  const newPath = s.plusPath !== undefined ? s.plusPath : s.renameTo !== null ? s.renameTo : s.gitNew;
  return { oldPath, newPath };
}

function backslashAfterLast(body: { t: string; text: string }[], kinds: string[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k += 1) {
    if (kinds.includes(body[k].t)) last = k;
  }
  return last >= 0 && last + 1 < body.length && body[last + 1].t === '\\';
}

function sectionToEdit(s: Section): Edit {
  const { oldPath, newPath } = sectionPaths(s);
  if (oldPath === null || s.newFileMode) {
    const created: string[] = [];
    let finalBreak = true;
    for (const h of s.hunks) {
      let hasPlus = false;
      for (const b of h.body) {
        if (b.t === '+') {
          created.push(b.text);
          hasPlus = true;
        }
      }
      if (hasPlus) finalBreak = !backslashAfterLast(h.body, ['+']);
    }
    return { kind: 'u-create', newPath: newPath ?? '', lines: created, finalBreak };
  }
  if (newPath === null || s.deletedFileMode) {
    return { kind: 'u-delete', oldPath };
  }
  return { kind: 'u-change', oldPath, newPath, hunks: s.hunks };
}

function hunkON(h: Hunk): { o: LineItem[]; n: LineItem[] } {
  const o: LineItem[] = [];
  const n: LineItem[] = [];
  for (const b of h.body) {
    if (b.t === ' ') {
      o.push({ text: b.text, context: true });
      n.push({ text: b.text, context: true });
    } else if (b.t === '-') {
      o.push({ text: b.text, context: false });
    } else if (b.t === '+') {
      n.push({ text: b.text, context: false });
    }
  }
  return { o, n };
}

// ---------- V4A patches (SPEC section 8) ----------

interface RawSection {
  type: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  raw: { line: string; num: number }[];
}

function parseV4a(lines: string[]): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isBlank(lines[i])) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) throw new ParseFault(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i];
    if (line.startsWith('*** Add File: ')) {
      cur = { type: 'add', path: stripSpaces(line.slice('*** Add File: '.length)), headerLine: i + 1, raw: [] };
      sections.push(cur);
    } else if (line.startsWith('*** Delete File: ')) {
      cur = { type: 'delete', path: stripSpaces(line.slice('*** Delete File: '.length)), headerLine: i + 1, raw: [] };
      sections.push(cur);
    } else if (line.startsWith('*** Update File: ')) {
      cur = { type: 'update', path: stripSpaces(line.slice('*** Update File: '.length)), headerLine: i + 1, raw: [] };
      sections.push(cur);
    } else if (cur === null) {
      if (!isBlank(line)) throw new ParseFault(i + 1);
    } else {
      cur.raw.push({ line, num: i + 1 });
    }
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    while (s.raw.length > 0 && isBlank(s.raw[s.raw.length - 1].line)) s.raw.pop();
    if (s.type === 'add') {
      const fileLines: string[] = [];
      for (const r of s.raw) {
        if (r.line === '') fileLines.push('');
        else if (r.line.startsWith('+')) fileLines.push(r.line.slice(1));
        else throw new ParseFault(r.num);
      }
      edits.push({ kind: 'v-add', path: s.path, lines: fileLines });
    } else if (s.type === 'delete') {
      if (s.raw.length > 0) throw new ParseFault(s.raw[0].num);
      edits.push({ kind: 'v-delete', path: s.path });
    } else {
      edits.push(parseV4aUpdate(s));
    }
  }
  return edits;
}

function parseV4aUpdate(s: RawSection): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (s.raw.length > 0 && s.raw[0].line.startsWith('*** Move to: ')) {
    moveTo = stripSpaces(s.raw[0].line.slice('*** Move to: '.length));
    idx = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  let closedChunk = false;
  for (; idx < s.raw.length; idx += 1) {
    const { line, num } = s.raw[idx];
    if (line.startsWith('@@')) {
      const anchor = stripSpaces(line.slice(2));
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [], kinds: [] };
      chunks.push(cur);
      closedChunk = false;
    } else if (line === '*** End of File') {
      if (cur === null) throw new ParseFault(num);
      cur.eof = true;
      cur = null;
      closedChunk = true;
    } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0 || closedChunk) throw new ParseFault(num);
        cur = { anchor: null, eof: false, body: [], kinds: [] };
        chunks.push(cur);
      }
      const t = line === '' ? ' ' : line[0];
      const text = line === '' ? '' : line.slice(1);
      cur.kinds.push(t);
      cur.body.push({ text, context: t === ' ' });
    } else {
      throw new ParseFault(num);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new ParseFault(s.headerLine);
  return { kind: 'v-update', path: s.path, moveTo, chunks };
}

function chunkON(c: Chunk): { o: LineItem[]; n: LineItem[] } {
  const o: LineItem[] = [];
  const n: LineItem[] = [];
  for (let k = 0; k < c.body.length; k += 1) {
    const t = c.kinds[k];
    if (t === ' ') {
      o.push(c.body[k]);
      n.push(c.body[k]);
    } else if (t === '-') {
      o.push(c.body[k]);
    } else if (t === '+') {
      n.push(c.body[k]);
    }
  }
  return { o, n };
}

// ---------- applying edits (SPEC section 10) ----------

function applyUnifiedChange(
  tree: Map<string, string>,
  oldPath: string,
  newPath: string,
  hunks: Hunk[],
  strict: boolean,
): Failure | null {
  const before = splitFile(tree.get(oldPath) as string);
  let lines = [...before.lines];
  let finalBreak = before.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h);
    if (o.length === 0) {
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > lines.length) at = lines.length;
      if (at === lines.length) finalBreak = !backslashAfterLast(h.body, [' ', '+']);
      lines = spliceLines(lines, at, 0, n.map((x) => x.text));
    } else {
      const m = matchO(lines, o, strict, () => true);
      if (m === null) return { code: 'no-match', path: oldPath };
      const target = h.a - 1 + d;
      let pos = m.positions[0];
      for (const p of m.positions) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      if (pos + o.length === lines.length) finalBreak = !backslashAfterLast(h.body, [' ', '+']);
      const written = buildReplacement(lines, pos, o, n, m.tier);
      lines = spliceLines(lines, pos, o.length, written);
    }
    d += n.length - o.length;
  }
  const text = joinFile(lines, before.brk, finalBreak);
  if (newPath !== oldPath) tree.delete(oldPath);
  tree.set(newPath, text);
  return null;
}

function applyV4aUpdate(
  tree: Map<string, string>,
  path: string,
  moveTo: string | null,
  chunks: Chunk[],
  strict: boolean,
): Failure | null {
  const before = splitFile(tree.get(path) as string);
  let lines = [...before.lines];
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      const anchorItem: LineItem[] = [{ text: c.anchor, context: false }];
      const at = cursor;
      const m = matchO(lines, anchorItem, strict, (p) => p >= at);
      if (m === null) return { code: 'no-match', path };
      cursor = m.positions[0] + 1;
    }
    const { o, n } = chunkON(c);
    if (o.length === 0) {
      const at = c.eof ? lines.length : cursor;
      const written = n.map((x) => x.text);
      lines = spliceLines(lines, at, 0, written);
      cursor = at + written.length;
    } else {
      const at = cursor;
      const len = lines.length;
      const m = c.eof
        ? matchO(lines, o, strict, (p) => p >= at && p + o.length === len)
        : matchO(lines, o, strict, (p) => p >= at);
      if (m === null) return { code: 'no-match', path };
      const pos = m.positions[0];
      const written = buildReplacement(lines, pos, o, n, m.tier);
      lines = spliceLines(lines, pos, o.length, written);
      cursor = pos + written.length;
    }
  }
  const text = joinFile(lines, before.brk, before.finalBreak);
  if (moveTo !== null) {
    tree.delete(path);
    tree.set(moveTo, text);
  } else {
    tree.set(path, text);
  }
  return null;
}

function applyEdit(
  tree: Map<string, string>,
  e: Edit,
  strict: boolean,
  moves: [string, string][],
): Failure | null {
  switch (e.kind) {
    case 'u-create': {
      if (!isSafePath(e.newPath)) return { code: 'unsafe', path: e.newPath };
      if (tree.has(e.newPath)) return { code: 'exists', path: e.newPath };
      tree.set(e.newPath, joinFile(e.lines, '\n', e.finalBreak));
      return null;
    }
    case 'u-delete': {
      if (!isSafePath(e.oldPath)) return { code: 'unsafe', path: e.oldPath };
      if (!tree.has(e.oldPath)) return { code: 'missing', path: e.oldPath };
      tree.delete(e.oldPath);
      return null;
    }
    case 'u-change': {
      if (!isSafePath(e.oldPath)) return { code: 'unsafe', path: e.oldPath };
      if (!isSafePath(e.newPath)) return { code: 'unsafe', path: e.newPath };
      if (!tree.has(e.oldPath)) return { code: 'missing', path: e.oldPath };
      if (e.newPath !== e.oldPath && tree.has(e.newPath)) return { code: 'exists', path: e.newPath };
      const f = applyUnifiedChange(tree, e.oldPath, e.newPath, e.hunks, strict);
      if (f === null && e.newPath !== e.oldPath) moves.push([e.oldPath, e.newPath]);
      return f;
    }
    case 'sr': {
      if (!isSafePath(e.path)) return { code: 'unsafe', path: e.path };
      if (e.oldLines.length === 0) {
        if (tree.has(e.path)) return { code: 'exists', path: e.path };
        tree.set(e.path, joinFile(e.newLines, '\n', true));
        return null;
      }
      if (!tree.has(e.path)) return { code: 'missing', path: e.path };
      const before = splitFile(tree.get(e.path) as string);
      const o: LineItem[] = e.oldLines.map((text) => ({ text, context: false }));
      const n: LineItem[] = e.newLines.map((text) => ({ text, context: false }));
      const m = matchO(before.lines, o, strict, () => true);
      if (m === null) return { code: 'no-match', path: e.path };
      if (m.positions.length > 1) return { code: 'ambiguous', path: e.path };
      const written = buildReplacement(before.lines, m.positions[0], o, n, m.tier);
      const lines = spliceLines(before.lines, m.positions[0], o.length, written);
      tree.set(e.path, joinFile(lines, before.brk, before.finalBreak));
      return null;
    }
    case 'v-add': {
      if (!isSafePath(e.path)) return { code: 'unsafe', path: e.path };
      if (tree.has(e.path)) return { code: 'exists', path: e.path };
      tree.set(e.path, joinFile(e.lines, '\n', true));
      return null;
    }
    case 'v-delete': {
      if (!isSafePath(e.path)) return { code: 'unsafe', path: e.path };
      if (!tree.has(e.path)) return { code: 'missing', path: e.path };
      tree.delete(e.path);
      return null;
    }
    case 'v-update': {
      if (!isSafePath(e.path)) return { code: 'unsafe', path: e.path };
      if (e.moveTo !== null && !isSafePath(e.moveTo)) return { code: 'unsafe', path: e.moveTo };
      if (!tree.has(e.path)) return { code: 'missing', path: e.path };
      if (e.moveTo !== null && tree.has(e.moveTo)) return { code: 'exists', path: e.moveTo };
      const f = applyV4aUpdate(tree, e.path, e.moveTo, e.chunks, strict);
      if (f === null && e.moveTo !== null) moves.push([e.path, e.moveTo]);
      return f;
    }
    case 'j-create': {
      if (!isSafePath(e.path)) return { code: 'unsafe', path: e.path };
      if (tree.has(e.path)) return { code: 'exists', path: e.path };
      tree.set(e.path, e.fileText);
      return null;
    }
    case 'j-replace': {
      if (!isSafePath(e.path)) return { code: 'unsafe', path: e.path };
      if (!tree.has(e.path)) return { code: 'missing', path: e.path };
      const text = tree.get(e.path) as string;
      if (fileBreakOf(text) === '\r\n') {
        const t1 = text.replace(/\r\n/g, '\n');
        const o1 = e.oldStr.replace(/\r\n/g, '\n');
        const n1 = e.newStr.replace(/\r\n/g, '\n');
        const { count, at } = countOverlapping(t1, o1);
        if (count === 0) return { code: 'no-match', path: e.path };
        if (count > 1) return { code: 'ambiguous', path: e.path };
        const r1 = t1.slice(0, at) + n1 + t1.slice(at + o1.length);
        tree.set(e.path, r1.replace(/\n/g, '\r\n'));
      } else {
        const { count, at } = countOverlapping(text, e.oldStr);
        if (count === 0) return { code: 'no-match', path: e.path };
        if (count > 1) return { code: 'ambiguous', path: e.path };
        tree.set(e.path, text.slice(0, at) + e.newStr + text.slice(at + e.oldStr.length));
      }
      return null;
    }
    case 'j-insert': {
      if (!isSafePath(e.path)) return { code: 'unsafe', path: e.path };
      if (!tree.has(e.path)) return { code: 'missing', path: e.path };
      const before = splitFile(tree.get(e.path) as string);
      if (e.insertLine < 0 || e.insertLine > before.lines.length) return { code: 'no-match', path: e.path };
      const ins = e.newStr === '' ? [] : patchLinesOf(e.newStr);
      const lines = spliceLines(before.lines, e.insertLine, 0, ins);
      tree.set(e.path, joinFile(lines, before.brk, before.finalBreak));
      return null;
    }
  }
}

// ---------- format detection (SPEC section 4) ----------

function detectFormat(lines: string[]): string | null {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isBlank(lines[i])) {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank >= 0 && lines[firstNonBlank].trim() === '*** Begin Patch') return 'v4a';
  if (firstNonBlank >= 0) {
    const c = lines[firstNonBlank].trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------- invocation (SPEC sections 1, 2) ----------

function run(args: string[]): { code: number; out: string[] } {
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (endOpts) {
      positional.push(arg);
      continue;
    }
    if (arg === '--') {
      endOpts = true;
      continue;
    }
    if (arg === '--check') {
      if (seenCheck) return { code: 2, out: ['error: usage'] };
      seenCheck = true;
      check = true;
      continue;
    }
    if (arg === '--strict') {
      if (seenStrict) return { code: 2, out: ['error: usage'] };
      seenStrict = true;
      strict = true;
      continue;
    }
    if (arg.startsWith('--format=')) {
      if (seenFormat) return { code: 2, out: ['error: usage'] };
      seenFormat = true;
      const v = arg.slice('--format='.length);
      if (!['unified', 'search-replace', 'v4a', 'json', 'auto'].includes(v)) {
        return { code: 2, out: ['error: usage'] };
      }
      format = v;
      continue;
    }
    if (arg === '-') {
      positional.push(arg);
      continue;
    }
    if (arg.startsWith('-')) return { code: 2, out: ['error: usage'] };
    positional.push(arg);
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  let patchText: string;
  const patchArg = positional[0];
  try {
    patchText = patchArg === undefined || patchArg === '-' ? readFileSync(0, 'utf8') : readFileSync(patchArg, 'utf8');
  } catch {
    return { code: 2, out: ['error: no-patch'] };
  }

  const lines = patchLinesOf(patchText);
  let fmt = format;
  if (fmt === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) return { code: 2, out: ['error: format'] };
    fmt = detected;
  }

  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (fmt === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(patchText, lines);
  } catch (err) {
    if (err instanceof ParseFault) return { code: 2, out: [`error: parse ${err.line}`] };
    throw err;
  }
  if (edits.length === 0) return { code: 2, out: ['error: parse 1'] };

  const before = readTree();
  const after = new Map(before);
  const failures: Failure[] = [];
  const moves: [string, string][] = [];
  for (const e of edits) {
    const f = applyEdit(after, e, strict, moves);
    if (f !== null) failures.push(f);
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { code: 1, out };
  }

  const renamedOld = new Set<string>();
  const renamedNew = new Set<string>();
  const entries: { key: string; line: string }[] = [];
  for (const [oldP, newP] of moves) {
    if (before.has(oldP) && !after.has(oldP) && !before.has(newP) && after.has(newP)) {
      if (renamedOld.has(oldP) || renamedNew.has(newP)) continue;
      renamedOld.add(oldP);
      renamedNew.add(newP);
      entries.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  const allPaths = new Set<string>([...before.keys(), ...after.keys()]);
  for (const p of allPaths) {
    if (renamedOld.has(p) || renamedNew.has(p)) continue;
    const b = before.get(p);
    const a = after.get(p);
    if (b === a) continue;
    if (b === undefined) entries.push({ key: p, line: `A ${p}` });
    else if (a === undefined) entries.push({ key: p, line: `D ${p}` });
    else entries.push({ key: p, line: `M ${p}` });
  }
  entries.sort((x, y) => byteCompare(x.key, y.key));
  const out = entries.map((x) => x.line);
  out.push(entries.length === 1 ? 'ok: 1 file' : `ok: ${entries.length} files`);

  if (!check) writeTreeChanges(before, after);
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
