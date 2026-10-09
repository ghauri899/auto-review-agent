'use strict';

const STICKY_MARKER = '<!-- inspector-g-review -->';
const INLINE_MARKER = '<!-- claude-inline-review -->';
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
// Review quality is almost entirely model judgment, so Inspector G runs on
// the current Opus rather than the cheaper Sonnet tier.
const CLAUDE_MODEL = 'claude-opus-5-5';
const CLAUDE_MAX_TOKENS = 30_000;
const CLAUDE_FETCH_TIMEOUT_MS = 120_000;
const CLAUDE_RETRY_ATTEMPTS = 3;

const PATHS = {
  fullDiff: '/tmp/pr.diff',
  reviewContext: '/tmp/review-context.json',
  reviewTxt: '/tmp/review.txt',
  reviewJson: '/tmp/review.json',
};

module.exports = {
  STICKY_MARKER,
  INLINE_MARKER,
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
  CLAUDE_MODEL,
  CLAUDE_MAX_TOKENS,
  CLAUDE_FETCH_TIMEOUT_MS,
  CLAUDE_RETRY_ATTEMPTS,
  PATHS,
};
