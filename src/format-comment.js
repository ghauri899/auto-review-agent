'use strict';

const { escapeHtml, dismissLabel } = require('./shared');
const { countBySeverity, openIssues } = require('./scoring');

function shieldEscape(s) {
  return String(s).replace(/-/g, '--').replace(/_/g, '__').replace(/ /g, '_');
}

function badge(label, message, color) {
  const l = encodeURIComponent(shieldEscape(label));
  const m = encodeURIComponent(shieldEscape(message));
  return `![${label}: ${message}](https://img.shields.io/badge/${l}-${m}-${color}?style=for-the-badge&labelColor=1a1a2e)`;
}

function scoreColor(score) {
  if (score >= 4.5) return '2ea043';
  if (score >= 3.5) return '57ab5a';
  if (score >= 2.5) return 'e3b341';
  if (score >= 1.5) return 'e0823d';
  return 'da3633';
}

const RISK_COLOR = { CRITICAL: 'da3633', HIGH: 'e0823d', MEDIUM: 'e3b341', LOW: '2ea043' };
const RISK_EMOJI = { CRITICAL: '🚨', HIGH: '🔴', MEDIUM: '🟡', LOW: '🟢' };

function progressBar(score, max = 5, width = 10) {
  const filled = Math.round((score / max) * width);
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, width - filled));
}

function severityMeta(severity) {
  return (
    {
      CRITICAL: { emoji: '🔴', label: 'CRITICAL' },
      HIGH: { emoji: '🟠', label: 'HIGH' },
      MEDIUM: { emoji: '🟡', label: 'MEDIUM' },
      LOW: { emoji: '🔵', label: 'LOW' },
    }[severity] || { emoji: '⚪', label: severity || 'UNKNOWN' }
  );
}

function normalizeSummary(summary) {
  if (!summary) return { verdict: 'N/A', context: '' };
  if (typeof summary === 'object') {
    return {
      verdict: String(summary.verdict || summary.headline || 'N/A').trim(),
      context: String(summary.context || '').trim(),
    };
  }
  const text = String(summary).trim();
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  return {
    verdict: sentences[0] || 'N/A',
    context: sentences.slice(1).join(' '),
  };
}

function formatSummaryBlock(summary, riskEmoji) {
  const { verdict, context } = normalizeSummary(summary);
  let md = `> **${riskEmoji} ${escapeHtml(verdict)}**\n`;
  if (context) md += `>\n> ${escapeHtml(context)}\n`;
  return `${md}\n`;
}

// A stray "|" or newline would tear the markdown table apart.
function tableCell(value) {
  return escapeHtml(value).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

// The badge is computed from every finding the PR still has open, across all
// runs — not from the latest diff. Spell that out, otherwise a score that does
// not move after a clean push reads as a bug.
function scoreBasisNote(review) {
  const open = openIssues(review.issues);
  const counts = countBySeverity(open);
  const parts = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
    .filter((severity) => counts[severity] > 0)
    .map((severity) => `${counts[severity]} ${severity}`);
  const runs = review.run_count || 1;
  const basis =
    open.length === 0
      ? `No findings open after ${runs} run${runs === 1 ? '' : 's'}.`
      : `${open.length} finding${open.length === 1 ? '' : 's'} still open after ${runs} run${runs === 1 ? '' : 's'} — ${parts.join(' · ')}.`;

  const history = review.score_history || [];
  const prior = history.length > 1 ? history[history.length - 2] : null;
  const trend = prior && prior.score !== review.score ? ` Previous run: ${prior.score}/5.` : '';

  return `<sub>Scored on the whole pull request, not just the newest commits. ${escapeHtml(basis)}${escapeHtml(trend)}</sub>`;
}

function issueNumber(issue) {
  return issue.id != null ? `${issue.id}. ` : '';
}

function issueCard(issue, { open }) {
  const { emoji } = severityMeta(issue.severity);
  const location = issue.line_reference ? `${issue.file}:${issue.line_reference}` : issue.file;
  const statusNote = issue.carried_forward
    ? ' · carried forward'
    : issue.status === 'still_open'
      ? ' · still open'
      : issue.status === 'new'
        ? ' · new'
        : '';
  const title = issue.title || 'Untitled issue';
  let card = `<details${open ? ' open' : ''}>\n`;
  card += `<summary>${emoji} <b>${escapeHtml(issueNumber(issue) + title)}</b> &nbsp;<sub><code>${escapeHtml(location || '')}</code>${statusNote}</sub></summary>\n\n`;
  card += `&nbsp;\n\n`;
  card += `<table>\n`;
  card += `<tr><td><b>Severity</b></td><td>${escapeHtml(issue.severity)}</td></tr>\n`;
  card += `<tr><td><b>Category</b></td><td>${escapeHtml(issue.category)}</td></tr>\n`;
  if (issue.id != null) card += `<tr><td><b>ID</b></td><td>${escapeHtml(String(issue.id))}</td></tr>\n`;
  if (issue.status) card += `<tr><td><b>Status</b></td><td>${escapeHtml(issue.status)}</td></tr>\n`;
  if (issue.failure_mode) card += `<tr><td><b>Failure mode</b></td><td>${escapeHtml(issue.failure_mode)}</td></tr>\n`;
  card += `</table>\n`;
  // Detail is dropped from the checkpoint when it outgrows GitHub's comment
  // size limit, and a carried-forward finding is rebuilt from that checkpoint.
  // Say so rather than rendering an empty "What's wrong".
  const description = String(issue.description || '').trim();
  const fix = String(issue.fix || '').trim();
  if (description) card += `\n**What's wrong**\n\n${escapeHtml(description)}\n\n`;
  // Leading newline matters: with no description this follows </table>
  // directly, and GitHub would treat the ** as literal text inside the
  // HTML block instead of bold.
  if (fix) card += `\n**Suggested fix**\n\n${escapeHtml(fix)}\n\n`;
  if (!description && !fix) {
    card += `\n<sub>Detail for this finding was dropped to keep the checkpoint within GitHub's size limit. See review #1 for the original write-up, or dismiss it if it no longer applies.</sub>\n\n`;
  }
  if (issue.carried_forward) {
    card += `<sub>Not re-examined this run — the latest diff did not cover this code. It stays open until a review marks it resolved or a reviewer dismisses it.</sub>\n\n`;
  }
  card += `</details>\n\n`;
  return card;
}

// URL of the Actions run that produced this review. Every step gets these
// defaults, including inside the composite action, and a reusable workflow
// shares the caller's run id — so this points at the run a reviewer actually
// sees on the PR. Re-running keeps the same id, so the link never goes stale.
function rerunLink(env = process.env) {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId } = env;
  if (!server || !repo || !runId) return '';
  return `${server}/${repo}/actions/runs/${runId}`;
}

// GitHub has no URL that re-runs a job directly (it is a CSRF-protected POST),
// so the link lands on the run page and the reviewer presses "Re-run all jobs"
// there. That replays the checkpoint against the current comments: same head
// SHA means dismissals are applied without calling Claude again.
function rerunFooter(env = process.env) {
  const url = rerunLink(env);
  if (!url) return '';
  return `\n\n---\n\n<sub>Dismissed a finding above? [↻ Re-run this review](${url}) → **Re-run all jobs** applies it now. Otherwise it applies on your next push.</sub>`;
}

function formatReviewComment(review, { env = process.env } = {}) {
  const issues = review.issues || [];
  const openIssues = issues.filter((issue) => issue.status !== 'resolved');
  const resolved =
    review.resolved?.length > 0 ? review.resolved : issues.filter((issue) => issue.status === 'resolved');
  const mustFix = openIssues.filter((issue) => issue.severity === 'CRITICAL' || issue.severity === 'HIGH');
  const advisory = openIssues.filter((issue) => issue.severity === 'MEDIUM' || issue.severity === 'LOW');
  const breakdown = review.score_breakdown || {};
  const riskEmoji = RISK_EMOJI[review.risk_level] || '⚪';
  const riskColor = RISK_COLOR[review.risk_level] || '8b949e';
  const runCount = review.run_count || 1;

  const scoreBadge = badge('Quality Score', `${review.score}/5`, scoreColor(review.score));
  const riskBadge = badge('Risk', review.risk_level || 'N/A', riskColor);
  const runBadge = badge('Review', `#${runCount}`, '6e7681');

  let md = `<div align="center">\n\n${scoreBadge} ${riskBadge} ${runBadge}\n\n</div>\n\n`;

  md += formatSummaryBlock(review.summary, riskEmoji);
  if (review.review_mode === 'rerun') {
    const applied = review.dismissed_count || 0;
    md += `> _Re-run on the same commit — applied ${applied} dismissal${applied === 1 ? '' : 's'}; no new analysis was needed._\n\n`;
  }

  md += `<details open>\n<summary><b>📊 Score Breakdown</b></summary>\n\n&nbsp;\n\n`;
  md += `| Dimension | | Score |\n|:--|:--|:--:|\n`;
  const dims = [
    ['🔒 Security', breakdown.security],
    ['✔️ Correctness', breakdown.correctness],
    ['⚡ Performance', breakdown.performance],
    ['🔧 Maintainability', breakdown.maintainability],
    ['📐 Best Practices', breakdown.best_practices],
  ];
  for (const [label, value] of dims) {
    const bar = value == null ? '—' : `\`${progressBar(value)}\``;
    md += `| ${label} | ${bar} | ${value ?? 'N/A'}/5 |\n`;
  }
  md += `\n`;
  md += `${scoreBasisNote(review)}\n\n`;
  if (review.score_rationale) md += `*${escapeHtml(review.score_rationale)}*\n\n`;
  md += `</details>\n\n---\n\n`;

  if (mustFix.length > 0) {
    md += `### 🚫 Must-Fix Issues (${mustFix.length})\n\n`;
    for (const issue of mustFix) md += issueCard(issue, { open: true });
  } else {
    md += `### ✅ No Must-Fix Issues\n\nNo CRITICAL or HIGH severity issues found.\n\n`;
  }

  if (advisory.length > 0) {
    md += `### 🔵 Advisory Issues (${advisory.length}, non-blocking)\n\n`;
    for (const issue of advisory) md += issueCard(issue, { open: false });
  }

  const dismissed = review.dismissed || [];
  if (dismissed.length > 0) {
    md += `<details>\n<summary><b>🚫 Marked not an issue by a reviewer (${dismissed.length})</b></summary>\n\n`;
    md += `<sub>Dismissed by a reviewer, not fixed. Kept on the record so every call stays auditable.</sub>\n\n`;
    md += `| # | Finding | Verdict | Reason given | By |\n|:--|:--|:--|:--|:--|\n`;
    for (const item of dismissed) {
      const id = item.id != null ? String(item.id) : '—';
      const title = tableCell(item.title || 'Untitled issue');
      const file = item.file ? ` <sub><code>${tableCell(item.file)}</code></sub>` : '';
      const label = tableCell(item.label || dismissLabel(item.reason));
      const reason = item.reason ? tableCell(item.reason) : '_no reason given_';
      const by = item.by ? `@${tableCell(item.by)}` : '—';
      md += `| ${id} | ~~${title}~~${file} | **${label}** | ${reason} | ${by} |\n`;
    }
    md += `\n</details>\n\n`;
  }

  if (resolved.length > 0) {
    md += `<details>\n<summary><b>✅ Previously resolved (${resolved.length})</b></summary>\n\n`;
    for (const issue of resolved) {
      const label = issueNumber(issue) + (issue.title || 'Untitled issue');
      md += `- ~~${escapeHtml(label)}~~ <sub><code>${escapeHtml(issue.file || '')}</code></sub>\n`;
    }
    md += `\n</details>\n\n`;
  }

  return `${md.trim()}${rerunFooter(env)}`;
}

module.exports = {
  shieldEscape,
  badge,
  scoreColor,
  progressBar,
  normalizeSummary,
  formatSummaryBlock,
  scoreBasisNote,
  formatReviewComment,
  rerunLink,
  rerunFooter,
};
