'use strict';

const fs = require('node:fs');
const { PATHS } = require('./constants');
const { dismissLabel } = require('./shared');

// One record per Inspector G run, uploaded as a workflow artifact and later
// collected across repositories for reporting: who opened the pull request,
// who pushed, what the review found, what it cost. Bump EVENT_SCHEMA when a
// field changes meaning, so the collector can read old and new events side
// by side.
const EVENT_SCHEMA = 1;
const MAX_COMMITS = 100;
const BLOCKING = new Set(['CRITICAL', 'HIGH']);
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// Changed lines in the diff that was reviewed (lockfiles and generated trees
// already excluded, see scripts/diff-pathspecs.sh). GitHub's own counts
// include those, which would skew any per-line rate.
function diffStats(diff) {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('diff --git ')) files += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { files, additions, deletions };
}

function bySeverity(issues) {
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const issue of issues) if (issue.severity in counts) counts[issue.severity] += 1;
  return counts;
}

// Where a finding raised on this run came from:
//   first_review — the pull request's first review
//   this_push    — code changed since the previous review
//   late_catch   — code an earlier review saw and should have flagged
//   unknown      — a later run whose previous commit could not be compared
function originOf(issue, { runNumber, lateCatchCheck }) {
  if (issue.status !== 'new') return null;
  if (runNumber <= 1) return 'first_review';
  if (issue.late_catch) return 'late_catch';
  return lateCatchCheck ? 'this_push' : 'unknown';
}

function findingRecord(issue, origin) {
  return {
    id: issue.id ?? null,
    severity: issue.severity,
    category: issue.category,
    file: issue.file,
    status: issue.status,
    origin,
    carried_forward: Boolean(issue.carried_forward),
  };
}

function runKind(review, stats) {
  if (review?.review_mode === 'rerun') return 'replay';
  if (stats?.kind) return stats.kind;
  return review ? 'ok' : 'error';
}

// Commits this run covers: the ones pushed since the last run, or the whole
// pull request when it was just opened. Their authors are who wrote the code
// the review is judging, which may not be the pull request's author.
async function pushedCommits({ github, context }) {
  const payload = context.payload || {};
  const pr = payload.pull_request;
  if (!github || !pr) return null;
  try {
    let commits;
    if (payload.action === 'synchronize' && payload.before && payload.after) {
      const { data } = await github.rest.repos.compareCommitsWithBasehead({
        owner: context.repo.owner,
        repo: context.repo.repo,
        basehead: `${payload.before}...${payload.after}`,
      });
      commits = data.commits || [];
    } else {
      const { data } = await github.rest.pulls.listCommits({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: pr.number,
        per_page: MAX_COMMITS,
      });
      commits = data || [];
    }
    const authors = [...new Set(commits.map((commit) => commit.author?.login || commit.commit?.author?.email).filter(Boolean))];
    return { count: commits.length, authors };
  } catch (err) {
    console.log(`Could not list the commits for this run: ${err.message}`);
    return null;
  }
}

function buildRunEvent({ context, env = process.env, review, stats, reviewContext, diff, commits = null, now = new Date() }) {
  const payload = context.payload || {};
  const pr = payload.pull_request || {};
  const previous = reviewContext?.previous || null;
  const runNumber = review?.run_count ?? (previous?.run_count || 0) + 1;
  const lateCatchCheck = Boolean(stats?.late_catch_check);

  const open = review?.issues || [];
  const findings = [
    ...open.map((issue) => findingRecord(issue, originOf(issue, { runNumber, lateCatchCheck }))),
    ...(review?.resolved || []).map((issue) => findingRecord({ ...issue, status: 'resolved' }, null)),
  ];
  const raised = open.filter((issue) => issue.status === 'new');
  const blockingOpen = open.filter((issue) => BLOCKING.has(issue.severity)).length;
  const kind = runKind(review, stats);
  // Findings open before this run; one now in the resolved list was fixed by
  // the push being reviewed.
  const previousOpenIds = new Set((previous?.issues || []).filter((issue) => issue.id != null).map((issue) => Number(issue.id)));

  return {
    schema: EVENT_SCHEMA,
    event: 'review_run',
    recorded_at: now.toISOString(),
    repo: `${context.repo.owner}/${context.repo.repo}`,
    pr: {
      number: pr.number ?? context.issue?.number ?? null,
      title: pr.title ?? null,
      author: pr.user?.login ?? null,
      url: pr.html_url ?? null,
      base_ref: pr.base?.ref ?? null,
      head_ref: pr.head?.ref ?? null,
      draft: Boolean(pr.draft),
      created_at: pr.created_at ?? null,
    },
    trigger: {
      action: payload.action ?? null,
      actor: payload.sender?.login ?? context.actor ?? null,
      head_sha: pr.head?.sha ?? null,
      previous_sha: previous?.head_sha ?? null,
      workflow_run_id: env.GITHUB_RUN_ID ?? null,
      workflow_run_attempt: env.GITHUB_RUN_ATTEMPT ?? null,
    },
    commits,
    run: {
      number: runNumber,
      kind,
      late_catch_check: lateCatchCheck,
    },
    diff: diffStats(diff),
    outcome: review
      ? {
          score: review.score ?? null,
          model_score: review.model_score ?? null,
          risk_level: review.risk_level ?? null,
          blocking_open: blockingOpen,
          open: open.length,
          ready_to_merge: blockingOpen === 0,
        }
      : null,
    counts: review
      ? {
          raised: bySeverity(raised),
          open: bySeverity(open),
          raised_late_catch: raised.filter((issue) => issue.late_catch).length,
          still_open: open.filter((issue) => issue.status === 'still_open').length,
          carried_forward: review.carried_forward_count || 0,
          resolved_this_run: (review.resolved || []).filter((item) => previousOpenIds.has(Number(item.id))).length,
          resolved_total: (review.resolved || []).length,
          dismissed_total: (review.dismissed || []).length,
          filtered: review.filtered || null,
        }
      : null,
    findings,
    dismissals: (reviewContext?.dismissals || []).map((item) => ({
      issue_id: item.id ?? null,
      label: dismissLabel(item.reply || item.reason),
      by: item.by || null,
    })),
    usage: stats?.usage || [],
  };
}

function usageSummary(usage) {
  if (!usage.length) return '';
  let md = '### Inspector G usage\n\n| Call | Model | Input tokens | Output tokens | Cache read | Cache write |\n|---|---|---:|---:|---:|---:|\n';
  for (const call of usage) {
    md += `| ${call.call} | ${call.model} | ${call.input_tokens} | ${call.output_tokens} | ${call.cache_read_input_tokens} | ${call.cache_creation_input_tokens} |\n`;
  }
  return md;
}

// Never fails the job: tracking is a side channel, and a review that
// completed must not be marked failed because its record could not be kept.
async function recordEvent({ github, context, core = null, env = process.env }) {
  try {
    const event = buildRunEvent({
      context,
      env,
      review: readJson(PATHS.reviewJson, null),
      stats: readJson(PATHS.runStats, null),
      reviewContext: readJson(PATHS.reviewContext, null),
      diff: readText(PATHS.fullDiff),
      commits: await pushedCommits({ github, context }),
    });
    fs.writeFileSync(PATHS.event, JSON.stringify(event, null, 2));
    console.log(
      `Recorded run #${event.run.number} (${event.run.kind}) for ${event.repo}#${event.pr.number}: ` +
        `${event.findings.length} finding record(s), ${event.usage.length} API call(s)`
    );
    const summary = usageSummary(event.usage);
    if (core && summary) await core.summary.addRaw(summary).write();
    return event;
  } catch (err) {
    console.log(`Could not record the run event: ${err.message}`);
    return null;
  }
}

module.exports = {
  EVENT_SCHEMA,
  buildRunEvent,
  diffStats,
  originOf,
  pushedCommits,
  recordEvent,
  usageSummary,
};
