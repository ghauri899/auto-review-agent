'use strict';

const fs = require('node:fs');
const {
  DISMISS_RE,
  NUMBERED_DISMISS_RE,
  STICKY_MARKER,
  DISMISS_LABELS,
  DEFAULT_DISMISS_LABEL,
} = require('./constants');

function readJson(filePath, fallback) {
  try {
    if (filePath && fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse ${filePath}:`, err.message);
  }
  return fallback;
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titlesEqual(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  return Boolean(na) && na === nb;
}

function issueKey(file, title) {
  return `${String(file || '').toLowerCase()}::${String(title || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()}`;
}

function dismissalKey(item) {
  if (item?.id != null && Number.isFinite(Number(item.id))) return `id:${Number(item.id)}`;
  return issueKey(item?.file, item?.title);
}

function isDismissed(issue, dismissals) {
  return (dismissals || []).some((dismissal) => {
    if (issue?.id != null && dismissal?.id != null && Number(issue.id) === Number(dismissal.id)) {
      return true;
    }
    return (
      String(dismissal.file || '').toLowerCase() === String(issue.file || '').toLowerCase() &&
      titlesEqual(dismissal.title, issue.title)
    );
  });
}

// Every "N. <dismiss phrase> …" line in a comment. A single comment can
// dismiss several findings at once (1. false positive … 2. by design …).
function parseNumberedDismissals(body) {
  const text = String(body || '');
  const out = [];
  const seen = new Set();
  for (const match of text.matchAll(NUMBERED_DISMISS_RE)) {
    const id = parseInt(match[1], 10);
    const line = match[2];
    if (!Number.isFinite(id) || seen.has(id)) continue;
    if (!DISMISS_RE.test(line)) continue;
    seen.add(id);
    out.push({ id, reply: line.trim().slice(0, 500) });
  }
  return out;
}

function parseNumberedDismissal(body) {
  return parseNumberedDismissals(body)[0] || null;
}

function titleTokens(title) {
  return new Set(normalizeTitle(title).split(' ').filter((token) => token.length > 2));
}

// Jaccard overlap of title words. Used only to re-attach a previous id when
// Claude paraphrases a still-open finding; dismissals never use this.
function titleOverlap(a, b) {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function extractPayload(body) {
  const matches = [...String(body || '').matchAll(/<!-- inspector-g-data\s+([A-Za-z0-9+/=\s]+)\s*-->/g)];
  if (matches.length === 0) return null;
  const raw = matches[matches.length - 1][1].replace(/\s+/g, '');
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// Full form keeps enough text to re-render the review without calling
// Claude (same-commit re-runs that only apply dismissals).
function compactIssues(issues, includeDescription) {
  return (issues || []).map((issue) => {
    const compact = {
      id: issue.id ?? null,
      severity: issue.severity,
      category: issue.category,
      file: issue.file,
      line_reference: issue.line_reference || null,
      title: issue.title,
      status: issue.status || 'new',
    };
    if (includeDescription) {
      compact.description = String(issue.description || '').slice(0, 800);
      compact.fix = String(issue.fix || '').slice(0, 600);
      compact.failure_mode = issue.failure_mode ? String(issue.failure_mode).slice(0, 300) : null;
      // Valid for head_sha only. A same-commit re-run reuses them; a new
      // commit recomputes both from the fresh diff.
      compact.anchor = issue.anchor || null;
      compact.suggestion = issue.suggestion || null;
    }
    return compact;
  });
}

// "3. false positive, we validate at the gateway" -> the prose only. The
// leading number is bookkeeping, not part of the reviewer's reasoning.
function cleanDismissReason(reply) {
  return String(reply ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*(?:#\s*)?\d+\s*[.):]?\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function dismissLabel(reason) {
  for (const { label, re } of DISMISS_LABELS) {
    if (re.test(String(reason || ''))) return label;
  }
  return DEFAULT_DISMISS_LABEL;
}

function compactDismissed(dismissed) {
  return (dismissed || []).map((item) => ({
    id: item.id ?? null,
    title: item.title || '',
    file: item.file || '',
    severity: item.severity || '',
    label: item.label || dismissLabel(item.reason),
    reason: cleanDismissReason(item.reason),
    by: item.by || '',
  }));
}

// Best-known metadata (title, file, severity) for a dismissal, which may
// arrive as a bare "3. false positive" comment with no other detail.
function buildIssueLookup(sources) {
  const byId = new Map();
  const byKey = new Map();
  for (const list of sources) {
    for (const item of list || []) {
      if (!item) continue;
      const id = Number(item.id);
      if (Number.isFinite(id) && !byId.has(id)) byId.set(id, item);
      if (item.file && item.title) {
        const key = issueKey(item.file, item.title);
        if (!byKey.has(key)) byKey.set(key, item);
      }
    }
  }
  return { byId, byKey };
}

// Dismissed findings are dropped from the open list and Claude is told not to
// re-report them, so without this record they would vanish from the review.
// Carried forward in the checkpoint so the audit trail survives every re-run.
function collectDismissed({ previous = {}, dismissals = [], issues = [] } = {}) {
  const lookup = buildIssueLookup([issues, previous.issues, previous.resolved, previous.dismissed]);
  const out = new Map();

  for (const item of previous.dismissed || []) {
    out.set(dismissalKey(item), {
      id: item.id ?? null,
      title: item.title || '',
      file: item.file || '',
      severity: item.severity || '',
      label: item.label || dismissLabel(item.reason),
      reason: cleanDismissReason(item.reason),
      by: item.by || '',
    });
  }

  for (const dismissal of dismissals) {
    const known =
      (dismissal.id != null ? lookup.byId.get(Number(dismissal.id)) : null) ||
      lookup.byKey.get(issueKey(dismissal.file, dismissal.title)) ||
      {};
    const key = dismissalKey(dismissal);
    const existing = out.get(key) || {};
    const reason = cleanDismissReason(dismissal.reply) || existing.reason || '';
    out.set(key, {
      id: dismissal.id ?? known.id ?? existing.id ?? null,
      title: dismissal.title || known.title || existing.title || '',
      file: dismissal.file || known.file || existing.file || '',
      severity: known.severity || existing.severity || '',
      label: dismissLabel(reason),
      reason,
      by: dismissal.by || existing.by || '',
    });
  }

  return [...out.values()].sort((a, b) => (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER));
}

function compactResolved(resolved) {
  return (resolved || []).map((item) => ({
    id: item.id ?? null,
    title: item.title || '',
    file: item.file || '',
    severity: item.severity || '',
  }));
}

function parseLineRef(ref) {
  const match = /^L(\d+)(?:-L(\d+))?$/.exec(ref || '');
  if (!match) return null;
  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : start;
  return end > start ? { start_line: start, start_side: 'RIGHT', line: end } : { line: start };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nextIssueId(previous) {
  let nextId = 1;
  const considered = [
    ...(previous?.issues || []),
    ...(previous?.resolved || []),
    ...(previous?.dismissals || []),
    ...(previous?.dismissed || []),
  ];
  for (const item of considered) {
    const id = Number(item.id);
    if (Number.isFinite(id) && id >= nextId) nextId = id + 1;
  }
  const stored = Number(previous?.next_id);
  if (Number.isFinite(stored) && stored > nextId) nextId = stored;
  return nextId;
}

function assignIssueIds(issues, previous = {}, dismissals = [], options = {}) {
  const { carryForwardUnmentioned = true, prFiles = null } = options;
  const prevIssues = previous.issues || [];
  const resolved = [];
  const seenResolved = new Set();

  function addResolved(item) {
    if (item == null || item.id == null) return;
    const id = Number(item.id);
    if (!Number.isFinite(id) || seenResolved.has(id)) return;
    seenResolved.add(id);
    resolved.push({
      id,
      title: item.title || '',
      file: item.file || '',
      severity: item.severity || '',
    });
  }

  for (const item of previous.resolved || []) addResolved(item);
  for (const item of prevIssues) {
    if (item.status === 'resolved') addResolved(item);
  }

  let nextId = nextIssueId(previous);
  const used = new Set();
  const assigned = (issues || []).map((issue) => {
    let matchIdx = -1;
    if (issue.id != null) {
      matchIdx = prevIssues.findIndex((prev, idx) => !used.has(idx) && Number(prev.id) === Number(issue.id));
    }
    if (matchIdx < 0) {
      matchIdx = prevIssues.findIndex(
        (prev, idx) =>
          !used.has(idx) &&
          String(prev.file || '').toLowerCase() === String(issue.file || '').toLowerCase() &&
          titlesEqual(prev.title, issue.title)
      );
    }
    if (matchIdx < 0) {
      // Claude paraphrased the title: same file, mostly the same words.
      let best = -1;
      let bestScore = 0;
      for (const [idx, prev] of prevIssues.entries()) {
        if (used.has(idx)) continue;
        if (String(prev.file || '').toLowerCase() !== String(issue.file || '').toLowerCase()) continue;
        const score = titleOverlap(prev.title, issue.title);
        if (score >= 0.6 && score > bestScore) {
          best = idx;
          bestScore = score;
        }
      }
      matchIdx = best;
    }
    if (matchIdx >= 0) {
      used.add(matchIdx);
      const id = Number(prevIssues[matchIdx].id);
      const withId = { ...issue, id };
      if (withId.status === 'resolved') addResolved(withId);
      return withId;
    }
    const withId = { ...issue, id: nextId++ };
    if (withId.status === 'resolved') addResolved(withId);
    return withId;
  });

  // Claude not mentioning a previously open finding is not evidence that it
  // was fixed — the per-run cap on new findings, a truncated diff, or a
  // paraphrased title can all drop one from the response. Only an explicit
  // "resolved" closes a finding; anything unmentioned stays open.
  const carriedForward = [];
  for (const [idx, prev] of prevIssues.entries()) {
    if (used.has(idx)) continue;
    if (prev.status === 'resolved') continue;
    if (isDismissed(prev, dismissals)) continue;
    // Nothing was reviewed this run (empty diff), so there is no code left for
    // the finding to apply to and carrying it forward would strand it.
    if (!carryForwardUnmentioned) {
      addResolved(prev);
      continue;
    }
    // The PR no longer touches this file at all — the change was reverted or
    // dropped. prFiles comes from the *uncapped* diff, so a file omitted only
    // by the size cap is still carried forward rather than closed by accident.
    if (prFiles && prev.file && !prFiles.has(String(prev.file).toLowerCase())) {
      addResolved(prev);
      continue;
    }
    // Number(null) is 0, which is finite — guard before converting, or an
    // id-less checkpoint finding comes back numbered "0." and collides with
    // every other id-less one for dismissal.
    const id = prev.id == null || prev.id === '' ? null : Number(prev.id);
    carriedForward.push({
      ...prev,
      id: Number.isFinite(id) ? id : null,
      status: 'still_open',
      carried_forward: true,
    });
  }

  return {
    issues: [...assigned, ...carriedForward],
    resolved,
    next_id: nextId,
    carried_forward: carriedForward.length,
  };
}

function redactSecrets(text) {
  return String(text ?? '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, '[REDACTED TOKEN]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED ANTHROPIC KEY]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, '[REDACTED SLACK TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED JWT]')
    .replace(/(["']?(?:password|secret|api[_-]?key|token)["']?\s*[:=]\s*["']?)([^\s"'\\]{8,})/gi, '$1[REDACTED]');
}

// Append the review block to the bottom of the PR body. Whatever the author
// wrote stays on top, untouched. The separator lives inside the markers so it
// is replaced (not duplicated) on rerun.
function upsertPrBody(existingBody, reviewBlock, { start, end }) {
  const body = String(existingBody || '');
  const startAt = body.indexOf(start);
  const endAt = body.indexOf(end);

  let before = '';
  let after = '';
  if (startAt !== -1 && endAt !== -1 && endAt > startAt) {
    before = body.slice(0, startAt).replace(/\n+$/, '');
    after = body.slice(endAt + end.length).replace(/^\s+/, '');
  } else {
    after = body.replace(new RegExp(`${start}[\\s\\S]*?(?:${end})?`), '').replace(/^\s+/, '');
  }

  const authorText = [before, after].filter(Boolean).join('\n\n');
  const divider = authorText ? '---\n\n' : '';
  const block = `${start}\n${divider}${reviewBlock}\n${end}`;
  return authorText ? `${authorText}\n\n${block}` : block;
}

function isCheckpointComment(comment) {
  const body = comment?.body || '';
  if (!body.includes(STICKY_MARKER)) return false;
  const login = comment.user?.login || comment.author?.login || '';
  return Boolean(login && login.endsWith('[bot]'));
}

module.exports = {
  readJson,
  normalizeTitle,
  titlesEqual,
  titlesSimilar: titlesEqual,
  issueKey,
  dismissalKey,
  isDismissed,
  parseNumberedDismissal,
  parseNumberedDismissals,
  titleOverlap,
  encodePayload,
  extractPayload,
  compactIssues,
  compactResolved,
  cleanDismissReason,
  dismissLabel,
  compactDismissed,
  collectDismissed,
  parseLineRef,
  escapeHtml,
  nextIssueId,
  assignIssueIds,
  redactSecrets,
  upsertPrBody,
  isCheckpointComment,
};
