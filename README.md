# Ghaurlock PR Review Agent

Centralized Claude-powered PR review agent for every repo that calls it. Every project calls this repo's reusable workflow instead of keeping its own copy of the review logic — update the logic here once, it applies everywhere.

## How it works

1. This repo hosts the reusable workflow at `.github/workflows/claude-pr-review.yml`. That file is a thin orchestrator: it checks out the PR, then runs the `inspector-g` composite action via GitHub's self-repository `$/` syntax. `$/` resolves to **this** private repo at the exact commit the caller pinned — no extra checkout, no PAT, and a SHA-pinned caller cannot silently pick up newer scripts from `main`.
2. The review logic lives in real files under `src/` (prompts, diff assembly, Claude client, comment formatting, GitHub posting). The composite action at `.github/actions/inspector-g/` wires those files together.
3. Each project repo has a tiny caller workflow that triggers on `pull_request` and calls this repo's workflow via `workflow_call`.
4. The caller workflow's job checks out the PR; the composite action generates the diff, reviews it, and posts the review as **one comment on the pull request**, edited in place after every push. The same comment carries hidden checkpoint data (`head_sha`, issue ids, dismissals) for the next run. CRITICAL, HIGH, and MEDIUM findings also get inline comments on the exact lines, with a one-click **Commit suggestion** fix where the fix is small.

This repo is **private**. Callers never need to check it out themselves — the only cross-repo operation is the `uses:` reference to the reusable workflow, which GitHub resolves once org access is granted (see below).

## Layout

```
.github/workflows/claude-pr-review.yml   # reusable workflow (caller API)
.github/workflows/test.yml               # unit tests for this repo
.github/actions/inspector-g/action.yml    # composite action (step orchestration)
src/
  prompts.js           # system + user prompt
  diff-lines.js        # line-numbered diff + "did the PR change this line?" scope check
  repo-context.js      # full touched files, usages elsewhere, team rules file
  verify.js            # second-pass verification of new findings
  assemble-diff.js     # diff parsing + size cap
  claude-client.js     # Anthropic API + JSON parse
  scoring.js           # score + risk derived from the open-issue ledger
  format-comment.js    # review markdown
  collect-context.js   # previous review + human dismissals
  post-comment.js      # review comment (with checkpoint data) + inline comments
  review.js            # CLI entry: diff → Claude → /tmp/review.txt
scripts/               # git diff helpers
test/                  # node:test unit tests
```

## One-time org setup

Since this repo is private, allow other org repos to call its reusable workflow **and** its composite action: in **this repo's** Settings → Actions → General → Access, set "Accessible from repositories owned by 'ghauri899'" (or list specific repos). Without this, other repos' `uses: ghauri899/auto-review-agent/...` calls will fail with a permissions error.

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
    uses: ghauri899/auto-review-agent/.github/workflows/claude-pr-review.yml@main
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Prefer pinning a commit SHA instead of `@main` once a revision is proven. No script files, no npm install steps, and no duplicated review logic need to live in the target repo.

## Using the review

The review is a single Inspector G comment in the PR conversation, edited in place on every push so its link never changes and edits notify no one. When the verdict flips between **🚫 Not ready to merge** and **✅ Ready to merge**, a one-line comment is added at the bottom (`🕵️ Re-reviewed abc1234: ✅ Ready to merge — full review ↑`) so the change is not lost above later discussion. The PR description is never touched; pull requests reviewed by older versions have their old description block removed on the next run. Findings are numbered (`3. Auth bypass`) and those numbers stay stable across runs.

Dismiss a finding by commenting on the PR. `N` is the number in front of the issue title (for example **3.** in `3. Auth bypass`) — it does not change on later reviews:

```text
3. false positive because we validate at the gateway
```

`won't fix`, `by design`, and `not a bug` work in place of `false positive`. One comment can dismiss several findings — put each on its own line (`1. false positive …`, `2. by design …`). Dismissals are applied on the next push, or immediately if you re-run the **Claude Code Review** job: a re-run on the same commit replays the last review and applies dismissals without calling Claude.

The review ends with a **↻ Re-run this review** link pointing at the Actions run that produced it, so you do not have to hunt for the job in the Actions tab — follow it and press **Re-run all jobs**. GitHub has no URL that starts a re-run directly (it is a CSRF-protected POST), so that second click is unavoidable. The link is rebuilt on every run and a re-run keeps the same run id, so it never goes stale. It renders only inside Actions; locally the review has no footer.

Dismissed findings are never dropped from the review. They move to a **Marked not an issue by a reviewer** table that records the finding number, a verdict read from your wording (*False positive*, *By design*, *Not a bug*, *Not applicable*, *Won't fix*), the reason you typed, and your username — so every waved-off finding stays auditable across runs.

Previously resolved findings accumulate in the review instead of disappearing after the next pass. The header shows the run count (`Review #4`).

### What gets reviewed

Every run reviews the **complete pull request diff**, including code that earlier runs already saw, and including commits this push did not touch.

Reviewing only the newest commits would be cheaper, and Inspector G deliberately does not do it. A pull request that touches `auth.js` in commit 2 and `README.md` in commit 7 would, under incremental review, have `auth.js` scanned once and never looked at again — a regression there is not missed, it is never searched for. Review recall is worth more than the token saving, so the whole PR goes to Claude on every run.

Continuity across runs does not come from narrowing the diff. It comes from the previous findings passed alongside it: Claude marks each one `still_open` or `resolved`, dismissals are suppressed, and anything it does not mention is carried forward rather than closed. Two cheaper paths remain, and neither narrows what is scanned:

- A **re-run on the same commit** replays the stored checkpoint and applies new dismissals without calling Claude at all.
- A diff over `MAX_DIFF_CHARS` drops whole files rather than slicing mid-hunk, and names the omitted files in the prompt.

The cost of this choice is real: a long-lived PR re-reads its full diff on every push. If that ever needs tuning, lower `output_config.effort` in `src/claude-client.js` or tighten the pathspecs in `scripts/diff-pathspecs.sh` — do not reintroduce incremental scanning.

### What the review looks like

The review opens with a one-line verdict anyone can read — `🚫 Not ready to merge — 2 blockers` or `✅ Ready to merge · 1 suggestion` — then the score badges and, from the second run on, a score timeline (`#1 1.5 → #2 3.9 📈`). Below that:

- **🧭 What this pull request does** — a plain-English overview for non-engineers and one line per changed file (collapsed).
- **🗺️ How the change flows** — a Mermaid diagram of the changed flow (collapsed), only when the PR moves a request or data across three or more files (`MIN_DIAGRAM_FILES`). Diagrams that are not a `sequenceDiagram` or `flowchart`, are oversized, or carry directives are dropped rather than rendered as an error box.
- **Must-fix issues** behind a red (CRITICAL) or amber (HIGH) GitHub alert box, then advisory issues. A finding that has an inline comment shows as one line here — title, a link to the cited lines, and **💬 details & fix** linking to that comment — so its write-up appears once, on the code. Findings without an inline comment (LOW, past the inline cap, or on a line GitHub cannot comment on) keep their full collapsible card.
- **📊 Score Breakdown** — collapsed at the bottom; the headline already carries the verdict.

Every `file:line` is a permalink to those lines at the reviewed commit, so it still points at the right code after later pushes. Severity marks are the same everywhere a finding appears: 🔴 CRITICAL, 🟠 HIGH, 🟡 MEDIUM, 🔵 LOW.

The Actions run page gets a job summary (verdict plus a table of open findings), and findings without an inline comment are added as annotations, which show in the run's Checks tab and on the diff. This needs no extra token permission. A pass/fail status for the PR is left to the merge gate, since failing the job is what blocks merging.

### Inline comments and one-click fixes

Every open CRITICAL, HIGH, and MEDIUM finding (up to `MAX_INLINE_COMMENTS`) is also posted on its line of the diff, all in one review so the author gets one notification. LOW findings appear in the review comment only. When a fix is a small change to a few contiguous lines the PR changed, the comment carries a GitHub suggestion block: the author presses **Commit suggestion** and the fix is applied. Suggestions are only offered when every replaced line is in one hunk of the current diff and at least one was changed by the PR; otherwise the comment carries the written fix alone.

A comment that is unchanged since the last run is left in place rather than deleted and re-posted, so pushing does not re-notify anyone about findings they have already seen.

When a finding is fixed or dismissed, its thread is not deleted: Inspector G replies (`✅ Resolved — as of abc1234, Inspector G no longer finds this problem.` or `☑️ Closed — marked as False positive by @someone`) and resolves the thread, so the discussion stays on the PR and the open threads are the open findings. A comment whose finding moved to a different line is still replaced.

### Only what the pull request introduces

Inspector G flags problems the PR's own code creates — never pre-existing issues in code the PR did not change, however serious. Two gates enforce this between Claude's raw findings and the PR:

1. **Scope check (deterministic, free).** The diff Claude reads carries new-file line numbers in a left gutter, and every new finding must cite them. A finding is kept only if it points at a file the PR touches, on or within two lines of a line the PR added or deleted. Anything else is dropped before it is published. An unchanged caller that the PR newly breaks is reported against the changed line that breaks it.
2. **Verification pass.** A second model (`VERIFY_MODEL` in `src/constants.js`, Sonnet by default) tries to disprove each surviving new finding and separately judges whether it would already exist on the base branch. Rejected and pre-existing findings are dropped. If the verifier errors or skips a finding, the finding is kept — a broken second pass must never hide a real bug.

Both gates apply to **new** findings only. A finding already published on an earlier run is never silently dropped; it closes by being fixed or dismissed. Dropped findings are listed in the Actions log, and the review shows a one-line count (`🛡️ 3 possible findings were double-checked and left out…`).

### What Claude sees besides the diff

Read-only context, which Claude is told never to report on:

- **Full content of each modified file** after the change, so a hunk is judged with the code around it (`MAX_CONTEXT_*` budgets in `src/constants.js`; new files are already whole in the diff).
- **Usages elsewhere in the repo** of functions the PR defines or changes, so a changed signature is checked against callers the PR did not touch.
- **Team rules** from `.github/inspector-g.md` in the reviewed repo, read from the **base** branch so a PR cannot rewrite the rules it is reviewed under. Plain prose, for example:

  ```markdown
  - Input is validated at the API gateway; do not flag missing validation in handlers under src/handlers/.
  - console.log is allowed in scripts/.
  ```

- **Past dismissals from other PRs in the same repo.** When an org owner, member, or collaborator dismisses a finding, later reviews in that repo stop raising the same kind of concern. Dismissals by anyone else still apply to their own PR but teach the bot nothing.

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

Do not delete the Inspector G review comment — its hidden data is the bot-owned source of truth for `head_sha`, issue ids, and dismissals. If it is deleted, the next run starts over from review #1. When the review and the data together exceed GitHub's 65,000-character comment limit, the data is compacted first and the review text is shortened second; the data itself is never dropped.

## Updating the review logic

Edit the files under `src/` (or the composite action / scripts). Every caller repo that tracks `@main` picks up the change on its next PR run.

Tune review criteria in `src/prompts.js`. Change the review layout in `src/format-comment.js`. Leave `.github/workflows/claude-pr-review.yml` alone unless the caller-facing API itself needs to change.

This repo runs `npm test` on pull requests via `.github/workflows/test.yml`.

```bash
npm test
```
