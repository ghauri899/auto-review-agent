'use strict';

const { execFileSync } = require('node:child_process');
const {
  MAX_CONTEXT_FILE_CHARS,
  MAX_CONTEXT_FILES_CHARS,
  MAX_CONTEXT_USAGE_CHARS,
  MAX_CONTEXT_SYMBOLS,
  MAX_USAGES_PER_SYMBOL,
  MAX_RULES_CHARS,
  RULES_FILE,
} = require('./constants');
const { changedLineMap } = require('./diff-lines');

function defaultGit(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

// Names the PR defines or changes, read from definition lines it added or
// removed and from the enclosing-function context git prints on hunk headers.
// Heuristic by design: the goal is to find call sites worth showing Claude,
// not to parse every language.
const DEFINITION_RES = [
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  /\bclass\s+([A-Za-z_$][\w$]*)/,
  /\bdef\s+([A-Za-z_]\w*)/,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^\s*(?:export\s+)?(?:public|private|protected|static|async|\s)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/,
];
const NOT_SYMBOLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'else', 'with', 'super',
  'main', 'init', 'test', 'describe', 'it', 'then', 'render', 'handler', 'index', 'default', 'module',
]);

function symbolsFromLine(text) {
  const names = [];
  for (const re of DEFINITION_RES) {
    const match = re.exec(text);
    if (match && match[1]) names.push(match[1]);
  }
  return names;
}

function changedSymbols(diff, limit = MAX_CONTEXT_SYMBOLS) {
  const seen = new Set();
  const out = [];
  const add = (name) => {
    if (!name || name.length < 4 || NOT_SYMBOLS.has(name) || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('@@')) {
      const context = line.replace(/^@@[^@]*@@/, '');
      symbolsFromLine(context).forEach(add);
    } else if ((line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))) {
      symbolsFromLine(line.slice(1)).forEach(add);
    }
    if (out.length >= limit) break;
  }
  return out;
}

function looksBinary(text) {
  return text.includes('\u0000');
}

// The post-change content of each modified file, so Claude can see what the
// changed lines sit inside: the guard three lines above the hunk, the type a
// variable was declared with. New files are skipped — the diff already holds
// every line of them — and so are files too large to be worth the budget.
function readTouchedFiles({ lineMap, headSha, git, maxFile = MAX_CONTEXT_FILE_CHARS, maxTotal = MAX_CONTEXT_FILES_CHARS }) {
  const files = [];
  const skipped = [];
  let used = 0;
  for (const [path, entry] of lineMap) {
    if (entry.status !== 'modified') continue;
    let content;
    try {
      content = git(['show', `${headSha}:${entry.path || path}`]);
    } catch {
      continue;
    }
    if (!content || looksBinary(content)) continue;
    if (content.length > maxFile || used + content.length > maxTotal) {
      skipped.push(entry.path || path);
      continue;
    }
    used += content.length;
    files.push({ path: entry.path || path, content });
  }
  return { files, skipped };
}

// Where the changed symbols are used elsewhere in the repository, one line per
// hit. This is how a renamed parameter or a new throw path is checked against
// the callers the PR did not touch.
function findUsages({ symbols, lineMap, headSha, git, perSymbol = MAX_USAGES_PER_SYMBOL, maxChars = MAX_CONTEXT_USAGE_CHARS }) {
  const usages = [];
  let used = 0;
  for (const symbol of symbols) {
    let output = '';
    try {
      output = git(['grep', '-n', '-w', '-F', '-I', '-e', symbol, headSha, '--', '.', ':(exclude)*.lock', ':(exclude)*.min.js', ':(exclude)dist/**', ':(exclude)build/**', ':(exclude)vendor/**', ':(exclude)node_modules/**']);
    } catch {
      // git grep exits 1 when nothing matches.
      continue;
    }
    const hits = [];
    for (const raw of output.split('\n')) {
      if (!raw) continue;
      // "<sha>:<path>:<line>:<text>"
      const rest = raw.startsWith(`${headSha}:`) ? raw.slice(headSha.length + 1) : raw;
      const match = /^(.+?):(\d+):(.*)$/.exec(rest);
      if (!match) continue;
      const [, path, line, text] = match;
      // Hits inside files the PR changed are already in the diff or the file context.
      if (lineMap.has(path.toLowerCase())) continue;
      hits.push(`${path}:${line}: ${text.trim().slice(0, 200)}`);
      if (hits.length >= perSymbol) break;
    }
    if (hits.length === 0) continue;
    const block = `${symbol}\n${hits.map((hit) => `  ${hit}`).join('\n')}`;
    if (used + block.length > maxChars) break;
    used += block.length;
    usages.push({ symbol, hits });
  }
  return usages;
}

// Team review rules, read from the BASE branch. Reading them from the PR head
// would let a pull request rewrite the rules it is reviewed under.
function readRules({ baseSha, git, maxChars = MAX_RULES_CHARS }) {
  if (!baseSha) return '';
  try {
    const text = git(['show', `${baseSha}:${RULES_FILE}`]);
    return looksBinary(text) ? '' : text.slice(0, maxChars).trim();
  } catch {
    return '';
  }
}

function gatherRepoContext({ diff, lineMap, headSha, baseSha, git = defaultGit }) {
  const empty = { files: [], skipped: [], usages: [], rules: '' };
  if (!headSha) return { ...empty, rules: readRules({ baseSha, git }) };
  try {
    const { files, skipped } = readTouchedFiles({ lineMap, headSha, git });
    const usages = findUsages({ symbols: changedSymbols(diff), lineMap, headSha, git });
    return { files, skipped, usages, rules: readRules({ baseSha, git }) };
  } catch (err) {
    console.log(`Could not gather repository context: ${err.message}`);
    return empty;
  }
}

// What changed between the last reviewed commit and this one, as a line map
// (src/diff-lines.js). null when there is no earlier review or its commit is
// gone (a force-push).
function changesSinceReview({ previousSha, headSha, git = defaultGit }) {
  if (!previousSha || !headSha || previousSha === headSha) return null;
  try {
    return changedLineMap(git(['diff', previousSha, headSha]));
  } catch {
    return null;
  }
}

module.exports = {
  changesSinceReview,
  changedSymbols,
  readTouchedFiles,
  findUsages,
  readRules,
  gatherRepoContext,
};
