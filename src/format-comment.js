'use strict';

const { escapeHtml, dismissLabel, parseLineRef } = require('./shared');
const { countBySeverity, openIssues } = require('./scoring');
const { SEVERITY_EMOJI, MIN_DIAGRAM_FILES } = require('./constants');

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
// Same marks as the severities, so a 🔴 means CRITICAL wherever it appears.
const RISK_EMOJI = { CRITICAL: SEVERITY_EMOJI.CRITICAL, HIGH: SEVERITY_EMOJI.HIGH, MEDIUM: SEVERITY_EMOJI.MEDIUM, LOW: '🟢' };

function progressBar(score, max = 5, width = 10) {
  const filled = Math.round((score / max) * width);
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, width - filled));
}

function severityMeta(severity) {
  return SEVERITY_EMOJI[severity]
    ? { emoji: SEVERITY_EMOJI[severity], label: severity }
    : { emoji: '⚪', label: severity || 'UNKNOWN' };
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

// Findings Claude raised but Inspector G held back before publishing. Shown
// as a count, never as content: the point is that what IS listed was checked,
// and that nothing below blames this PR for code it did not change.
function screeningNote(filtered) {
  if (!filtered) return '';
  const outOfScope = filtered.out_of_scope || 0;
  const notConfirmed = filtered.not_confirmed || 0;
  const total = outOfScope + notConfirmed;
  if (total === 0) return '';
  const parts = [];
  if (outOfScope > 0) parts.push(`${outOfScope} in code this pull request did not change`);
  if (notConfirmed > 0) parts.push(`${notConfirmed} that a second check could not confirm`);
  return `<sub>🛡️ ${total} possible finding${total === 1 ? ' was' : 's were'} double-checked and left out: ${parts.join(', ')}.</sub>`;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// The first thing anyone reads, technical or not: can this merge, and if not,
// how much stands in the way. Everything below it is the evidence.
function verdictHeadline(openList) {
  const blockers = openList.filter((issue) => issue.severity === 'CRITICAL' || issue.severity === 'HIGH').length;
  const advisory = openList.length - blockers;
  if (blockers > 0) {
    const extra = advisory > 0 ? ` · ${plural(advisory, 'suggestion')}` : '';
    return `## 🚫 Not ready to merge — ${plural(blockers, 'blocker')}${extra}`;
  }
  if (advisory > 0) return `## ✅ Ready to merge · ${plural(advisory, 'suggestion')}`;
  return `## ✅ Ready to merge · no issues found`;
}

// "#1 1.5 → #2 3.9 → #3 4.6" — progress across pushes, so the author sees
// their fixes move the number. Hidden until there is a second run to compare.
function scoreTimeline(history, max = 8) {
  const runs = (history || []).filter((item) => Number.isFinite(Number(item?.score)) && item?.run != null);
  if (runs.length < 2) return '';
  const shown = runs.slice(-max);
  const steps = shown.map((item, index) => {
    const step = `#${item.run} ${Number(item.score).toFixed(1)}`;
    return index === shown.length - 1 ? `<b>${step}</b>` : step;
  });
  const first = Number(shown[0].score);
  const last = Number(shown[shown.length - 1].score);
  const trend = last > first ? ' 📈' : last < first ? ' 📉' : '';
  const earlier = runs.length > shown.length ? '… → ' : '';
  return `<sub>Score by review: ${earlier}${steps.join(' → ')}${trend}</sub>`;
}

// GitHub's coloured alert boxes. CAUTION (red) when anything CRITICAL is open,
// WARNING (amber) for HIGH only. Must sit at the top level of the markdown.
function mustFixAlert(mustFix, threads = null) {
  if (mustFix.length === 0) return '';
  const critical = mustFix.some((issue) => issue.severity === 'CRITICAL');
  const kind = critical ? 'CAUTION' : 'WARNING';
  const what = mustFix.length === 1 ? 'This issue needs' : `These ${mustFix.length} issues need`;
  const where = mustFix.some((issue) => threadFor(issue, threads))
    ? 'Open **details & fix** to see what breaks and how to fix it'
    : 'Each one says what breaks and how to fix it';
  const oneClick = mustFix.some((issue) => issue.suggestion)
    ? ' — **Commit suggestion** on the inline comment applies a fix in one click'
    : '';
  return `> [!${kind}]
> **${what} fixing before this merges.** ${where}${oneClick}.

`;
}

function walkthroughBlock(walkthrough) {
  const overview = String(walkthrough?.overview || '').trim();
  const files = (walkthrough?.files || []).filter((item) => item?.file && item?.change).slice(0, 15);
  if (!overview && files.length === 0) return '';
  let md = `<details>\n<summary><b>🧭 What this pull request does</b></summary>\n\n`;
  if (overview) md += `${escapeHtml(overview)}\n\n`;
  if (files.length > 0) {
    md += `| File | Change |\n|:--|:--|\n`;
    for (const item of files) md += `| <code>${tableCell(item.file)}</code> | ${tableCell(item.change)} |\n`;
    md += `\n`;
  }
  return `${md}</details>\n\n`;
}

const MERMAID_START_RE = /^(sequenceDiagram|flowchart\s+(TD|TB|BT|LR|RL)|graph\s+(TD|TB|BT|LR|RL))\b/;
const MAX_DIAGRAM_LINES = 40;

// GitHub renders an invalid Mermaid block as a red error box, which is worse
// than no diagram. Accept only the two diagram kinds the prompt asks for, at a
// sane size, with nothing that can close the fence or reach outside it.
function sanitizeMermaid(source) {
  const text = String(source || '')
    .replace(/^\s*```(?:mermaid)?\s*\n?/, '')
    .replace(/\n?\s*```\s*$/, '')
    .trim();
  if (!text || !MERMAID_START_RE.test(text)) return '';
  const lines = text.split('\n');
  if (lines.length > MAX_DIAGRAM_LINES) return '';
  if (/```|<script|%%\{|^\s*(click|style|classDef|linkStyle)\b/im.test(text)) return '';
  return text;
}

function diagramBlock(diagram, walkthrough = null) {
  // A flow across one or two files is already plain from the walkthrough.
  // Without a walkthrough (older checkpoints) there is nothing to count.
  if (walkthrough && (walkthrough.files || []).length < MIN_DIAGRAM_FILES) return '';
  const clean = sanitizeMermaid(diagram);
  if (!clean) return '';
  return `<details>\n<summary><b>🗺️ How the change flows</b></summary>\n\n\`\`\`mermaid\n${clean}\n\`\`\`\n\n</details>\n\n`;
}

// A fence one backtick longer than any run inside the code, so suggested code
// containing backticks cannot close it early.
function fenceFor(code) {
  const longest = Math.max(0, ...(String(code).match(/`+/g) || []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function languageOf(file) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(file || ''));
  return match ? match[1].toLowerCase() : '';
}

function suggestionBlock(issue) {
  if (!issue.suggestion?.code) return '';
  const where = `${issue.file}:${issue.suggestion.line_reference}`;
  const fence = fenceFor(issue.suggestion.code);
  return `\n**One-click fix** — replaces <code>${escapeHtml(where)}</code>. Apply it with **Commit suggestion** on the inline comment.\n\n${fence}${languageOf(issue.file)}\n${issue.suggestion.code}\n${fence}\n\n`;
}

// Lines a finding cites in the reviewed commit. A carried-forward finding's
// line_reference belongs to an older commit, so it has none.
function findingLines(issue) {
  if (issue.carried_forward) return null;
  const ref = parseLineRef(issue.line_reference);
  if (!ref) return null;
  return { start: ref.start_line || ref.line, end: ref.line };
}

function linkContext(env = process.env, headSha = env.HEAD_SHA) {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo } = env;
  return server && repo && headSha ? { server, repo, headSha } : null;
}

// A permalink to the cited lines at the reviewed commit. Pinned to the SHA,
// so it still points at the right code after later pushes move things.
function findingUrl(issue, links) {
  if (!links || !issue.file) return '';
  const path = String(issue.file).split('/').map(encodeURIComponent).join('/');
  const base = `${links.server}/${links.repo}/blob/${links.headSha}/${path}`;
  const lines = findingLines(issue);
  if (!lines) return base;
  return lines.end > lines.start ? `${base}#L${lines.start}-L${lines.end}` : `${base}#L${lines.start}`;
}

function locationHtml(issue, links) {
  const location = issue.line_reference && !issue.carried_forward ? `${issue.file}:${issue.line_reference}` : issue.file;
  const code = `<code>${escapeHtml(location || '')}</code>`;
  const url = findingUrl(issue, links);
  return url ? `<a href="${escapeHtml(url)}">${code}</a>` : code;
}

function truncate(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

// One line for a finding whose full write-up lives in its inline comment.
// Repeating the card here is what made the description twice as long as it
// needed to be.
function findingRow(issue, { threadUrl, links }) {
  const { emoji } = severityMeta(issue.severity);
  const title = escapeHtml(issueNumber(issue) + (issue.title || 'Untitled issue'));
  const parts = [`${emoji} <b>${title}</b>`, locationHtml(issue, links)];
  if (issue.status === 'new') parts.push('new');
  if (issue.suggestion?.code) parts.push('✨ one-click fix');
  parts.push(`<a href="${escapeHtml(threadUrl)}">💬 details &amp; fix</a>`);
  let row = `- ${parts.join(' · ')}`;
  const what = truncate(issue.failure_mode || issue.description, 220);
  if (what) row += `<br><sub>${escapeHtml(what)}</sub>`;
  return `${row}\n`;
}

// Findings with an inline thread collapse to a row; the rest (LOW, past the
// inline cap, or cited on a line GitHub cannot comment on) keep their card,
// since the description is the only place their detail appears.
function findingList(issues, { threads, links, open }) {
  const rows = issues.filter((issue) => threadFor(issue, threads));
  const cards = issues.filter((issue) => !threadFor(issue, threads));
  let md = '';
  for (const issue of rows) md += findingRow(issue, { threadUrl: threadFor(issue, threads), links });
  if (rows.length > 0) md += '\n';
  for (const issue of cards) md += issueCard(issue, { open, links });
  return md;
}

function threadFor(issue, threads) {
  if (!threads || issue.id == null) return '';
  return threads.get(Number(issue.id)) || '';
}

function issueNumber(issue) {
  return issue.id != null ? `${issue.id}. ` : '';
}

function issueCard(issue, { open, links = null }) {
  const { emoji } = severityMeta(issue.severity);
  const statusNote = issue.carried_forward
    ? ' · carried forward'
    : issue.status === 'still_open'
      ? ' · still open'
      : issue.status === 'new'
        ? ' · new'
        : '';
  const title = issue.title || 'Untitled issue';
  let card = `<details${open ? ' open' : ''}>\n`;
  card += `<summary>${emoji} <b>${escapeHtml(issueNumber(issue) + title)}</b> &nbsp;<sub>${locationHtml(issue, links)}${statusNote}</sub></summary>\n\n`;
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
  card += suggestionBlock(issue);
  if (!description && !fix) {
    card += `\n<sub>Detail for this finding was dropped to keep the checkpoint within GitHub's size limit. See review #1 for the original write-up, or dismiss it if it no longer applies.</sub>\n\n`;
  }
  if (issue.carried_forward) {
    card += `<sub>The latest review did not give this finding a verdict. The whole pull request was re-read, so silence is not evidence it was fixed — it stays open until a review marks it resolved or a reviewer dismisses it.</sub>\n\n`;
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

// `threads` maps a finding id to the URL of its inline comment. Only the
// posting step knows it (the comments are posted after review.js runs), so it
// re-renders with it; without it every finding gets a full card.
function formatReviewComment(review, { env = process.env, headSha = env.HEAD_SHA, threads = null } = {}) {
  const links = linkContext(env, headSha);
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

  let md = `${verdictHeadline(openIssues)}\n\n`;
  md += `<div align="center">\n\n${scoreBadge} ${riskBadge} ${runBadge}\n\n</div>\n\n`;
  const timeline = scoreTimeline(review.score_history);
  if (timeline) md += `<div align="center">${timeline}</div>\n\n`;

  md += formatSummaryBlock(review.summary, riskEmoji);
  const filteredNote = screeningNote(review.filtered);
  if (filteredNote) md += `${filteredNote}\n\n`;
  if (review.review_mode === 'rerun') {
    const applied = review.dismissed_count || 0;
    md += `> _Re-run on the same commit — applied ${applied} dismissal${applied === 1 ? '' : 's'}; no new analysis was needed._\n\n`;
  }

  md += walkthroughBlock(review.walkthrough);
  md += diagramBlock(review.diagram, review.walkthrough);
  md += `---\n\n`;

  if (mustFix.length > 0) {
    md += `### 🚫 Must-Fix Issues (${mustFix.length})\n\n`;
    md += mustFixAlert(mustFix, threads);
    md += findingList(mustFix, { threads, links, open: true });
  } else {
    md += `### ✅ No Must-Fix Issues\n\n> [!TIP]\n> No CRITICAL or HIGH severity issues found.\n\n`;
  }

  if (advisory.length > 0) {
    md += `### 💡 Advisory Issues (${advisory.length}, non-blocking)\n\n`;
    md += findingList(advisory, { threads, links, open: false });
  }

  // Collapsed: the headline and badges already carry the verdict. The table
  // is for whoever wants to know where the number came from.
  md += `<details>\n<summary><b>📊 Score Breakdown</b></summary>\n\n&nbsp;\n\n`;
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
  md += `</details>\n\n`;

  const dismissed = review.dismissed || [];
  if (dismissed.length > 0) {
    md += `<details>\n<summary><b>🙅 Marked not an issue by a reviewer (${dismissed.length})</b></summary>\n\n`;
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

// The Actions job summary: the verdict and every open finding in one table,
// for whoever lands on the run page instead of the pull request.
function jobSummary(review, { env = process.env, headSha = env.HEAD_SHA, threads = null } = {}) {
  const links = linkContext(env, headSha);
  const open = (review.issues || []).filter((issue) => issue.status !== 'resolved');
  let md = `${verdictHeadline(open)}\n\n`;
  md += `**Score** ${review.score ?? 'N/A'}/5 · **Risk** ${review.risk_level || 'N/A'} · **Review** #${review.run_count || 1}\n\n`;
  if (open.length > 0) {
    md += `| | Finding | Where | |\n|:--|:--|:--|:--|\n`;
    for (const issue of open) {
      const { emoji } = severityMeta(issue.severity);
      const title = tableCell(issueNumber(issue) + (issue.title || 'Untitled issue'));
      const thread = threadFor(issue, threads);
      md += `| ${emoji} | ${title} | ${locationHtml(issue, links)} | ${thread ? `<a href="${escapeHtml(thread)}">💬</a>` : ''} |\n`;
    }
    md += '\n';
  }
  md += `<sub>The full review is in the pull request description.</sub>\n`;
  return md;
}

module.exports = {
  shieldEscape,
  badge,
  scoreColor,
  progressBar,
  normalizeSummary,
  formatSummaryBlock,
  scoreBasisNote,
  screeningNote,
  verdictHeadline,
  scoreTimeline,
  mustFixAlert,
  walkthroughBlock,
  sanitizeMermaid,
  diagramBlock,
  fenceFor,
  suggestionBlock,
  formatReviewComment,
  findingLines,
  findingUrl,
  findingRow,
  jobSummary,
  rerunLink,
  rerunFooter,
};
