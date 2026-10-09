'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { annotateDiff, changedLineMap, parseLineRange, checkPrScope } = require('../src/diff-lines');

const DIFF = [
  'diff --git a/src/auth.js b/src/auth.js',
  'index 111..222 100644',
  '--- a/src/auth.js',
  '+++ b/src/auth.js',
  '@@ -10,4 +10,5 @@ function login(user) {',
  '   const token = sign(user);',
  '-  if (!user.active) throw new Error("inactive");',
  '+  audit(user);',
  '+  cache.set(user.id, token);',
  '   return token;',
  ' }',
  '@@ -40,3 +41,3 @@ function logout() {',
  '   clear();',
  '-  return true;',
  '+  return false;',
  ' }',
  'diff --git a/src/new.js b/src/new.js',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.js',
  '@@ -0,0 +1,2 @@',
  '+const a = 1;',
  '+module.exports = a;',
  'diff --git a/old.js b/old.js',
  'deleted file mode 100644',
  '--- a/old.js',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone();',
  '',
].join('\n');

describe('annotateDiff', () => {
  it('prefixes hunk lines with new-file line numbers and leaves headers alone', () => {
    const lines = annotateDiff(DIFF).split('\n');
    assert.equal(lines[0], 'diff --git a/src/auth.js b/src/auth.js');
    assert.equal(lines[3], '+++ b/src/auth.js');
    assert.equal(lines[5], '   10    const token = sign(user);');
    assert.equal(lines[6], '      -  if (!user.active) throw new Error("inactive");');
    assert.equal(lines[7], '   11 +  audit(user);');
    assert.equal(lines[8], '   12 +  cache.set(user.id, token);');
    assert.equal(lines[9], '   13    return token;');
    assert.equal(lines[14], '   42 +  return false;');
  });
});

describe('changedLineMap', () => {
  const map = changedLineMap(DIFF);

  it('records added lines and deletion points per file', () => {
    const auth = map.get('src/auth.js');
    assert.equal(auth.status, 'modified');
    assert.deepEqual([...auth.added].sort((a, b) => a - b), [11, 12, 42]);
    assert.ok(auth.deletedAt.has(11));
  });

  it('marks new and deleted files', () => {
    assert.equal(map.get('src/new.js').status, 'added');
    assert.equal(map.get('old.js').status, 'deleted');
  });
});

describe('parseLineRange', () => {
  it('accepts the shapes Claude writes', () => {
    assert.deepEqual(parseLineRange('L42'), { start: 42, end: 42 });
    assert.deepEqual(parseLineRange('L42-L55'), { start: 42, end: 55 });
    assert.deepEqual(parseLineRange('42-55'), { start: 42, end: 55 });
    assert.equal(parseLineRange(null), null);
    assert.equal(parseLineRange('around the top'), null);
  });
});

describe('checkPrScope', () => {
  const map = changedLineMap(DIFF);
  const finding = (file, line_reference) => ({ file, line_reference, title: 't' });

  it('keeps a finding on a line the PR added', () => {
    assert.equal(checkPrScope(finding('src/auth.js', 'L12'), map).inScope, true);
    assert.equal(checkPrScope(finding('SRC/Auth.js', 'L42'), map).inScope, true);
  });

  it('keeps a finding about code the PR deleted', () => {
    // The removed "inactive" guard sat between lines 10 and 11.
    assert.equal(checkPrScope(finding('src/auth.js', 'L10'), map).inScope, true);
  });

  it('drops a finding on unchanged code in a touched file', () => {
    const result = checkPrScope(finding('src/auth.js', 'L30'), map);
    assert.deepEqual(result, { inScope: false, reason: 'unchanged_code' });
  });

  it('drops a finding in a file the PR does not touch', () => {
    assert.deepEqual(checkPrScope(finding('src/db.js', 'L5'), map), { inScope: false, reason: 'file_not_in_pr' });
  });

  it('needs a line reference for a modified file, not for a new one', () => {
    assert.deepEqual(checkPrScope(finding('src/auth.js', null), map), { inScope: false, reason: 'no_line_reference' });
    assert.equal(checkPrScope(finding('src/new.js', null), map).inScope, true);
  });

  it('cannot check a deleted file or one with no hunks, so lets it through', () => {
    assert.equal(checkPrScope(finding('old.js', 'L1'), map).inScope, true);
    const bare = changedLineMap('diff --git a/a.js b/a.js\n+oops\n');
    assert.equal(checkPrScope(finding('a.js', 'L99'), bare).inScope, true);
  });
});
