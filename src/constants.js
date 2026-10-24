'use strict';

const STICKY_MARKER = '<!-- inspector-g-review -->';
const INLINE_MARKER = '<!-- claude-inline-review -->';
// On the bot's own replies in an inline thread ("Fixed in …"), so they are
// never mistaken for a reviewer's reply.
const REPLY_MARKER = '<!-- inspector-g-reply -->';
const BODY_START = '<!-- inspector-g:start -->';
const BODY_END = '<!-- inspector-g:end -->';
const ISSUE_ID_RE = /<!-- inspector-g-id:\s*(\d+)\s*-->/;
const DISMISS_RE =
  /\b(false\s*positive|won['\u2019]?t\s+fix|will\s+not\s+fix|wontfix|not\s+a\s+(bug|issue|problem)|not\s+applicable|by\s+design|not\s+relevant|ignore\s+(this|it)|dismiss(?:ed)?|no\s+fix\s+needed|not\s+fixing|expected\s+behavior|works?\s+as\s+intended)\b/i;
// One numbered item per line: "3. …", "3) …", "#3 …", "3: …"
const NUMBERED_DISMISS_RE = /^\s*(?:#\s*)?(\d+)\s*(?:[.):]|\s)\s*(.+)$/gm;

// How a dismissal gets labelled in the review. First match wins, so the
// more specific phrases come first.
const DISMISS_LABELS = [
  { label: 'False positive', re: /\bfalse\s*positive\b/i },
  { label: 'By design', re: /\b(by\s+design|expected\s+behavior|works?\s+as\s+intended)\b/i },
  { label: 'Not a bug', re: /\bnot\s+a\s+(bug|issue|problem)\b/i },
  { label: 'Not applicable', re: /\b(not\s+applicable|not\s+relevant)\b/i },
  { label: "Won't fix", re: /\b(won['\u2019]?t\s+fix|will\s+not\s+fix|wontfix|not\s+fixing|no\s+fix\s+needed)\b/i },
];
const DEFAULT_DISMISS_LABEL = 'Dismissed';

const MAX_DIFF_CHARS = 200_000;
const COMMENT_LIMIT = 65_000;
const PR_BODY_LIMIT = 65_536;
const MAX_INLINE_COMMENTS = 15;
// GitHub keeps at most 10 annotations of each level per step.
const MAX_ANNOTATIONS_PER_LEVEL = 10;
// Below this many changed files a flow diagram mostly restates the diff.
const MIN_DIAGRAM_FILES = 3;
// One mark per severity, used everywhere a finding appears: the description,
// inline comments and the job summary. A 🔴 always means CRITICAL.
const SEVERITY_EMOJI = { CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🔵' };
// Sonnet 5.5 costs half of Opus 5.5 per token. It runs at high effort to
// keep review depth close to Opus 5.5 at medium. To go back, set
// 'claude-opus-5-5' with effort 'medium'.
const CLAUDE_MODEL = 'claude-sonnet-5-5';
const REVIEW_EFFORT = 'high';
const CLAUDE_MAX_TOKENS = 30_000;
// The verification pass only confirms or rejects findings the review already
// wrote up, so it stays at a lower effort.
const VERIFY_MODEL = 'claude-sonnet-5-5';
const VERIFY_EFFORT = 'medium';
const VERIFY_MAX_TOKENS = 16_000;
// Retries a safety-classifier decline on the model Anthropic recommends for
// its category (a cyber decline on Sonnet 5.5 reruns on Sonnet 5), so a
// review of security code is not lost to a false positive.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Read-only context sent alongside the diff (src/repo-context.js).
const MAX_CONTEXT_FILE_CHARS = 40_000;
const MAX_CONTEXT_FILES_CHARS = 100_000;
const MAX_CONTEXT_USAGE_CHARS = 20_000;
const MAX_CONTEXT_SYMBOLS = 12;
const MAX_USAGES_PER_SYMBOL = 6;
// Team rules live in the reviewed repo, read from its base branch.
const RULES_FILE = '.github/inspector-g.md';
const MAX_RULES_CHARS = 8_000;
// Dismissals carried over from other pull requests in the same repo.
const MAX_LEARNED_DISMISSALS = 25;
// Only these commenters can teach Inspector G what to stop flagging.
const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const CLAUDE_FETCH_TIMEOUT_MS = 120_000;
const CLAUDE_RETRY_ATTEMPTS = 3;

const PATHS = {
  fullDiff: '/tmp/pr.diff',
  reviewContext: '/tmp/review-context.json',
  reviewTxt: '/tmp/review.txt',
  reviewJson: '/tmp/review.json',
  // How the run went and what it spent, written even when the review fails.
  runStats: '/tmp/review-run.json',
  // One record per run, uploaded as an artifact for reporting (src/record-event.js).
  event: '/tmp/inspector-g-event.json',
};

module.exports = {
  STICKY_MARKER,
  INLINE_MARKER,
  REPLY_MARKER,
  BODY_START,
  BODY_END,
  ISSUE_ID_RE,
  DISMISS_RE,
  NUMBERED_DISMISS_RE,
  DISMISS_LABELS,
  DEFAULT_DISMISS_LABEL,
  MAX_DIFF_CHARS,
  COMMENT_LIMIT,
  PR_BODY_LIMIT,
  MAX_INLINE_COMMENTS,
  MAX_ANNOTATIONS_PER_LEVEL,
  MIN_DIAGRAM_FILES,
  SEVERITY_EMOJI,
  CLAUDE_MODEL,
  REVIEW_EFFORT,
  CLAUDE_MAX_TOKENS,
  VERIFY_MODEL,
  VERIFY_EFFORT,
  VERIFY_MAX_TOKENS,
  FALLBACK_BETA,
  MAX_CONTEXT_FILE_CHARS,
  MAX_CONTEXT_FILES_CHARS,
  MAX_CONTEXT_USAGE_CHARS,
  MAX_CONTEXT_SYMBOLS,
  MAX_USAGES_PER_SYMBOL,
  RULES_FILE,
  MAX_RULES_CHARS,
  MAX_LEARNED_DISMISSALS,
  TRUSTED_ASSOCIATIONS,
  CLAUDE_FETCH_TIMEOUT_MS,
  CLAUDE_RETRY_ATTEMPTS,
  PATHS,
};
