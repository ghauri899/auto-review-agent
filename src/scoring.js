'use strict';

// The published score and risk badge are derived here from the accumulated
// open-issue ledger rather than taken from the model's own numbers. Claude
// rates the code in front of it; a finding it raised on an earlier run and
// has not re-reported still counts against the pull request. Publishing the
// model's number directly is what made the badge swing to 4.8/5 after a
// one-line push on a PR with open CRITICALs.

const SEVERITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const RISK_BY_RANK = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

// What one open finding costs the 0-5 score. One HIGH costs a full point;
// two CRITICALs bottom the score out at 1.0.
const SEVERITY_PENALTY = { CRITICAL: 2, HIGH: 1, MEDIUM: 0.4, LOW: 0.15 };

const DIMENSIONS = ['security', 'correctness', 'performance', 'maintainability', 'best_practices'];

// Which dimension of the breakdown a finding's category weighs on.
const CATEGORY_DIMENSION = {
  SECURITY: 'security',
  BUG: 'correctness',
  DATA_INTEGRITY: 'correctness',
  PERFORMANCE: 'performance',
  BREAKING_CHANGE: 'maintainability',
  MAINTAINABILITY: 'maintainability',
  BEST_PRACTICE: 'best_practices',
};

const MAX_SCORE_HISTORY = 20;

function severityOf(issue) {
  return String(issue?.severity || '').toUpperCase();
}

function categoryOf(issue) {
  return String(issue?.category || '').toUpperCase();
}

function openIssues(issues) {
  return (issues || []).filter((issue) => issue && issue.status !== 'resolved');
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function clampScore(value, fallback = 5) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(5, Math.max(0, number));
}

// Max severity over the open ledger. Claude used to be asked for this, which
// let "Risk: LOW" render directly above two open CRITICALs carried forward
// from an earlier run.
function deriveRiskLevel(issues) {
  let rank = -1;
  for (const issue of openIssues(issues)) {
    const value = SEVERITY_RANK[severityOf(issue)];
    if (value != null && value > rank) rank = value;
  }
  return rank < 0 ? 'LOW' : RISK_BY_RANK[rank];
}

function penaltyFor(issues) {
  let total = 0;
  for (const issue of issues) total += SEVERITY_PENALTY[severityOf(issue)] ?? 0;
  return total;
}

function countBySeverity(issues) {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const issue of openIssues(issues)) {
    const severity = severityOf(issue);
    if (counts[severity] != null) counts[severity] += 1;
  }
  return counts;
}

// Published score = the lower of what the ledger allows and what Claude
// thought of the code it actually read. Taking the minimum keeps the badge
// consistent with the findings listed under it on every run.
//
// Claude's number only counts where a finding backs it: overall once anything
// is open, per dimension once a finding in that dimension is open. A 4.5/5
// with nothing listed under it told the author something was wrong without
// saying what — and a deduction whose finding the verifier dropped would do
// the same.
function deriveScore({ issues, modelScore, modelBreakdown } = {}) {
  const open = openIssues(issues);
  const ledgerScore = round1(clampScore(5 - penaltyFor(open), 0));
  const backedModelScore = open.length ? clampScore(modelScore, 5) : 5;
  const score = round1(Math.min(ledgerScore, backedModelScore));

  const breakdown = {};
  for (const dimension of DIMENSIONS) {
    const forDimension = open.filter((issue) => CATEGORY_DIMENSION[categoryOf(issue)] === dimension);
    const ledgerDimension = clampScore(5 - penaltyFor(forDimension), 0);
    const modelDimension =
      forDimension.length && modelBreakdown && modelBreakdown[dimension] != null
        ? clampScore(modelBreakdown[dimension], 5)
        : 5;
    breakdown[dimension] = round1(Math.min(ledgerDimension, modelDimension));
  }

  return { score, score_breakdown: breakdown, ledger_score: ledgerScore };
}

// One entry per run so the review can show a trend, and so a same-commit
// re-run recomputes instead of freezing the previous number.
function appendScoreHistory(previousHistory, entry) {
  const history = (Array.isArray(previousHistory) ? previousHistory : []).filter(
    (item) => item && Number.isFinite(Number(item.score)) && Number.isFinite(Number(item.run))
  );
  const run = Number(entry?.run) || 1;
  const next = history
    .filter((item) => Number(item.run) !== run)
    .map((item) => ({ run: Number(item.run), score: round1(Number(item.score)), head_sha: item.head_sha || null }));
  next.push({
    run,
    score: round1(clampScore(entry?.score, 0)),
    head_sha: entry?.head_sha ? String(entry.head_sha).slice(0, 40) : null,
  });
  next.sort((a, b) => a.run - b.run);
  return next.slice(-MAX_SCORE_HISTORY);
}

module.exports = {
  SEVERITY_PENALTY,
  CATEGORY_DIMENSION,
  DIMENSIONS,
  MAX_SCORE_HISTORY,
  clampScore,
  round1,
  openIssues,
  countBySeverity,
  deriveRiskLevel,
  deriveScore,
  appendScoreHistory,
};
