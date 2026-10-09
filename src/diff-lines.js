'use strict';

const { parseDiffFiles } = require('./assemble-diff');

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
// How far a cited line may sit from a changed line and still count as the
// PR's code. Absorbs off-by-one citations without letting in findings about
// code the PR never went near.
const SCOPE_SLACK_LINES = 2;

function pad(value, width = 5) {
  return String(value).padStart(width, ' ');
}

// Prefix every hunk line with its line number in the new file. Claude cites
// lines it can read off the page instead of counting from hunk headers, so a
// finding's line_reference lands on the code it describes — which is what the
// PR-scope check and inline comments both anchor to. Removed lines have no
// new-file number and get a blank gutter.
function annotateDiff(diff) {
  const out = [];
  let inHunk = false;
  let newLine = 0;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      out.push(line);
      continue;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      inHunk = true;
      newLine = parseInt(hunk[1], 10);
      out.push(line);
      continue;
    }
    if (!inHunk || line === '') {
      out.push(line);
      continue;
    }
    const marker = line[0];
    if (marker === '+') {
      out.push(`${pad(newLine)} ${line}`);
      newLine += 1;
    } else if (marker === ' ') {
      out.push(`${pad(newLine)} ${line}`);
      newLine += 1;
    } else if (marker === '-') {
      out.push(`${pad('')} ${line}`);
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

// For every file in the PR: which new-file lines it added, and where it
// deleted code. Keys are lower-cased paths, matching diffFilePaths().
function changedLineMap(diff) {
  const map = new Map();
  for (const file of parseDiffFiles(diff)) {
    const entry = {
      path: file.path,
      status: 'modified',
      added: new Set(),
      deletedAt: new Set(),
      // New-file line -> hunk index, for every line GitHub shows on the right
      // side of the diff (added and context). Only these accept a comment.
      hunkOf: new Map(),
      hunks: false,
    };
    let hunkIndex = -1;
    if (/^new file mode/m.test(file.text)) entry.status = 'added';
    if (/^deleted file mode/m.test(file.text)) entry.status = 'deleted';
    let inHunk = false;
    let newLine = 0;
    for (const line of file.text.split('\n')) {
      const hunk = HUNK_RE.exec(line);
      if (hunk) {
        inHunk = true;
        entry.hunks = true;
        hunkIndex += 1;
        newLine = parseInt(hunk[1], 10);
        continue;
      }
      if (!inHunk || line === '') continue;
      if (line[0] === '+') {
        entry.added.add(newLine);
        entry.hunkOf.set(newLine, hunkIndex);
        newLine += 1;
      } else if (line[0] === ' ') {
        entry.hunkOf.set(newLine, hunkIndex);
        newLine += 1;
      } else if (line[0] === '-') {
        // A deletion has no new-file line. Anchor it to the lines either side,
        // so "this removed check left X unguarded" can cite where it was.
        entry.deletedAt.add(newLine);
        entry.deletedAt.add(newLine - 1);
      }
    }
    const path = String(file.path || '').toLowerCase();
    if (path) map.set(path, entry);
  }
  return map;
}

// "L42", "L42-L55", "L42-55", "42" -> { start, end }. Lenient on purpose:
// the check below should judge where a finding points, not how it was typed.
function parseLineRange(ref) {
  const match = /^\s*L?(\d+)(?:\s*[-–]\s*L?(\d+))?\s*$/i.exec(String(ref ?? ''));
  if (!match) return null;
  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : start;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

// Inspector G reports only what the pull request itself introduces. A new
// finding must point at a file the PR touches, on or next to a line it added
// or deleted. Pre-existing problems in untouched code are out of scope, even
// when Claude spots them in the surrounding context.
//
// Files the diff does not describe line by line (binary, mode-only, or a
// deleted file) cannot be checked, so they pass rather than lose a finding.
function checkPrScope(issue, lineMap, slack = SCOPE_SLACK_LINES) {
  const entry = lineMap.get(String(issue?.file || '').toLowerCase());
  if (!entry) return { inScope: false, reason: 'file_not_in_pr' };
  if (entry.status === 'deleted' || !entry.hunks) return { inScope: true };

  const range = parseLineRange(issue.line_reference);
  if (!range) {
    // Every line of a new file is the PR's code; elsewhere a finding has to
    // say which changed line it is about.
    return entry.status === 'added' ? { inScope: true } : { inScope: false, reason: 'no_line_reference' };
  }
  for (let line = range.start - slack; line <= range.end + slack; line += 1) {
    if (entry.added.has(line) || entry.deletedAt.has(line)) return { inScope: true };
  }
  return { inScope: false, reason: 'unchanged_code' };
}

const MAX_SUGGESTION_LINES = 30;
const MAX_SUGGESTION_CHARS = 4_000;

// The lines of one hunk, all visible on the right side of the diff, and at
// least one of them changed by this PR. GitHub rejects a comment anchored
// anywhere else (422), and a batched review fails whole if one comment does.
function anchorableRange(file, range, lineMap) {
  const entry = lineMap.get(String(file || '').toLowerCase());
  if (!entry || !range) return null;
  const hunk = entry.hunkOf.get(range.start);
  if (hunk == null) return null;
  let touchesChange = false;
  for (let line = range.start; line <= range.end; line += 1) {
    if (entry.hunkOf.get(line) !== hunk) return null;
    if (entry.added.has(line)) touchesChange = true;
  }
  return touchesChange ? range : null;
}

function toAnchor(range) {
  return range.end > range.start ? { start_line: range.start, line: range.end } : { line: range.start };
}

// Where the inline comment for a finding goes, or null if it cannot be placed
// on the current diff. A one-click suggestion replaces exactly the lines the
// comment spans, so when one is valid the comment anchors to its range.
function inlinePlacement(issue, lineMap) {
  const suggestion = issue?.suggestion;
  if (suggestion?.code != null) {
    const code = String(suggestion.code).replace(/\n+$/, '');
    const range = anchorableRange(issue.file, parseLineRange(suggestion.line_reference), lineMap);
    const lineCount = range ? range.end - range.start + 1 : 0;
    if (range && lineCount <= MAX_SUGGESTION_LINES && code.length <= MAX_SUGGESTION_CHARS) {
      return { anchor: toAnchor(range), suggestion: { line_reference: suggestion.line_reference, code } };
    }
  }
  const cited = parseLineRange(issue.line_reference);
  if (!cited) return { anchor: null, suggestion: null };
  const whole = cited.end - cited.start < MAX_SUGGESTION_LINES ? anchorableRange(issue.file, cited, lineMap) : null;
  if (whole) return { anchor: toAnchor(whole), suggestion: null };
  // A region spanning hunks, or too long to highlight: pin the comment to the
  // first line in it that this PR changed.
  for (let line = cited.start; line <= cited.end; line += 1) {
    const single = anchorableRange(issue.file, { start: line, end: line }, lineMap);
    if (single) return { anchor: toAnchor(single), suggestion: null };
  }
  return { anchor: null, suggestion: null };
}

module.exports = {
  inlinePlacement,
  SCOPE_SLACK_LINES,
  annotateDiff,
  changedLineMap,
  parseLineRange,
  checkPrScope,
};
