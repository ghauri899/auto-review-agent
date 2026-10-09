'use strict';

const fs = require('node:fs');
const { MAX_DIFF_CHARS, PATHS } = require('./constants');
const { isDismissed, assignIssueIds, collectDismissed, redactSecrets } = require('./shared');
const { clampScore, deriveScore, deriveRiskLevel, appendScoreHistory } = require('./scoring');
const { assembleReviewDiff, diffFilePaths } = require('./assemble-diff');
const { SYSTEM_PROMPT, buildUserPrompt } = require('./prompts');
const { requestReview, extractReviewJson } = require('./claude-client');
const { formatReviewComment, rerunLink } = require('./format-comment');

function parsePrTitle(raw) {
  try {
    return raw ? JSON.parse(raw) : '';
  } catch {
    return raw || '';
  }
}

function loadReviewContext(env, readFile, exists) {
  let reviewContext = { previous: null, dismissals: [] };
  if (env.REVIEW_CONTEXT_PATH && exists(env.REVIEW_CONTEXT_PATH)) {
    try {
      reviewContext = JSON.parse(readFile(env.REVIEW_CONTEXT_PATH));
    } catch (err) {
      console.error(`Failed to parse ${env.REVIEW_CONTEXT_PATH}:`, err.message);
    }
  }
  return reviewContext;
}

function finalizeReview(
  review,
  { previous, dismissals, assembled, headSha = null, prFiles = null, carryForwardUnmentioned = true }
) {
  const assigned = assignIssueIds(
    (review.issues || []).map((issue) => ({
      ...issue,
      title: issue.title || 'Untitled issue',
      status: ['new', 'still_open', 'resolved'].includes(issue.status) ? issue.status : 'new',
    })),
    previous || {},
    dismissals,
    { carryForwardUnmentioned, prFiles }
  );

  const open = assigned.issues.filter((issue) => issue.status !== 'resolved');
  review.review_mode = assembled.mode;
  review.run_count = (previous?.run_count || 0) + 1;
  review.next_id = assigned.next_id;
  // A dismissal outranks "resolved" — it stays in the dismissed record only.
  review.resolved = assigned.resolved.filter((item) => !isDismissed(item, dismissals));
  review.issues = open.filter((issue) => !isDismissed(issue, dismissals));
  review.dismissed = collectDismissed({
    previous: previous || {},
    dismissals,
    issues: assigned.issues,
  });
  review.dismissed_count = open.length - review.issues.length;
  review.carried_forward_count = assigned.carried_forward || 0;

  // Score and risk come from the accumulated ledger, so they describe the
  // whole pull request rather than the diff this run happened to see. Claude's
  // own numbers are kept as model_* so a later re-run can recompute from the
  // same baseline once dismissals change the ledger.
  const modelScore = clampScore(review.model_score ?? review.score, 5);
  const modelBreakdown = review.model_breakdown || review.score_breakdown || null;
  const derived = deriveScore({ issues: review.issues, modelScore, modelBreakdown });
  review.model_score = modelScore;
  review.model_breakdown = modelBreakdown;
  review.score = derived.score;
  review.score_breakdown = derived.score_breakdown;
  review.ledger_score = derived.ledger_score;
  review.risk_level = deriveRiskLevel(review.issues);
  review.score_history = appendScoreHistory(previous?.score_history, {
    run: review.run_count,
    score: review.score,
    head_sha: headSha,
  });
  return review;
}

// Same commit as the last completed review: nothing new to analyse. Re-render
// from the checkpoint and apply any dismissals posted since, without Claude.
// Old checkpoints (no summary) fall through to a normal review.
function canReplayPrevious(previous, headSha) {
  return Boolean(
    previous &&
      headSha &&
      previous.head_sha === headSha &&
      previous.summary != null &&
      Array.isArray(previous.issues)
  );
}

function replayPrevious(previous, dismissals, headSha = null) {
  return finalizeReview(
    {
      summary: previous.summary,
      // The model baseline, not the previously published score — otherwise a
      // dismissal could never lift the badge back up on a re-run.
      model_score: previous.model_score ?? previous.score,
      model_breakdown: previous.model_breakdown || previous.score_breakdown || null,
      score_rationale: previous.score_rationale || '',
      issues: previous.issues.map((issue) => ({ ...issue, status: issue.status === 'new' ? 'still_open' : issue.status })),
    },
    { previous, dismissals, assembled: { mode: 'rerun' }, headSha }
  );
}

async function runReview({
  diffPath,
  env = process.env,
  writeFile = (file, data) => fs.writeFileSync(file, data),
  readFile = (file) => fs.readFileSync(file, 'utf8'),
  exists = (file) => fs.existsSync(file),
  fetchImpl = fetch,
} = {}) {
  const retryLink = rerunLink(env);
  const retryHint = retryLink ? ` [↻ Re-run this review](${retryLink}) → **Re-run all jobs**.` : '';
  const fullDiff = readFile(diffPath);
  const reviewContext = loadReviewContext(env, readFile, exists);
  const previous = reviewContext.previous || null;
  const dismissals = reviewContext.dismissals || [];

  if (canReplayPrevious(previous, env.HEAD_SHA)) {
    const review = replayPrevious(previous, dismissals, env.HEAD_SHA);
    writeFile(PATHS.reviewTxt, formatReviewComment(review, { env }));
    writeFile(PATHS.reviewJson, JSON.stringify(review));
    console.log(
      `Same commit as last review (${env.HEAD_SHA.slice(0, 7)}); replayed checkpoint, applied ${review.dismissed_count} dismissal(s), open issues: ${review.issues.length}`
    );
    return { kind: 'rerun', review };
  }

  if (!fullDiff.trim()) {
    const review = finalizeReview(
      {
        summary: { verdict: 'No changes to review', context: '' },
        model_score: previous?.model_score ?? previous?.score ?? 5,
        model_breakdown: previous?.model_breakdown || previous?.score_breakdown || null,
        issues: [],
      },
      // The PR has no diff left, so any finding from an earlier run no longer
      // has code to apply to. Carrying them forward here would publish
      // "No changes to review" above a CRITICAL card that nothing can ever
      // close — Claude is not called on this path.
      {
        previous,
        dismissals,
        assembled: { mode: 'full' },
        headSha: env.HEAD_SHA,
        carryForwardUnmentioned: false,
      }
    );
    writeFile(PATHS.reviewTxt, formatReviewComment(review, { env }));
    writeFile(PATHS.reviewJson, JSON.stringify(review));
    return { kind: 'empty', review };
  }

  const assembled = assembleReviewDiff({ fullDiff, maxChars: MAX_DIFF_CHARS });

  const prTitle = parsePrTitle(env.PR_TITLE);
  const userPrompt = redactSecrets(
    buildUserPrompt({
      prTitle,
      assembled,
      previous,
      dismissals,
      maxChars: MAX_DIFF_CHARS,
    })
  );

  const data = await requestReview({
    apiKey: env.ANTHROPIC_API_KEY,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    fetchImpl,
  });

  const extracted = extractReviewJson(data);

  if (extracted.kind === 'refusal') {
    writeFile(
      PATHS.reviewTxt,
      `⚠️ Claude declined to review this diff (safety classifier refusal). This is usually a false positive on security-adjacent code — re-run the workflow to retry.${retryHint}`
    );
    console.log('Claude refused the request (stop_reason: refusal). Wrote fallback message.');
    return extracted;
  }

  if (extracted.kind === 'max_tokens') {
    writeFile(
      PATHS.reviewTxt,
      `⚠️ The review was too long and got cut off before it finished (hit the token limit). This usually means the PR has many findings — try splitting it into smaller PRs, or re-run the workflow.${retryHint}`
    );
    console.log('Response truncated at max_tokens before JSON completed. Wrote fallback message.');
    return extracted;
  }

  const review = finalizeReview(extracted.review, {
    previous,
    dismissals,
    assembled,
    headSha: env.HEAD_SHA,
    prFiles: diffFilePaths(fullDiff),
  });
  writeFile(PATHS.reviewTxt, formatReviewComment(review, { env }));
  writeFile(PATHS.reviewJson, JSON.stringify(review));
  console.log(
    `Review written to ${PATHS.reviewTxt}. Mode: ${assembled.mode}, run #${review.run_count}, score: ${review.score}/5 ` +
      `(ledger ${review.ledger_score}/5, model ${review.model_score}/5), risk: ${review.risk_level}, ` +
      `open issues: ${(review.issues || []).length} (${review.carried_forward_count} carried forward)`
  );
  return { kind: 'ok', review };
}

async function main() {
  const diffPath = process.argv[2];
  if (!diffPath) {
    console.error('Usage: node review.js <diff-file-path>');
    process.exit(1);
  }

  try {
    await runReview({ diffPath });
  } catch (err) {
    // Catch-all: still write PR feedback. The action then posts and fails
    // the job if review.json is missing, so required checks cannot pass.
    console.error('Claude review failed with an unexpected error:');
    console.error(err.stack || err.message || String(err));
    fs.writeFileSync(
      PATHS.reviewTxt,
      `⚠️ The automated review could not be completed due to an unexpected error: ${err.message || String(err)}\n\nCheck the "Run Claude code review" step logs in the Actions run for full details.`
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runReview,
  parsePrTitle,
};
