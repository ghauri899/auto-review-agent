# Ghaurlock PR Review Agent

Centralized Claude-powered PR review agent for all Staunchglobal org repos. Every project calls this repo's reusable workflow instead of keeping its own copy of the review logic — update the logic here once, it applies everywhere.

## How it works

1. This repo hosts the reusable workflow at `.github/workflows/claude-pr-review.yml`. That file is a thin orchestrator: it checks out the PR, then runs the `inspector-g` composite action via GitHub's self-repository `$/` syntax. `$/` resolves to **this** private repo at the exact commit the caller pinned — no extra checkout, no PAT, and a SHA-pinned caller cannot silently pick up newer scripts from `main`.
2. The review logic lives in real files under `src/` (prompts, diff assembly, Claude client, comment formatting, GitHub posting). The composite action at `.github/actions/inspector-g/` wires those files together.
3. Each project repo has a tiny caller workflow that triggers on `pull_request` and calls this repo's workflow via `workflow_call`.
4. The caller workflow's job checks out the PR; the composite action generates the diff, reviews it, writes the review into the **pull request description** (always at the top), and keeps a small bot-only checkpoint comment for `head_sha` / issue ids. CRITICAL/HIGH findings also get inline comments on the diff.

This repo is **private**. Callers never need to check it out themselves — the only cross-repo operation is the `uses:` reference to the reusable workflow, which GitHub resolves once org access is granted (see below).

## Layout

```
.github/workflows/claude-pr-review.yml   # reusable workflow (caller API)
.github/workflows/test.yml               # unit tests for this repo
.github/actions/inspector-g/action.yml    # composite action (step orchestration)
src/
  prompts.js           # system + user prompt
  assemble-diff.js     # diff parsing + size cap
  claude-client.js     # Anthropic API + JSON parse
  scoring.js           # score + risk derived from the open-issue ledger
  format-comment.js    # review markdown
  collect-context.js   # previous review + human dismissals
  post-comment.js      # PR description + checkpoint + inline must-fix
  review.js            # CLI entry: diff → Claude → /tmp/review.txt
scripts/               # git diff helpers
test/                  # node:test unit tests
```

## One-time org setup

Since this repo is private, allow other org repos to call its reusable workflow **and** its composite action: in **this repo's** Settings → Actions → General → Access, set "Accessible from repositories in the 'Staunchglobal' organization" (or list specific repos). Without this, other repos' `uses: Staunchglobal/auto-review-agent/...` calls will fail with a permissions error.

## Adding review to a new repo

1. Add `ANTHROPIC_API_KEY` as a **repo-level secret** in that project's own Settings → Secrets and variables → Actions → Repository secrets. Each repo uses its own key — keys are not shared across repos, so usage/billing is isolated per project.
2. Add this file to the target repo at `.github/workflows/claude-pr-review.yml` (adjust the `branches` filter as needed):

```yaml
name: Automatic PR Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches:
      - staging

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    uses: Staunchglobal/auto-review-agent/.github/workflows/claude-pr-review.yml@main
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Prefer pinning a commit SHA instead of `@main` once a revision is proven. No script files, no npm install steps, and no duplicated review logic need to live in the target repo.

## Using the review

The Inspector G block is appended to the bottom of the PR description (the author's write-up stays on top, untouched). Findings are numbered (`3. Auth bypass`) and those numbers stay stable across runs.

Dismiss a finding by commenting on the PR. `N` is the number in front of the issue title (for example **3.** in `3. Auth bypass`) — it does not change on later reviews:

```text
3. false positive because we validate at the gateway
```

`won't fix`, `by design`, and `not a bug` work in place of `false positive`. One comment can dismiss several findings — put each on its own line (`1. false positive …`, `2. by design …`). Dismissals are applied on the next push, or immediately if you re-run the **Claude Code Review** job: a re-run on the same commit replays the last review and applies dismissals without calling Claude.

The review ends with a **↻ Re-run this review** link pointing at the Actions run that produced it, so you do not have to hunt for the job in the Actions tab — follow it and press **Re-run all jobs**. GitHub has no URL that starts a re-run directly (it is a CSRF-protected POST), so that second click is unavoidable. The link is rebuilt on every run and a re-run keeps the same run id, so it never goes stale. It renders only inside Actions; locally the review has no footer.

Dismissed findings are never dropped from the review. They move to a **Marked not an issue by a reviewer** table that records the finding number, a verdict read from your wording (*False positive*, *By design*, *Not a bug*, *Not applicable*, *Won't fix*), the reason you typed, and your username — so every waved-off finding stays auditable across runs.

Previously resolved findings accumulate in the review instead of disappearing after the next pass. The header shows the run count (`Review #4`). The author's own write-up stays at the top of the description, with the review below it after a horizontal rule.

### What gets reviewed

Every run reviews the **complete pull request diff**, including code that earlier runs already saw, and including commits this push did not touch.

Reviewing only the newest commits would be cheaper, and Inspector G deliberately does not do it. A pull request that touches `auth.js` in commit 2 and `README.md` in commit 7 would, under incremental review, have `auth.js` scanned once and never looked at again — a regression there is not missed, it is never searched for. Review recall is worth more than the token saving, so the whole PR goes to Claude on every run.

Continuity across runs does not come from narrowing the diff. It comes from the previous findings passed alongside it: Claude marks each one `still_open` or `resolved`, dismissals are suppressed, and anything it does not mention is carried forward rather than closed. Two cheaper paths remain, and neither narrows what is scanned:

- A **re-run on the same commit** replays the stored checkpoint and applies new dismissals without calling Claude at all.
- A diff over `MAX_DIFF_CHARS` drops whole files rather than slicing mid-hunk, and names the omitted files in the prompt.

The cost of this choice is real: a long-lived PR re-reads its full diff on every push. If that ever needs tuning, lower `output_config.effort` in `src/claude-client.js` or tighten the pathspecs in `scripts/diff-pathspecs.sh` — do not reintroduce incremental scanning.

### How the score is calculated

The **Quality Score** and **Risk** badges describe the pull request as a whole, not the commits the latest run happened to look at. Both are computed in `src/scoring.js` from the ledger of findings that are still open across every run:

- **Risk** is the worst severity still open. It cannot read `LOW` while a CRITICAL from an earlier run is unresolved.
- **Quality Score** starts at 5.0 and loses 2.0 per open CRITICAL, 1.0 per HIGH, 0.4 per MEDIUM, and 0.15 per LOW. Claude's own rating of the code it read acts as a ceiling, so messy code with no concrete findings can still score below 5.0, but a clean run can never wash out findings left open from an earlier one.
- The same penalties apply per dimension in the **Score Breakdown**, charged to the dimension each finding's category belongs to (`SECURITY` → security, `BUG`/`DATA_INTEGRITY` → correctness, and so on).

Because the score is derived from the open ledger, it moves when the ledger moves: fixing or dismissing a finding raises it on the next run, including on a same-commit re-run. The line under the breakdown states how many findings are open, across how many runs, and what the previous run scored.

A finding is only closed when Claude explicitly reports it as `resolved`. One it simply does not mention — the per-run cap on new findings or a truncated diff can both drop one from the response — is carried forward as still open rather than silently dropped, and its card is marked *carried forward* so you can tell it was not re-examined this run. Carried-forward findings do not get inline comments, because their line numbers belong to an older commit.

So that a carried-forward finding can never get stuck open forever, it is closed automatically when either:

- the PR no longer touches its file at all (the change was reverted or dropped), measured against the uncapped diff so a file skipped only for size is not closed by mistake; or
- the PR's diff is empty, leaving no code for any finding to apply to.

Failing those, dismissing it by number always works.

Do not delete the short `Inspector G checkpoint` comment — it is the bot-owned source of truth for `head_sha` and issue ids. The visible review is only in the description.

## Updating the review logic

Edit the files under `src/` (or the composite action / scripts). Every caller repo that tracks `@main` picks up the change on its next PR run.

Tune review criteria in `src/prompts.js`. Change the PR description layout in `src/format-comment.js`. Leave `.github/workflows/claude-pr-review.yml` alone unless the caller-facing API itself needs to change.

This repo runs `npm test` on pull requests via `.github/workflows/test.yml`.

```bash
npm test
```
