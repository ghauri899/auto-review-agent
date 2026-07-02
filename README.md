# auto-review-agent

Centralized Claude-powered PR review agent for all Staunchglobal org repos. Every project calls this repo's reusable workflow instead of keeping its own copy of the review logic — update the logic here once, it applies everywhere.

## How it works

1. This repo hosts the reusable workflow at `.github/workflows/claude-pr-review.yml`. The review script is embedded directly in that workflow file (written to disk at runtime) rather than kept as a separate file — this repo is **private**, and a separate `actions/checkout` of this repo from another repo's job would not have access. Embedding the script means the only cross-repo operation is the `uses:` reference to the reusable workflow itself, which GitHub resolves directly regardless of visibility once access is granted (see below).
2. Each project repo has a tiny caller workflow that triggers on `pull_request` and calls this repo's workflow via `workflow_call`.
3. The caller workflow checks out the PR, generates a diff against the base branch, then the reusable workflow runs the review and posts a PR comment.

## One-time org setup

Since this repo is private, allow other org repos to call its reusable workflow: in **this repo's** Settings → Actions → General → Access, set "Accessible from repositories in the 'Staunchglobal' organization" (or list specific repos). Without this, other repos' `uses: Staunchglobal/auto-review-agent/...` calls will fail with a permissions error.

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

No script files, no npm install steps, and no duplicated review logic need to live in the target repo.

## Updating the review logic

Edit the embedded script (or the surrounding steps) directly in `.github/workflows/claude-pr-review.yml`. Every caller repo picks up the change on its next PR run (since callers reference `@main`).
