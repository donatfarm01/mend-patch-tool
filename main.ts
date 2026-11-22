// mend — one patch tool for every AI edit format.
//
// A single-file CLI (Node 22, standard library only) that reads a patch in
// one of four AI edit formats — unified diff, SEARCH/REPLACE, V4A, JSON tool
// calls — and applies it to a tree of text files, atomically: either every
// edit lands or no file is written at all.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//   --format: auto (default), unified, search_replace, v4a, json
//   --check:  report what would change, write nothing
//   --strict: exact (tier 0) matching only
// PATCH defaults to stdin; "-" also means stdin.
//
// Exit codes: 0 ok, 1 one or more edits failed (nothing written),
// 2 usage / no patch / format / parse error (see SPEC.md).

import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const FORMATS = ["auto", "unified", "search_replace", "v4a", "json"] as const;
export type Format = (typeof FORMATS)[number];

export class Exit2 extends Error {}
export class Fail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string) => s.trim() === "";

// Split patch text into lines: split at "\n", drop one trailing "\r" per
// line, and drop the empty piece after a final "\n".
export function patchLines(text: string): string[] {
  const raw = text.split("\n");
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  return raw.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

// A path is safe when it is non-empty, not absolute, has no backslash, and
// no segment that is empty, "." or "..".
export function safe(p: string): boolean {
  if (p === "" || p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  return !p.split("/").some((s) => s === "" || s === "." || s === "..");
}

// ---------------------------------------------------------------------------
// File model: a text file as its lines, its line break, and whether it ends
// with one. The break is CRLF exactly when the first line break in the
// file is CRLF; an empty file has no lines and no final break.
// ---------------------------------------------------------------------------

export interface FileModel {
  lines: string[];
  br: "\r\n" | "\n";
  finalBreak: boolean;
}

export function parseFile(text: string): FileModel {
  if (text === "") return { lines: [], br: "\n", finalBreak: false };
  const nl = text.indexOf("\n");
  const br: "\r\n" | "\n" = nl > 0 && text[nl - 1] === "\r" ? "\r\n" : "\n";
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

export function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return "";
  return m.lines.join(m.br) + (m.finalBreak ? m.br : "");
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : "";
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, "");
  return s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

// All 0-based positions where pat occurs in lines at the given tier.
function occurrences(lines: string[], pat: string[], tier: number): number[] {
  const pos: number[] = [];
  if (pat.length === 0) return pos;
  const np = pat.map((l) => normLine(l, tier));
  for (let i = 0; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (normLine(lines[i + j], tier) !== np[j]) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

// The first tier (0, then 1, then 2; strict allows 0 only) at which pat
// occurs, with all its positions. Null when it occurs at no tier.
function findTier(
  lines: string[],
  pat: string[],
  strict: boolean,
): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const p = occurrences(lines, pat, t);
    if (p.length > 0) return { tier: t, pos: p };
  }
  return null;
}

// Build the replacement lines for a matched block. N items carry their
// text; context items are written as the file's own matched line, never
// the patch's. At tier 2 every other line of N is re-indented: its leading
// P (the leading whitespace of O's first line) is replaced by F (the
// leading whitespace of the file's first matched line).
export interface NewItem {
  text: string;
  ctx: boolean;
  oIdx: number; // index into O when ctx, else -1
}

export function buildReplacement(
  fileLines: string[],
  matchPos: number,
  oFirst: string,
  nItems: NewItem[],
  tier: number,
): string[] {
  const out: string[] = [];
  const F = leadingWs(fileLines[matchPos] ?? "");
  const P = leadingWs(oFirst);
  for (const n of nItems) {
    if (n.ctx) {
      out.push(fileLines[matchPos + n.oIdx]);
      continue;
    }
    let t = n.text;
    if (
      tier === 2 &&
      t !== "" &&
      !/^[ \t]*$/.test(t) &&
      t.startsWith(P)
    ) {
      t = F + t.slice(P.length);
    }
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tree: the on-disk tree as the patch sees it. Files are read on first
// access and cached; edits stage into `now`; nothing is written until the
// end, and only when no edit failed. `moves` records successful
// (old, new) moves for the R output lines.
// ---------------------------------------------------------------------------

export class Tree {
  readonly now = new Map<string, string | null>();
  private readonly origCache = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  get(p: string): string | null {
    if (this.now.has(p)) return this.now.get(p)!;
    const v = this.original(p);
    this.now.set(p, v);
    return v;
  }

  original(p: string): string | null {
    if (this.origCache.has(p)) return this.origCache.get(p)!;
    let v: string | null = null;
    try {
      if (statSync(p).isFile()) v = readFileSync(p, "utf8");
    } catch {
      v = null;
    }
    this.origCache.set(p, v);
    return v;
  }
}

export type Edit = (tree: Tree) => void;

function requireSafe(p: string): void {
  if (!safe(p)) throw new Fail("unsafe", p);
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4).
// ---------------------------------------------------------------------------

export function detect(lines: string[]): Format | null {
  const first = lines.find((l) => !blank(l));
  if (first === undefined) return null;
  if (first.trim() === "*** Begin Patch") return "v4a";
  const c = first.trimStart()[0];
  if (c === "[" || c === "{") return "json";
  if (lines.some((l) => l.trimEnd() === "<<<<<<< SEARCH")) return "search_replace";
  if (
    lines.some(
      (l, i) =>
        l.startsWith("diff --git ") ||
        (l.startsWith("--- ") &&
          i + 1 < lines.length &&
          lines[i + 1].startsWith("+++ ")),
    )
  ) {
    return "unified";
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON format (SPEC section 9). One JSON array of edit objects, or JSON
// Lines with one edit object per line.
// ---------------------------------------------------------------------------

function jsonEdit(o: unknown): Edit | null {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (typeof r.path !== "string" || r.path === "") return null;
  const file = r.path;
  if (r.command === "create") {
    if (typeof r.file_text !== "string") return null;
    const text = r.file_text;
    return (tree) => {
      requireSafe(file);
      if (tree.get(file) !== null) throw new Fail("exists", file);
      tree.now.set(file, text);
    };
  }
  if (r.command === "str_replace") {
    if (typeof r.old_str !== "string" || r.old_str === "") return null;
    if (r.new_str !== undefined && typeof r.new_str !== "string") return null;
    const oldS = r.old_str;
    const newS = r.new_str === undefined ? "" : (r.new_str as string);
    return (tree) => {
      requireSafe(file);
      const cur = tree.get(file);
      if (cur === null) throw new Fail("missing", file);
      // The match is on the file's text, exact, no tiers: old_str occurs
      // exactly once (positions may overlap), else no-match / ambiguous.
      // In a CRLF file the text and both strings are read with every
      // \r\n as \n, and the result is written back with \r\n.
      const isCRLF = parseFile(cur).br === "\r\n";
      const fileText = isCRLF ? cur.replace(/\r\n/g, "\n") : cur;
      const oldT = isCRLF ? oldS.replace(/\r\n/g, "\n") : oldS;
      const newT = isCRLF ? newS.replace(/\r\n/g, "\n") : newS;
      let count = 0;
      let idx = -1;
      let from = 0;
      while (true) {
        const at = fileText.indexOf(oldT, from);
        if (at < 0) break;
        count++;
        if (idx < 0) idx = at;
        if (count > 1) break;
        from = at + 1;
      }
      if (count === 0) throw new Fail("no-match", file);
      if (count > 1) throw new Fail("ambiguous", file);
      let result = fileText.slice(0, idx) + newT + fileText.slice(idx + oldT.length);
      if (isCRLF) result = result.replace(/\n/g, "\r\n");
      tree.now.set(file, result);
    };
  }
  if (r.command === "insert") {
    if (
      typeof r.insert_line !== "number" ||
      !Number.isInteger(r.insert_line) ||
      typeof r.new_str !== "string"
    ) {
      return null;
    }
    const lineNo = r.insert_line;
    const newS = r.new_str;
    return (tree) => {
      requireSafe(file);
      const cur = tree.get(file);
      if (cur === null) throw new Fail("missing", file);
      const model = parseFile(cur);
      if (lineNo < 0 || lineNo > model.lines.length) throw new Fail("no-match", file);
      const newLines = patchLines(newS);
      const next = model.lines.slice();
      next.splice(lineNo, 0, ...newLines);
      tree.now.set(file, renderFile({ lines: next, br: model.br, finalBreak: model.finalBreak }));
    };
  }
  return null;
}

export function jsonEdits(lines: string[], text: string): Edit[] {
  const firstIdx = lines.findIndex((l) => !blank(l));
  if (firstIdx < 0) throw new Exit2("error: parse 1");
  const first = lines[firstIdx];
  if (first.trimStart().startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${firstIdx + 1}`);
    }
    if (!Array.isArray(arr)) throw new Exit2(`error: parse ${firstIdx + 1}`);
    const edits: Edit[] = [];
    for (const el of arr) {
      const e = jsonEdit(el);
      if (e === null) throw new Exit2(`error: parse ${firstIdx + 1}`);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let o: unknown;
    try {
      o = JSON.parse(l);
    } catch {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const e = jsonEdit(o);
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6).
// ---------------------------------------------------------------------------

export interface BodyItem {
  kind: "ctx" | "old" | "new";
  text: string;
  noNL: boolean; // a "\" line follows this item in the hunk body
}

export interface Hunk {
  A: number;
  items: BodyItem[];
}

export interface Section {
  diffOld: string | null | undefined;
  diffNew: string | null | undefined;
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renOld: string | null | undefined;
  renNew: string | null | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return {
    diffOld: undefined,
    diffNew: undefined,
    dashOld: undefined,
    dashNew: undefined,
    renOld: undefined,
    renNew: undefined,
    newFile: false,
    delFile: false,
    hunks: [],
  };
}

// Path from a "--- " / "+++ " header line: text after the marker, up to
// the first tab, surrounding spaces removed, "/dev/null" means no file,
// one leading "a/" or "b/" removed.
function headerPath(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf("\t");
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === "/dev/null") return null;
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function lastCtxOrNew(items: BodyItem[]): BodyItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "ctx" || items[i].kind === "new") return items[i];
  }
  return null;
}

// Apply a section's hunks, in order, to a file model. d accumulates the
// (N length minus O length) of the hunks applied so far; each hunk takes
// the occurrence of O nearest to A - 1 + d at the first tier where O occurs.
function applyHunks(
  model: FileModel,
  hunks: Hunk[],
  strict: boolean,
  failPath: string,
): FileModel {
  let lines = model.lines.slice();
  let finalBreak = model.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: NewItem[] = [];
    for (const it of h.items) {
      if (it.kind === "ctx") {
        N.push({ text: it.text, ctx: true, oIdx: O.length });
        O.push(it.text);
      } else if (it.kind === "old") {
        O.push(it.text);
      } else {
        N.push({ text: it.text, ctx: false, oIdx: -1 });
      }
    }
    if (O.length === 0) {
      const insertPos = Math.min(h.A + d, lines.length);
      const repl = N.map((n) => n.text);
      if (insertPos === lines.length) {
        const last = lastCtxOrNew(h.items);
        finalBreak = !(last && last.noNL);
      }
      lines.splice(insertPos, 0, ...repl);
      d += N.length;
    } else {
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail("no-match", failPath);
      const target = h.A - 1 + d;
      let best = found.pos[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const matchPos = best;
      if (matchPos + O.length === lines.length) {
        const last = lastCtxOrNew(h.items);
        finalBreak = !(last && last.noNL);
      }
      const repl = buildReplacement(lines, matchPos, O[0], N, found.tier);
      lines.splice(matchPos, O.length, ...repl);
      d += N.length - O.length;
    }
  }
  return { lines, br: model.br, finalBreak };
}

function makeUnifiedEdit(sec: Section, strict: boolean): Edit {
  const oldP =
    sec.dashOld !== undefined
      ? sec.dashOld
      : sec.renOld !== undefined
        ? sec.renOld
        : sec.diffOld !== undefined
          ? sec.diffOld
          : null;
  const newP =
    sec.dashNew !== undefined
      ? sec.dashNew
      : sec.renNew !== undefined
        ? sec.renNew
        : sec.diffNew !== undefined
          ? sec.diffNew
          : null;
  return (tree) => {
    if (typeof oldP === "string") requireSafe(oldP);
    if (typeof newP === "string") requireSafe(newP);
    const isDel = sec.delFile || newP === null;
    const isCreate = !isDel && (sec.newFile || oldP === null);
    if (isDel) {
      const p = oldP as string;
      if (tree.get(p) === null) throw new Fail("missing", p);
      tree.now.set(p, null);
      return;
    }
    if (isCreate) {
      const p = newP as string;
      if (tree.get(p) !== null) throw new Fail("exists", p);
      const plus: string[] = [];
      let lastPlus: BodyItem | null = null;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === "new") {
            plus.push(it.text);
            lastPlus = it;
          }
        }
      }
      const finalBreak = plus.length === 0 ? false : !(lastPlus && lastPlus.noNL);
      const content = plus.length === 0 ? "" : plus.join("\n") + (finalBreak ? "\n" : "");
      tree.now.set(p, content);
      return;
    }
    const p = oldP as string;
    const cur = tree.get(p);
    if (cur === null) throw new Fail("missing", p);
    if (oldP !== newP) {
      const np = newP as string;
      if (tree.get(np) !== null) throw new Fail("exists", np);
    }
    const model = applyHunks(parseFile(cur), sec.hunks, strict, p);
    const content = renderFile(model);
    if (oldP !== newP) {
      tree.now.set(newP as string, content);
      tree.now.set(p, null);
      tree.moves.push([p, newP as string]);
    } else {
      tree.now.set(p, content);
    }
  };
}

export function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let dashSeen = false;
  let inBody = false;
  let curHunk: { A: number; raw: string[] } | null = null;

  const flushBody = () => {
    if (curHunk && cur) {
      const raw = curHunk.raw.slice();
      while (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
      const items: BodyItem[] = [];
      for (const l of raw) {
        if (l === "\\" || l.startsWith("\\")) {
          const prev = items[items.length - 1];
          if (prev) prev.noNL = true;
          continue;
        }
        if (l === "") items.push({ kind: "ctx", text: "", noNL: false });
        else if (l.startsWith(" ")) items.push({ kind: "ctx", text: l.slice(1), noNL: false });
        else if (l.startsWith("-")) items.push({ kind: "old", text: l.slice(1), noNL: false });
        else items.push({ kind: "new", text: l.slice(1), noNL: false });
      }
      cur.hunks.push({ A: curHunk.A, items });
    }
    curHunk = null;
    inBody = false;
  };

  const closeSection = () => {
    flushBody();
    if (cur) sections.push(cur);
    cur = null;
    inHeader = false;
    dashSeen = false;
  };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (inBody) {
      if (l.startsWith("diff --git ")) {
        flushBody();
        continue;
      }
      if (
        l.startsWith("--- ") &&
        i + 1 < lines.length &&
        lines[i + 1].startsWith("+++ ")
      ) {
        flushBody();
        continue;
      }
      if (
        l === "" ||
        l.startsWith(" ") ||
        l.startsWith("-") ||
        l.startsWith("+") ||
        l.startsWith("\\")
      ) {
        curHunk!.raw.push(l);
        i++;
        continue;
      }
      flushBody();
      continue;
    }
    if (l.startsWith("@@")) {
      const m = HUNK_RE.exec(l);
      if (cur === null || m === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { A: Number(m[1]), raw: [] };
      inBody = true;
      inHeader = false;
      i++;
      continue;
    }
    if (l.startsWith("diff --git ")) {
      const rest = l.slice("diff --git ".length).trimEnd();
      const m = /^a\/(.+?) b\/(.+)$/.exec(rest);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      closeSection();
      cur = newSection();
      cur.diffOld = m[1];
      cur.diffNew = m[2];
      inHeader = true;
      i++;
      continue;
    }
    if (
      l.startsWith("--- ") &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith("+++ ")
    ) {
      if (cur !== null && inHeader && !dashSeen) {
        cur.dashOld = headerPath(l);
        cur.dashNew = headerPath(lines[i + 1]);
        dashSeen = true;
      } else {
        closeSection();
        cur = newSection();
        cur.dashOld = headerPath(l);
        cur.dashNew = headerPath(lines[i + 1]);
        dashSeen = true;
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith("--- ")) {
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith("+++ ")) {
        cur.dashNew = headerPath(l);
        dashSeen = true;
        i++;
        continue;
      }
      if (l.startsWith("rename from ")) {
        if (cur.renOld === undefined) cur.renOld = l.slice("rename from ".length).trim();
        i++;
        continue;
      }
      if (l.startsWith("rename to ")) {
        if (cur.renNew === undefined) cur.renNew = l.slice("rename to ".length).trim();
        i++;
        continue;
      }
      if (l.startsWith("new file mode")) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (l.startsWith("deleted file mode")) {
        cur.delFile = true;
        i++;
        continue;
      }
      // index, old mode, new mode, similarity index, dissimilarity index,
      // "Index:", and any other header line: ignored.
      i++;
      continue;
    }
    i++;
  }
  closeSection();
  return sections.map((s) => makeUnifiedEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE (SPEC section 7).
// ---------------------------------------------------------------------------

function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    requireSafe(path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail("exists", path);
      const content = newLines.length === 0 ? "" : newLines.join("\n") + "\n";
      tree.now.set(path, content);
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail("missing", path);
    const model = parseFile(cur);
    const found = findTier(model.lines, oldLines, strict);
    if (found === null) throw new Fail("no-match", path);
    if (found.pos.length > 1) throw new Fail("ambiguous", path);
    const pos = found.pos[0];
    const N: NewItem[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const repl = buildReplacement(model.lines, pos, oldLines[0], N, found.tier);
    const next = model.lines.slice();
    next.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, renderFile({ lines: next, br: model.br, finalBreak: model.finalBreak }));
  };
}

export function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== "<<<<<<< SEARCH") {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === "" || t.startsWith("```")) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === "<<<<<<< SEARCH") break;
      if (lines[j].trimEnd() === "=======") {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === "<<<<<<< SEARCH") break;
      if (lines[j].trimEnd() === ">>>>>>> REPLACE") {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(makeSREdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A (SPEC section 8).
// ---------------------------------------------------------------------------

export interface VChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

// First matching line at or after `from`, at the first tier with one.
function findFirstAtOrAfter(
  lines: string[],
  pat: string[],
  from: number,
  strict: boolean,
): number | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const p = occurrences(lines, pat, t).filter((x) => x >= from);
    if (p.length > 0) return p[0];
  }
  return null;
}

function findTierAtOrAfter(
  lines: string[],
  pat: string[],
  from: number,
  strict: boolean,
): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const p = occurrences(lines, pat, t).filter((x) => x >= from);
    if (p.length > 0) return { tier: t, pos: p };
  }
  return null;
}

function makeV4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    requireSafe(path);
    if (tree.get(path) !== null) throw new Fail("exists", path);
    const content = fileLines.length === 0 ? "" : fileLines.join("\n") + "\n";
    tree.now.set(path, content);
  };
}

function makeV4aDeleteEdit(path: string): Edit {
  return (tree) => {
    requireSafe(path);
    if (tree.get(path) === null) throw new Fail("missing", path);
    tree.now.set(path, null);
  };
}

function makeV4aUpdateEdit(
  path: string,
  moveTo: string | null,
  chunks: VChunk[],
  strict: boolean,
): Edit {
  return (tree) => {
    requireSafe(path);
    if (moveTo !== null) requireSafe(moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail("missing", path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail("exists", moveTo);
    const model = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findFirstAtOrAfter(model.lines, [ch.anchor], cursor, strict);
        if (at === null) throw new Fail("no-match", path);
        cursor = at + 1;
      }
      const O: string[] = [];
      const N: NewItem[] = [];
      for (const it of ch.items) {
        if (it.kind === "ctx") {
          N.push({ text: it.text, ctx: true, oIdx: O.length });
          O.push(it.text);
        } else if (it.kind === "old") {
          O.push(it.text);
        } else {
          N.push({ text: it.text, ctx: false, oIdx: -1 });
        }
      }
      if (O.length === 0) {
        const insertPos = ch.eof ? model.lines.length : cursor;
        const repl = N.map((n) => n.text);
        model.lines.splice(insertPos, 0, ...repl);
        cursor = insertPos + repl.length;
      } else {
        const occ = findTierAtOrAfter(model.lines, O, cursor, strict);
        if (occ === null) throw new Fail("no-match", path);
        let matchPos = occ.pos[0];
        if (ch.eof) {
          const ok = occ.pos.find((p) => p + O.length === model.lines.length);
          if (ok === undefined) throw new Fail("no-match", path);
          matchPos = ok;
        }
        const repl = buildReplacement(model.lines, matchPos, O[0], N, occ.tier);
        model.lines.splice(matchPos, O.length, ...repl);
        cursor = matchPos + repl.length;
      }
    }
    const content = renderFile(model);
    if (moveTo !== null) {
      tree.now.set(moveTo, content);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, content);
    }
  };
}

export function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2("error: parse 1");
  if (lines[first].trim() !== "*** Begin Patch") {
    throw new Exit2(`error: parse ${first + 1}`);
  }
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last])) last--;
  if (last < 0 || lines[last].trim() !== "*** End Patch") {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i])) i++;
    if (i >= last) break;
    const l = lines[i];
    let kind: "add" | "delete" | "update";
    let path: string;
    if (l.startsWith("*** Add File: ")) {
      kind = "add";
      path = l.slice("*** Add File: ".length).trim();
    } else if (l.startsWith("*** Delete File: ")) {
      kind = "delete";
      path = l.slice("*** Delete File: ".length).trim();
    } else if (l.startsWith("*** Update File: ")) {
      kind = "update";
      path = l.slice("*** Update File: ".length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sectionLine = i + 1;
    const rawStart = i + 1;
    const raw: Array<{ text: string; num: number }> = [];
    i++;
    while (i < last) {
      const s = lines[i];
      if (
        s.startsWith("*** Add File: ") ||
        s.startsWith("*** Delete File: ") ||
        s.startsWith("*** Update File: ")
      ) {
        break;
      }
      raw.push({ text: s, num: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1].text)) raw.pop();
    if (kind === "add") {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === "") fileLines.push("");
        else if (r.text.startsWith("+")) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(makeV4aAddEdit(path, fileLines));
    } else if (kind === "delete") {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0].num}`);
      edits.push(makeV4aDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0].text.startsWith("*** Move to: ")) {
        moveTo = raw[0].text.slice("*** Move to: ".length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      let eofPending = false;
      for (; idx < raw.length; idx++) {
        const t = raw[idx].text;
        const num = raw[idx].num;
        if (t.startsWith("@@")) {
          if (curChunk) {
            chunks.push(curChunk);
            curChunk = null;
          }
          const anchorText = t.slice(2).trim();
          curChunk = { anchor: anchorText === "" ? null : anchorText, items: [], eof: false };
          eofPending = false;
        } else if (t === "*** End of File") {
          if (!curChunk) throw new Exit2(`error: parse ${num}`);
          curChunk.eof = true;
          chunks.push(curChunk);
          curChunk = null;
          eofPending = true;
        } else if (t === "" || t.startsWith(" ") || t.startsWith("-") || t.startsWith("+")) {
          if (eofPending) throw new Exit2(`error: parse ${num}`);
          if (!curChunk) {
            if (chunks.length === 0) {
              curChunk = { anchor: null, items: [], eof: false };
            } else {
              throw new Exit2(`error: parse ${num}`);
            }
          }
          if (t === "") curChunk.items.push({ kind: "ctx", text: "", noNL: false });
          else if (t.startsWith(" ")) curChunk.items.push({ kind: "ctx", text: t.slice(1), noNL: false });
          else if (t.startsWith("-")) curChunk.items.push({ kind: "old", text: t.slice(1), noNL: false });
          else curChunk.items.push({ kind: "new", text: t.slice(1), noNL: false });
        } else {
          throw new Exit2(`error: parse ${num}`);
        }
      }
      if (curChunk) chunks.push(curChunk);
      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${sectionLine}`);
      }
      edits.push(makeV4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// CLI (SPEC section 1).
// ---------------------------------------------------------------------------

function parsePatch(format: Format, lines: string[], text: string, strict: boolean): Edit[] {
  if (format === "json") return jsonEdits(lines, text);
  if (format === "unified") return parseUnified(lines, strict);
  if (format === "search_replace") return parseSearchReplace(lines, strict);
  if (format === "v4a") return parseV4a(lines, strict);
  const detected = detect(lines);
  if (detected === null) throw new Exit2("error: format");
  return parsePatch(detected, lines, text, strict);
}

function failUsage(): number {
  console.log("error: usage");
  return 2;
}

function fail(msg: string): number {
  console.log(msg);
  return 2;
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function run(argv: string[]): number {
  let format: Format = "auto";
  let formatSet = false;
  let check = false;
  let strict = false;
  let file: string | null = null;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === "--") {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith("-") && a !== "-") {
      if (a === "--check" && !check) check = true;
      else if (a === "--strict" && !strict) strict = true;
      else if (a.startsWith("--format=") && !formatSet) {
        const f = a.slice("--format=".length);
        // The five names of section 1: auto, unified, search-replace
        // (hyphen), v4a, json. "search_replace" is not one of them.
        if (f === "search-replace") {
          format = "search_replace";
          formatSet = true;
        } else if (f === "auto" || f === "unified" || f === "v4a" || f === "json") {
          format = f as Format;
          formatSet = true;
        } else {
          return failUsage();
        }
      } else {
        return failUsage();
      }
      continue;
    }
    pos.push(a);
  }
  if (pos.length > 1) return failUsage();
  if (pos.length === 1) file = pos[0];
  let text = "";
  try {
    // PATCH absent or "-" means standard input.
    text = readFileSync(file === null || file === "-" ? 0 : file, "utf8");
  } catch {
    if (file !== null && file !== "-") return fail("error: no-patch");
  }
  const lines = patchLines(text);
  let edits: Edit[];
  try {
    edits = parsePatch(format, lines, text, strict);
  } catch (e) {
    if (e instanceof Exit2) return fail(e.message);
    throw e;
  }
  if (edits.length === 0) return fail("error: parse 1");

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (e instanceof Fail) {
        tree.now.clear();
        for (const [k, v] of snapshot) tree.now.set(k, v);
        tree.moves.length = movesLen;
        fails.push(e);
        continue;
      }
      throw e;
    }
  }
  if (fails.length > 0) {
    for (const f of fails) console.log(`error: ${f.code} ${f.path}`);
    console.log(`failed: ${fails.length} of ${edits.length} edits`);
    return 1;
  }

  // Output rows: a move is one "R <old> -> <new>" line (keyed by the new
  // path) exactly when the old file existed before and is gone after, and
  // the new file did not exist before and exists after; the R line then
  // replaces the D and A lines for those two paths.
  const rows: { key: string; line: string }[] = [];
  const coveredOld = new Set<string>();
  const coveredNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      coveredOld.add(oldP);
      coveredNew.add(newP);
    }
  }
  const changedPaths = [...tree.now.keys()].sort(byteCompare);
  for (const p of changedPaths) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (coveredOld.has(p) || coveredNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? "A" : now === null ? "D" : "M"} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));

  if (!check) {
    for (const p of changedPaths) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p);
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  for (const r of rows) console.log(r.line);
  console.log(`ok: ${rows.length} ${rows.length === 1 ? "file" : "files"}`);
  return 0;
}

const code = run(process.argv.slice(2));
process.exitCode = code;

// BEGIN: make.fun handover block (mandatory: kept verbatim from the kit's
// starter entrypoint; do not alter or remove).
const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl) {
  try {
    const res = await fetch(envUrl);
    if (res.ok) {
      const text = await res.text();
      process.stdout.write(text);
    }
  } catch {
    // Environment handover is best-effort and must not fail the run.
  }
}
// END: make.fun handover block.
