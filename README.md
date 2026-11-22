# mend — one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files.
Models write edits in four formats, and `mend` reads all four to one
specification (`SPEC.md`):

- unified diffs (even with wrong line numbers),
- SEARCH/REPLACE blocks,
- V4A patches,
- text-editor tool calls as JSON.

It finds the lines each edit names at the first of three matching tiers
(exact, trailing whitespace ignored, both sides' whitespace ignored),
re-indents added lines to the file's own indentation at the loosest tier,
and writes every change or none: a failed edit changes nothing, the edits
after it still run, and when any edit failed no file is written.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory; when it is
  absent or `-`, the patch is read from standard input. The working
  directory is the root of the tree.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`, or `auto` (the default), which detects the format.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new`
for a move) and `ok: <n> files`. Exit 1 lists each failed edit
(`error: <code> <path>`) and `failed: <k> of <n> edits`. Exit 2 prints
exactly one line for a usage, missing-patch, format or parse error.

## Files

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the kit's trial runner; `main.ts` hands a trial over to it
  when `MAKEFUN_ENV_URL` is set.
- `check.ts` — runs `main.ts` on the kit's public practice set:
  `node check.ts <practice.json>`.
- `SPEC.md` — the whole contract.
