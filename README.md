# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/donatfarm01/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/donatfarm01/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend applies AI-written edits to a tree of text files — in any of the four
formats models actually emit — and it does so atomically: either every edit
lands, or no file is written at all.

Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty, $100 in USDC.

## The four formats

- **Unified diff** — `diff --git` sections, `---`/`+++` headers, `@@` hunks,
  renames, creations, deletions, `\ No newline at end of file`.
- **SEARCH/REPLACE** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`
  blocks, path taken from the nearest line above the block.
- **V4A** — `*** Begin Patch` / `*** End Patch` with `*** Add File:`,
  `*** Delete File:` and `*** Update File:` sections, anchors, `@@` chunks
  and `*** End of File`.
- **JSON tool calls** — one JSON array, or JSON Lines, of `create` /
  `str_replace` / `insert` commands.

The format is detected automatically (`--format=auto`, the default), or
forced with `--format=unified|search_replace|v4a|json`.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a file, `-`, or stdin when omitted. Options may come in any
order; `--` ends the options.

- `--check` — report what would change, write nothing.
- `--strict` — exact (tier 0) matching only.

## Matching

A block's old lines are matched in three tiers: exact, then trailing
whitespace ignored, then leading and trailing whitespace ignored. The
first tier with a match wins. At tier 2, new lines are re-indented to the
file's indentation, and context lines are always written as the file's
own matched lines — never the patch's. Unified hunks take the occurrence
nearest the hunk's line number; SEARCH/REPLACE and JSON demand exactly
one occurrence, else the edit is `ambiguous`.

## Output and exit codes

- `0` — every edit applied. One line per changed file, in path byte
  order: `A <path>`, `D <path>`, `M <path>`, or `R <old> -> <new>` for
  moves. Then `ok: <n> file(s)`.
- `1` — one or more edits failed. Nothing is written. Every failure is
  reported (`error: <code> <path>`, one per failed edit) followed by
  `failed: <k> of <n> edits`. Codes: `no-match`, `ambiguous`, `missing`,
  `exists`, `unsafe`.
- `2` — usage error, no patch, unknown format, or a parse error:
  `error: usage`, `error: no-patch`, `error: format`, or
  `error: parse <line>`.

## Atomicity

Edits apply in patch order to the tree as earlier edits left it. A failed
edit changes nothing and later edits still run, but if any edit fails no
file on disk is written. Paths are checked for safety (no absolute paths,
no `..`, no backslashes, no empty segments) before anything else about
the edit. `--check` never writes.

## Files

- `main.ts` — the whole tool. Node 22, standard library only.
- `runner.ts` / `check.ts` — the kit's harness runner and practice
  checker (from the bounty starter kit, unchanged).
- `SPEC.md` — the full specification this tool implements.

## Development

```
node check.ts ../program/generator/practice.json   # 100 practice checks
```

Practice set: 100 checks (unified 30, search_replace 20, v4a 20,
json 15, cli 15).
