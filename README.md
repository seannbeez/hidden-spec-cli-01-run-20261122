# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/seannbeez/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/seannbeez/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one patch tool for every AI edit format — unified diffs (often with wrong
line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as
JSON — applied to a tree of text files, to one written specification (`SPEC.md`).
It finds the lines an edit names even when the model drifted their whitespace or
indentation, and changes every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, relative to the working directory (the root of the
tree); when it is absent or `-`, the patch is read from standard input.

```sh
node main.ts fix.patch
node main.ts --format=search-replace patch.txt
echo '{"command":"create","path":"x.txt","file_text":"hi"}' | node main.ts -
node main.ts --check --strict edit.patch
```

Options: `--format=auto|unified|search-replace|v4a|json` (default `auto`,
detected from the patch text), `--check` (same output and exit code, writes
nothing), `--strict` (exact line matching only, tier 0).

## What it does

- **Four formats, one contract.** Unified diffs (create, delete, rename, change,
  multi-file, multi-hunk), SEARCH/REPLACE blocks (including creates and
  path inheritance), V4A patches (add, delete, update, move-to, anchored and
  end-of-file chunks), and JSON edits (`create`, `str_replace`, `insert`, array
  or JSON Lines).
- **Three matching tiers.** An edit's old lines are found at the first tier
  where they occur: exact, trailing whitespace stripped, then leading and
  trailing whitespace stripped. Context lines are written as the file's own
  lines; at tier 2 new lines are re-indented from the patch's indent to the
  file's indent. Unified hunks take the occurrence nearest to their (possibly
  wrong) line number; V4A chunks work from a cursor past their anchor.
- **All or nothing.** Edits apply in order to the tree as earlier edits left
  it. A failed edit changes nothing and later edits still run; when any edit
  failed, no file is written. Exit 0 lists what changed (`A`/`D`/`M`,
  `R old -> new` for moves); exit 1 lists every failure; exit 2 is one line
  for usage, unreadable patch, undetected format, or a parse fault with its
  line number.
- **Faithful to the file.** CRLF files stay CRLF, a file without a final line
  break keeps it unless a hunk that runs to its end says otherwise, and
  `\ No newline at end of file` is honoured.
- **Deterministic.** The same check gives the same exit code, stdout, and
  files every run. Node 22, standard library only, nothing installed.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the kit's trial runner, kept as it is.
- `SPEC.md` — the specification this tool implements, version 1.

Local verification: 100/100 public practice checks (unified 30/30,
SEARCH/REPLACE 20/20, V4A 20/20, JSON 15/15, CLI 15/15), plus 84/84
self-made withheld-style cases built from SPEC.md sentences the practice set
does not cover, with byte-identical output on repeat runs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ebv85brk&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
