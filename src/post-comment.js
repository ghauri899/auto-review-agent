'use strict';

const fs = require('node:fs');
const {
  STICKY_MARKER,
  INLINE_MARKER,
  REPLY_MARKER,
  BODY_START,
  BODY_END,
  COMMENT_LIMIT,
  PR_BODY_LIMIT,
  MAX_INLINE_COMMENTS,
  MAX_ANNOTATIONS_PER_LEVEL,
  SEVERITY_EMOJI,
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
const { fenceFor, formatReviewComment, findingLines, jobSummary } = require('./format-comment');

function buildVisibleBody(review, runCount = 1) {
  return [
    '🕵️ **Inspector G** · Automated Code Review',
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
    delete payload.walkthrough;
    delete payload.diagram;
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

const INLINE_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM'];
const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

// Where an issue's inline comment goes. review.js validates an anchor against
// the current diff; a checkpoint written before that existed only has the
// line_reference to go on.
function inlineAnchor(issue) {
  if (issue.anchor !== undefined) return issue.anchor;
  const legacy = parseLineRef(issue.line_reference);
  return legacy ? { line: legacy.line, ...(legacy.start_line ? { start_line: legacy.start_line } : {}) } : null;
}

// Findings that get a comment on their line: everything open down to MEDIUM.
// LOW stays in the description only — a line comment is an interruption, and
// a nitpick is not worth one. Most severe first, so the cap drops the least
// important.
function selectInlineIssues(parsedReview, reviewContext) {
  const keepInline = reviewContext.keep_inline || [];
  const dismissed = reviewContext.dismissals || [];

  return (parsedReview.issues || [])
    .filter((issue) => {
      if (issue.status === 'resolved') return false;
      if (!INLINE_SEVERITIES.includes(issue.severity)) return false;
      if (!issue.file || !issue.line_reference) return false;
      // Carried forward from an earlier run without being re-examined, so its
      // line_reference belongs to an older commit. Inline comments are anchored
      // to the new head SHA, where that line is unrelated code — or does not
      // exist and the API 422s. It still shows in the description.
      if (issue.carried_forward) return false;
      if (!inlineAnchor(issue)) return false;
      if (isDismissed(issue, dismissed)) return false;
      if (keepInline.some((item) => issueCovered(item, issue))) return false;
      return true;
    })
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))
    .slice(0, MAX_INLINE_COMMENTS);
}

function inlineCommentBody(issue) {
  const sevEmoji = SEVERITY_EMOJI[issue.severity] || '⚪';
  const idLabel = issue.id != null ? `${issue.id}. ` : '';
  const bodyLines = [`${sevEmoji} **${issue.severity}: ${idLabel}${issue.title}**`, ''];
  if (issue.id != null) bodyLines.push(`<!-- inspector-g-id: ${issue.id} -->`, '');
  if (issue.failure_mode) bodyLines.push(`**Failure mode:** ${issue.failure_mode}`, '');
  else if (issue.description) bodyLines.push(String(issue.description), '');
  bodyLines.push(`**Fix:** ${issue.fix}`, '');
  if (issue.suggestion?.code != null) {
    // GitHub turns this block into a "Commit suggestion" button that replaces
    // exactly the lines this comment spans.
    const fence = fenceFor(issue.suggestion.code);
    bodyLines.push(`${fence}suggestion`, issue.suggestion.code, fence, '');
  }
  const reply = issue.id != null ? `\`${issue.id}. false positive because …\`` : '`false positive because …`';
  bodyLines.push(`<sub>Not a real problem? Reply ${reply}</sub>`, '', INLINE_MARKER);
  return bodyLines.join('\n');
}

function reviewCommentPayload(issue) {
  const anchor = inlineAnchor(issue);
  return {
    path: issue.file,
    body: inlineCommentBody(issue),
    side: 'RIGHT',
    line: anchor.line,
    ...(anchor.start_line ? { start_line: anchor.start_line, start_side: 'RIGHT' } : {}),
  };
}

// An existing bot comment that already says exactly what this run would post,
// in the same place. Leaving it alone means a push that changes nothing about
// a finding does not delete and re-post its comment (and re-notify everyone).
function sameInlineComment(existing, payload) {
  return (
    existing.path === payload.path &&
    existing.line === payload.line &&
    (existing.start_line ?? null) === (payload.start_line ?? null) &&
    (existing.body || '') === payload.body
  );
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
    walkthrough: source.walkthrough ?? null,
    diagram: source.diagram ?? null,
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

function inlineIdOf(comment) {
  const match = ISSUE_ID_RE.exec(comment.body || '');
  return match ? parseInt(match[1], 10) : null;
}

function isBotInlineComment(comment) {
  return comment.user?.type === 'Bot' && (comment.body || '').includes(INLINE_MARKER);
}

// The reply that closes a finding's thread, by finding id. Resolved and
// dismissed findings both close; the thread and its discussion stay, where
// deleting the comment used to throw the discussion away.
function closingNotes(parsedReview, headSha) {
  const notes = new Map();
  const sha = String(headSha || '').slice(0, 7);
  for (const item of parsedReview.resolved || []) {
    if (item?.id == null) continue;
    notes.set(
      Number(item.id),
      `✅ **Resolved** — as of \`${sha}\`, Inspector G no longer finds this problem.\n\n${REPLY_MARKER}`
    );
  }
  for (const item of parsedReview.dismissed || []) {
    if (item?.id == null) continue;
    const who = item.by ? ` by @${item.by}` : '';
    const label = item.label ? ` as *${item.label}*` : '';
    notes.set(
      Number(item.id),
      `☑️ **Closed** — marked${label}${who}. It stays on the record in the review.\n\n${REPLY_MARKER}`
    );
  }
  return notes;
}

// Inline threads keyed by their first comment, with whether they are already
// resolved and whether Inspector G already replied. null when GitHub would
// not list them: without that, closing a thread could repeat its reply on
// every run, so threads are left alone instead.
async function listInlineThreads(github, context) {
  const threads = new Map();
  let cursor = null;
  let hasNext = true;
  try {
    while (hasNext) {
      const data = await github.graphql(
        `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 50, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  isResolved
                  comments(first: 50) { nodes { databaseId body } }
                }
              }
            }
          }
        }`,
        { owner: context.repo.owner, repo: context.repo.repo, number: context.issue.number, cursor }
      );
      const connection = data.repository?.pullRequest?.reviewThreads;
      for (const thread of connection?.nodes || []) {
        const comments = thread.comments?.nodes || [];
        if (comments.length === 0) continue;
        threads.set(comments[0].databaseId, {
          id: thread.id,
          isResolved: Boolean(thread.isResolved),
          replied: comments.some((comment) => (comment.body || '').includes(REPLY_MARKER)),
        });
      }
      hasNext = Boolean(connection?.pageInfo?.hasNextPage);
      cursor = connection?.pageInfo?.endCursor || null;
    }
  } catch (err) {
    console.log(`Could not list review threads; leaving closed findings' threads as they are: ${err.message}`);
    return null;
  }
  return threads;
}

async function closeThread({ github, context, comment, thread, body }) {
  if (!thread || thread.isResolved) return;
  if (!thread.replied) {
    try {
      await github.rest.pulls.createReplyForReviewComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: context.issue.number,
        comment_id: comment.id,
        body,
      });
    } catch (err) {
      console.log(`Could not reply to inline comment ${comment.id}: ${err.message}`);
      return;
    }
  }
  try {
    await github.graphql(
      `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }`,
      { id: thread.id }
    );
  } catch (err) {
    console.log(`Could not resolve thread for inline comment ${comment.id}: ${err.message}`);
  }
}

// Finding id → URL of its inline comment, for every finding still open. The
// description links each one there instead of repeating its write-up.
function threadUrls(comments, openIds) {
  const urls = new Map();
  for (const comment of comments) {
    if (!isBotInlineComment(comment) || !comment.html_url) continue;
    const id = inlineIdOf(comment);
    if (id == null || !openIds.has(id)) continue;
    urls.set(id, comment.html_url);
  }
  return urls;
}

async function syncInlineComments({ github, context, parsedReview, reviewContext }) {
  const headSha = context.payload.pull_request.head.sha;
  const keepInline = reviewContext.keep_inline || [];
  const keepIds = new Set(keepInline.map((item) => item.id).filter(Boolean));
  const wanted = selectInlineIssues(parsedReview, reviewContext).map(reviewCommentPayload);
  const listComments = () =>
    github.paginate(github.rest.pulls.listReviewComments, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.issue.number,
      per_page: 100,
    });

  const existingComments = await listComments();
  const closings = closingNotes(parsedReview, headSha);
  const threads = closings.size > 0 ? await listInlineThreads(github, context) : new Map();

  const alreadyPosted = new Set();
  for (const comment of existingComments) {
    if (!isBotInlineComment(comment)) continue;
    const inlineId = inlineIdOf(comment);
    const closing = inlineId != null ? closings.get(inlineId) : null;
    if (closing) {
      if (threads) await closeThread({ github, context, comment, thread: threads.get(comment.id), body: closing });
      continue;
    }
    if (keepIds.has(comment.id)) continue;
    if (inlineId != null && keepInline.some((item) => Number(item.issueId) === inlineId)) continue;
    const unchanged = wanted.findIndex((payload, index) => !alreadyPosted.has(index) && sameInlineComment(comment, payload));
    if (unchanged >= 0) {
      alreadyPosted.add(unchanged);
      continue;
    }
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

  const openIds = new Set(
    (parsedReview.issues || []).filter((issue) => issue.status !== 'resolved' && issue.id != null).map((issue) => Number(issue.id))
  );
  const toPost = wanted.filter((_, index) => !alreadyPosted.has(index));
  if (toPost.length === 0) return threadUrls(existingComments, openIds);

  await postInlineComments({ github, context, headSha, toPost, kept: alreadyPosted.size });
  return threadUrls(await listComments(), openIds);
}

async function postInlineComments({ github, context, headSha, toPost, kept }) {
  // One review carrying every comment: one notification instead of one per
  // finding. Anchors were checked against the diff, but if GitHub still
  // rejects the batch, fall back to posting them one at a time so a single
  // bad anchor cannot cost the rest.
  try {
    await github.rest.pulls.createReview({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.issue.number,
      commit_id: headSha,
      event: 'COMMENT',
      body: `🕵️ **Inspector G** — line-by-line notes for \`${String(headSha).slice(0, 7)}\`. The full review is in the pull request description.`,
      comments: toPost,
    });
    console.log(`Posted ${toPost.length} inline comment(s) in one review; kept ${kept} unchanged`);
    return;
  } catch (err) {
    console.log(`Batched inline review failed (${err.message}); posting comments individually`);
  }

  for (const payload of toPost) {
    try {
      await github.rest.pulls.createReviewComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: context.issue.number,
        commit_id: headSha,
        ...payload,
      });
    } catch (err) {
      console.log(`Could not post inline comment on ${payload.path}:${payload.line} — ${err.message}`);
    }
  }
}

const ANNOTATION_LEVEL = { CRITICAL: 'error', HIGH: 'error', MEDIUM: 'warning', LOW: 'notice' };

// Annotations for open findings that have no inline comment (LOW, past the
// inline cap, or on a line GitHub cannot comment on). They show in the
// Checks tab and, where the line is in the diff, in Files changed. A finding
// that already has an inline comment would just be shown twice.
function annotationsFor(review, threads) {
  const used = { error: 0, warning: 0, notice: 0 };
  const annotations = [];
  const open = (review.issues || [])
    .filter((issue) => issue.status !== 'resolved' && issue.file)
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
  for (const issue of open) {
    if (issue.id != null && threads?.has(Number(issue.id))) continue;
    const level = ANNOTATION_LEVEL[issue.severity] || 'notice';
    if (used[level] >= MAX_ANNOTATIONS_PER_LEVEL) continue;
    used[level] += 1;
    const lines = findingLines(issue);
    const number = issue.id != null ? `${issue.id}. ` : '';
    annotations.push({
      level,
      message: String(issue.failure_mode || issue.description || issue.fix || issue.title || '').trim(),
      properties: {
        title: `Inspector G · ${number}${issue.title || 'Untitled issue'}`,
        file: issue.file,
        ...(lines ? { startLine: lines.start, endLine: lines.end } : {}),
      },
    });
  }
  return annotations;
}

async function publishRunSummary({ core, review, threads, env, headSha }) {
  if (!core) return;
  try {
    for (const { level, message, properties } of annotationsFor(review, threads)) core[level](message, properties);
    await core.summary.addRaw(jobSummary(review, { env, headSha, threads })).write();
  } catch (err) {
    console.log(`Could not write the job summary: ${err.message}`);
  }
}

async function postComment({ github, context, core = null, env = process.env }) {
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
  const checkpointBody = buildCommentBody({
    visibleBody: buildCheckpointVisible(runCount),
    payload,
    sourceIssues: reviewSucceeded ? parsedReview.issues : previous?.issues,
  });

  await upsertCheckpointComment({ github, context, reviewContext, body: checkpointBody });

  // Inline comments go first: the description links each finding to its
  // comment, and those URLs only exist once the comments do.
  let threads = new Map();
  if (parsedReview && context.payload.pull_request) {
    try {
      threads = await syncInlineComments({ github, context, parsedReview, reviewContext });
    } catch (err) {
      console.log(`Could not update inline comments: ${err.message}`);
    }
  }

  const headSha = context.payload.pull_request?.head?.sha;
  let reviewText = review;
  if (parsedReview) {
    try {
      reviewText = formatReviewComment(parsedReview, { env, headSha, threads });
    } catch (err) {
      console.log(`Could not re-render the review with thread links; using review.txt: ${err.message}`);
    }
  }

  if (context.payload.pull_request || context.issue?.number) {
    try {
      await upsertPrDescription({ github, context, reviewBlock: buildVisibleBody(reviewText, runCount) });
    } catch (err) {
      console.log(`Could not update PR description: ${err.message}`);
    }
  }

  if (parsedReview) await publishRunSummary({ core, review: parsedReview, threads, env, headSha });
}

module.exports = {
  postComment,
  buildVisibleBody,
  buildCheckpointVisible,
  buildCommentBody,
  buildPayload,
  selectInlineIssues,
  // Old name, kept for callers that still import it.
  selectMustFixIssues: selectInlineIssues,
  inlineCommentBody,
  reviewCommentPayload,
  sameInlineComment,
  closingNotes,
  threadUrls,
  syncInlineComments,
  annotationsFor,
  publishRunSummary,
  upsertPrBody,
};
