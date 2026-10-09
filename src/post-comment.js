'use strict';

const fs = require('node:fs');
const {
  STICKY_MARKER,
  INLINE_MARKER,
  BODY_START,
  BODY_END,
  COMMENT_LIMIT,
  PR_BODY_LIMIT,
  MAX_INLINE_COMMENTS,
  ISSUE_ID_RE,
  PATHS,
} = require('./constants');
const {
  readJson,
  isDismissed,
  encodePayload,
  compactIssues,
  compactResolved,
  compactDismissed,
  parseLineRef,
  upsertPrBody,
  isCheckpointComment,
} = require('./shared');

function buildVisibleBody(review, runCount = 1) {
  return [
    '### 🕵️ Inspector G — Automated Code Review',
    '',
    review,
    '',
    `<sub>Reviewed by <b>Inspector G</b> · run <span>#</span>${runCount} · powered by <a href="https://claude.ai">Claude</a></sub>`,
    '',
    // Collapsed by default. The instructions are read once; the review is read
    // every run, and six lines of blockquote pushed it down the description.
    '<details>',
    '<summary><b>How to respond to a finding</b></summary>',
    '',
    '**Fixed it?** Just push. The next review closes the finding and files it under *Previously resolved* — no comment needed.',
    '',
    '**Not a real problem?** Comment its number and why: `3. false positive because we validate at the gateway`',
    '',
    "Also accepted in place of `false positive`: `won't fix`, `by design`, `not a bug`, `not applicable`, `works as intended`. One comment can dismiss several findings, one per line.",
    '',
    'The number (`3.`) is the one in front of the title and never changes across runs. Dismissed findings are not deleted — they move to **Marked not an issue by a reviewer**, keeping your reason and username on the record.',
    '',
    '</details>',
    '',
  ].join('\n');
}

function buildCheckpointVisible(runCount) {
  return [
    STICKY_MARKER,
    'Inspector G checkpoint — the review lives in the pull request description.',
    '',
    `Run #${runCount}. Do not delete this comment.`,
  ].join('\n');
}

function buildCommentBody({ visibleBody, payload, sourceIssues }) {
  function bodyWithPayload(issuesFactory) {
    const encoded = encodePayload({ ...payload, issues: issuesFactory() });
    return `${visibleBody}\n\n<!-- inspector-g-data ${encoded} -->`;
  }

  let body = bodyWithPayload(() => payload.issues);
  if (body.length > COMMENT_LIMIT) {
    payload.issues = compactIssues(sourceIssues, false);
    payload.resolved = compactResolved(payload.resolved);
    payload.dismissed = compactDismissed(payload.dismissed);
    delete payload.summary;
    // score_breakdown is derived, so it is recomputed on the next run;
    // model_score / model_breakdown / score_history are the inputs that
    // cannot be rebuilt, and are small enough to always keep.
    delete payload.score_breakdown;
    delete payload.score_rationale;
    payload.score_history = (payload.score_history || []).slice(-5);
    body = bodyWithPayload(() => payload.issues);
  }
  if (body.length > COMMENT_LIMIT) {
    body = visibleBody;
  }
  return body;
}

function issueCovered(item, issue) {
  if (item.issueId != null && issue.id != null && Number(item.issueId) === Number(issue.id)) return true;
  if (item.dismissed && isDismissed(issue, [item])) return true;
  return (
    String(item.file || '').toLowerCase() === String(issue.file || '').toLowerCase() &&
    String(item.title || '') === String(issue.title || '')
  );
}

function selectMustFixIssues(parsedReview, reviewContext) {
  const keepInline = reviewContext.keep_inline || [];
  const dismissed = reviewContext.dismissals || [];

  return (parsedReview.issues || []).filter((issue) => {
    if (issue.status === 'resolved') return false;
    if (!(issue.severity === 'CRITICAL' || issue.severity === 'HIGH')) return false;
    if (!issue.file || !issue.line_reference) return false;
    // Carried forward from an earlier run without being re-examined, so its
    // line_reference belongs to an older commit. Inline comments are anchored
    // to the new head SHA, where that line is unrelated code — or does not
    // exist and the API 422s. It still shows in the description.
    if (issue.carried_forward) return false;
    if (isDismissed(issue, dismissed)) return false;
    if (keepInline.some((item) => issueCovered(item, issue))) return false;
    return true;
  });
}

function inlineCommentBody(issue) {
  const sevEmoji = issue.severity === 'CRITICAL' ? '🔴' : '🟠';
  const idLabel = issue.id != null ? `${issue.id}. ` : '';
  const bodyLines = [`${sevEmoji} **${issue.severity}: ${idLabel}${issue.title}**`, ''];
  if (issue.id != null) bodyLines.push(`<!-- inspector-g-id: ${issue.id} -->`, '');
  if (issue.failure_mode) bodyLines.push(`**Failure mode:** ${issue.failure_mode}`, '');
  bodyLines.push(`**Fix:** ${issue.fix}`, '', INLINE_MARKER);
  return bodyLines.join('\n');
}

function buildPayload({ parsedReview, reviewContext, context, reviewSucceeded }) {
  const previous = reviewContext.previous || null;
  const sourceIssues = reviewSucceeded ? parsedReview.issues : previous?.issues;
  const source = reviewSucceeded ? parsedReview : previous || {};
  return {
    head_sha: reviewSucceeded ? context.payload.pull_request?.head?.sha : previous?.head_sha || null,
    score: source.score,
    // Claude's own read of the code it saw, kept separate from the published
    // score (which is derived from the open ledger) so a same-commit re-run
    // can recompute from the same baseline after dismissals land.
    model_score: source.model_score ?? source.score ?? null,
    model_breakdown: source.model_breakdown ?? source.score_breakdown ?? null,
    score_history: source.score_history ?? previous?.score_history ?? [],
    risk_level: source.risk_level,
    // Kept so a same-commit re-run can re-render and apply dismissals
    // without another Claude call.
    summary: source.summary ?? null,
    score_breakdown: source.score_breakdown ?? null,
    score_rationale: source.score_rationale ?? '',
    run_count: reviewSucceeded ? parsedReview.run_count || (previous?.run_count || 0) + 1 : previous?.run_count || 0,
    next_id: reviewSucceeded ? parsedReview.next_id : previous?.next_id,
    issues: compactIssues(sourceIssues, true),
    resolved: compactResolved(reviewSucceeded ? parsedReview.resolved : previous?.resolved),
    // Audit trail of findings a human waved off, with the reason they gave.
    dismissed: compactDismissed(reviewSucceeded ? parsedReview.dismissed : previous?.dismissed),
    dismissals: reviewContext.dismissals || [],
  };
}

async function upsertCheckpointComment({ github, context, reviewContext, body }) {
  let stickyId = reviewContext.sticky_comment_id;
  if (!stickyId) {
    const issueComments = await github.paginate(github.rest.issues.listComments, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.issue.number,
      per_page: 100,
    });
    const existing = [...issueComments].reverse().find(isCheckpointComment);
    stickyId = existing ? existing.id : null;
  }

  if (stickyId) {
    await github.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: stickyId,
      body,
    });
    console.log(`Updated checkpoint comment ${stickyId}`);
    return;
  }

  await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.issue.number,
    body,
  });
  console.log('Created checkpoint comment');
}

async function upsertPrDescription({ github, context, reviewBlock }) {
  const pullNumber = context.payload.pull_request?.number || context.issue.number;
  const { data: pr } = await github.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: pullNumber,
  });

  let combined = upsertPrBody(pr.body || '', reviewBlock, { start: BODY_START, end: BODY_END });
  if (combined.length > PR_BODY_LIMIT) {
    const compactBlock = `${reviewBlock.slice(0, Math.max(0, PR_BODY_LIMIT - (pr.body || '').length - 200))}\n\n_Review truncated to fit the PR description._`;
    combined = upsertPrBody(pr.body || '', compactBlock, { start: BODY_START, end: BODY_END });
  }
  if (combined.length > PR_BODY_LIMIT) {
    combined = upsertPrBody('', reviewBlock.slice(0, PR_BODY_LIMIT - BODY_START.length - BODY_END.length - 20), {
      start: BODY_START,
      end: BODY_END,
    });
    console.log('PR description would exceed GitHub limit; wrote a truncated Inspector G block only');
  }

  await github.rest.pulls.update({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: pullNumber,
    body: combined,
  });
  console.log('Updated pull request description with Inspector G review');
}

async function postComment({ github, context }) {
  const review = fs.existsSync(PATHS.reviewTxt)
    ? fs.readFileSync(PATHS.reviewTxt, 'utf8')
    : '⚠️ Inspector G could not generate a review. Diff generation failed — check the Actions log.';

  const reviewContext = readJson(PATHS.reviewContext, {
    sticky_comment_id: null,
    previous: null,
    dismissals: [],
    keep_inline: [],
  });
  const parsedReview = fs.existsSync(PATHS.reviewJson) ? readJson(PATHS.reviewJson, null) : null;
  const previous = reviewContext.previous || null;
  const reviewSucceeded = Boolean(parsedReview);

  const payload = buildPayload({ parsedReview, reviewContext, context, reviewSucceeded });
  if (!reviewSucceeded) {
    console.log(
      `Review JSON missing; keeping previous checkpoint head_sha=${payload.head_sha || 'none'} and ${(payload.issues || []).length} issues`
    );
  }

  const runCount = payload.run_count || 1;
  const reviewBlock = buildVisibleBody(review, runCount);
  const checkpointBody = buildCommentBody({
    visibleBody: buildCheckpointVisible(runCount),
    payload,
    sourceIssues: reviewSucceeded ? parsedReview.issues : previous?.issues,
  });

  if (context.payload.pull_request || context.issue?.number) {
    try {
      await upsertPrDescription({ github, context, reviewBlock });
    } catch (err) {
      console.log(`Could not update PR description: ${err.message}`);
    }
  }

  await upsertCheckpointComment({ github, context, reviewContext, body: checkpointBody });

  if (!parsedReview) return;

  const keepInline = reviewContext.keep_inline || [];
  const keepIds = new Set(keepInline.map((item) => item.id).filter(Boolean));
  const mustFixIssues = selectMustFixIssues(parsedReview, reviewContext);

  const existingComments = await github.paginate(github.rest.pulls.listReviewComments, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.issue.number,
    per_page: 100,
  });

  for (const comment of existingComments) {
    if (!(comment.user?.type === 'Bot' && (comment.body || '').includes(INLINE_MARKER))) continue;
    if (keepIds.has(comment.id)) continue;
    const inlineId = (() => {
      const match = ISSUE_ID_RE.exec(comment.body || '');
      return match ? parseInt(match[1], 10) : null;
    })();
    if (inlineId != null && keepInline.some((item) => Number(item.issueId) === inlineId)) continue;
    try {
      await github.rest.pulls.deleteReviewComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        comment_id: comment.id,
      });
    } catch (err) {
      console.log(`Could not delete stale inline comment ${comment.id}: ${err.message}`);
    }
  }

  if (mustFixIssues.length === 0) return;

  const headSha = context.payload.pull_request.head.sha;

  for (const issue of mustFixIssues.slice(0, MAX_INLINE_COMMENTS)) {
    const lineInfo = parseLineRef(issue.line_reference);
    if (!lineInfo) continue;

    try {
      await github.rest.pulls.createReviewComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: context.issue.number,
        commit_id: headSha,
        path: issue.file,
        side: 'RIGHT',
        body: inlineCommentBody(issue),
        ...lineInfo,
      });
    } catch (err) {
      console.log(`Could not post inline comment on ${issue.file}:${issue.line_reference} — ${err.message}`);
    }
  }
}

module.exports = {
  postComment,
  buildVisibleBody,
  buildCheckpointVisible,
  buildCommentBody,
  buildPayload,
  selectMustFixIssues,
  inlineCommentBody,
  upsertPrBody,
};
