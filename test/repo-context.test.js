'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { changedSymbols, gatherRepoContext } = require('../src/repo-context');
const { changedLineMap } = require('../src/diff-lines');

const DIFF = [
  'diff --git a/src/auth.js b/src/auth.js',
  '--- a/src/auth.js',
  '+++ b/src/auth.js',
  '@@ -10,3 +10,3 @@ function login(user) {',
  '-async function issueToken(user) {',
  '+async function issueToken(user, ttl) {',
  '   return sign(user);',
  'diff --git a/src/new.js b/src/new.js',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.js',
  '@@ -0,0 +1 @@',
  '+const refreshSession = async (id) => id;',
  '',
].join('\n');

function fakeGit(files, grep = {}) {
  return (args) => {
    if (args[0] === 'show') {
      const [, spec] = args;
      const path = spec.slice(spec.indexOf(':') + 1);
      if (!(path in files)) throw new Error('missing');
      return files[path];
    }
    if (args[0] === 'grep') {
      const symbol = args[args.indexOf('-e') + 1];
      if (!grep[symbol]) throw new Error('exit 1');
      return grep[symbol];
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

describe('changedSymbols', () => {
  it('reads names from changed definitions and hunk headers', () => {
    assert.deepEqual(changedSymbols(DIFF), ['login', 'issueToken', 'refreshSession']);
  });
});

describe('gatherRepoContext', () => {
  const lineMap = changedLineMap(DIFF);

  it('includes modified files, outside usages, and base-branch rules', () => {
    const git = fakeGit(
      { 'src/auth.js': 'full auth file', '.github/inspector-g.md': 'Never flag console.log in scripts/.' },
      { issueToken: 'abc:src/routes.js:7:  const t = await issueToken(user);\nabc:src/auth.js:10:async function issueToken(user, ttl) {\n' }
    );
    const context = gatherRepoContext({ diff: DIFF, lineMap, headSha: 'abc', baseSha: 'base', git });
    assert.deepEqual(context.files, [{ path: 'src/auth.js', content: 'full auth file' }]);
    assert.deepEqual(context.usages, [{ symbol: 'issueToken', hits: ['src/routes.js:7: const t = await issueToken(user);'] }]);
    assert.equal(context.rules, 'Never flag console.log in scripts/.');
  });

  it('skips files over the size budget', () => {
    const git = fakeGit({ 'src/auth.js': 'x'.repeat(50_000) });
    const context = gatherRepoContext({ diff: DIFF, lineMap, headSha: 'abc', git });
    assert.deepEqual(context.files, []);
    assert.deepEqual(context.skipped, ['src/auth.js']);
  });

  it('reads rules from the base commit, not the PR head', () => {
    const seen = [];
    const git = (args) => {
      seen.push(args.join(' '));
      throw new Error('missing');
    };
    gatherRepoContext({ diff: DIFF, lineMap, headSha: 'head', baseSha: 'base', git });
    assert.ok(seen.includes('show base:.github/inspector-g.md'));
    assert.ok(!seen.includes('show head:.github/inspector-g.md'));
  });

  it('returns nothing without a head commit', () => {
    const context = gatherRepoContext({ diff: DIFF, lineMap, headSha: undefined, git: fakeGit({}) });
    assert.deepEqual(context, { files: [], skipped: [], usages: [], rules: '' });
  });
});
