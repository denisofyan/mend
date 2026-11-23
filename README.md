# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/denisofyan/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/denisofyan/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a command-line patch tool that reads edits in every format AI agents emit — unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON tool calls — finds the named lines with three-tier fuzzy matching (exact, trailing-whitespace-insensitive, then full-trim with re-indentation), and writes every change or none. It prints what changed, or exactly why an edit failed, and never leaves a tree half-patched.

## Run it

```sh
node main.ts [options] [PATCH]
```

Run it from the root of the tree being patched; the patch comes from the file argument or from standard input. `--strict` turns the fuzzy tiers off and matches lines exactly. Node 22, standard library only.

---

<sub>Entered on [make.fun](https://make.fun/?ref=rh2b11xn&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
