#!/usr/bin/env bash
# Diff from the actual fork point (merge-base) of this PR's base/head
# commits, not from base.sha directly. base.sha is the *live tip* of the
# target branch — if other PRs have merged into it since this branch was
# created, diffing straight against base.sha pulls in those unrelated
# catch-up changes as if they were part of this PR. Computing the
# merge-base of these two fixed, PR-specific commits (rather than
# resolving a moving branch ref like origin/dev) also avoids the
# "multiple merge bases" ambiguity seen on branches with a criss-cross
# history. This matches exactly what GitHub's own "Files changed" tab
# shows.
set -euo pipefail

: "${BASE_SHA:?BASE_SHA is required}"
: "${HEAD_SHA:?HEAD_SHA is required}"

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/diff-pathspecs.sh"

MERGE_BASE=$(git merge-base "$BASE_SHA" "$HEAD_SHA")
git diff "$MERGE_BASE" "$HEAD_SHA" -- "${DIFF_PATHSPECS[@]}" > /tmp/pr.diff
echo "Diff size: $(wc -c < /tmp/pr.diff) bytes (merge-base ${MERGE_BASE:0:7})"
