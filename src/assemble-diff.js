'use strict';

const { MAX_DIFF_CHARS } = require('./constants');

function splitDiffGitPaths(line) {
  const rest = line.slice('diff --git '.length);
  const parts = [];
  let i = 0;
  while (i < rest.length) {
    while (rest[i] === ' ') i += 1;
    if (i >= rest.length) break;
    if (rest[i] === '"') {
      let value = '';
      i += 1;
      while (i < rest.length) {
        if (rest[i] === '\\' && i + 1 < rest.length) {
          value += rest[i + 1];
          i += 2;
          continue;
        }
        if (rest[i] === '"') {
          i += 1;
          break;
        }
        value += rest[i];
        i += 1;
      }
      parts.push(value);
    } else {
      const start = i;
      while (i < rest.length && rest[i] !== ' ') i += 1;
      parts.push(rest.slice(start, i));
    }
  }
  return parts;
}

function unescapeGitPath(raw) {
  return String(raw || '').replace(/^[ab]\//, '');
}

function parseDiffFiles(diff) {
  const files = [];
  let current = null;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) files.push(current);
      const paths = splitDiffGitPaths(line);
      current = { path: unescapeGitPath(paths[1] || paths[0] || ''), text: line + '\n' };
    } else if (current) {
      current.text += line + '\n';
    }
  }
  if (current) files.push(current);
  return files;
}

// Every file the PR touches, from the uncapped diff. Used to close findings
// whose file is no longer part of the PR; reading the capped text instead
// would close findings merely omitted for size.
function diffFilePaths(diff) {
  const paths = new Set();
  for (const file of parseDiffFiles(diff)) {
    const path = String(file.path || '').toLowerCase();
    if (path) paths.add(path);
  }
  return paths;
}

function capDiffText(text, maxChars) {
  if (text.length <= maxChars) {
    return { text, truncated: false, omitted: [] };
  }

  const files = parseDiffFiles(text);
  if (files.length === 0) {
    return { text: text.slice(0, maxChars), truncated: true, omitted: [] };
  }

  let out = '';
  const omitted = [];
  for (const file of files) {
    if (out.length + file.text.length > maxChars) {
      omitted.push(file.path || '(unknown)');
      continue;
    }
    out += file.text;
  }

  if (!out) {
    out = files[0].text.slice(0, Math.max(0, maxChars - 80));
    omitted.length = 0;
    omitted.push(...files.slice(1).map((file) => file.path || '(unknown)'));
  }

  if (omitted.length > 0) {
    const listed = omitted.slice(0, 40).join(', ');
    const extra = omitted.length > 40 ? ` (+${omitted.length - 40} more)` : '';
    out += `\n\n# Omitted ${omitted.length} file(s) over the size cap: ${listed}${extra}\n`;
  }

  return { text: out, truncated: true, omitted };
}

// Inspector G always reviews the complete PR diff, never just the newest
// commits. Scanning only the latest push is cheaper, but it cannot see a
// regression in a file that an earlier commit in the same PR touched and
// this push did not — the finding is simply never looked for. Correctness of
// the review outranks token spend here, so every run re-reads the whole PR.
//
// Continuity across runs does not come from the diff: it comes from the
// previous findings passed alongside it, which let Claude mark each one
// still_open or resolved. See src/prompts.js.
function assembleReviewDiff({ fullDiff, maxChars = MAX_DIFF_CHARS }) {
  const capped = capDiffText(fullDiff, maxChars);
  return {
    text: capped.text,
    truncated: capped.truncated,
    omitted: capped.omitted,
    mode: 'full',
  };
}

module.exports = {
  unescapeGitPath,
  parseDiffFiles,
  diffFilePaths,
  capDiffText,
  assembleReviewDiff,
};
