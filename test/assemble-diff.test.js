'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseDiffFiles, assembleReviewDiff } = require('../src/assemble-diff');

const fileA = [
  'diff --git a/src/a.js b/src/a.js',
  'index 111..222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,1 +1,2 @@',
  '+added in a',
  '',
].join('\n');

const fileB = [
  'diff --git a/src/b.js b/src/b.js',
  'index 333..444 100644',
  '--- a/src/b.js',
  '+++ b/src/b.js',
  '@@ -1,1 +1,2 @@',
  '+added in b',
  '',
].join('\n');

describe('parseDiffFiles', () => {
  it('splits a multi-file diff on diff --git headers', () => {
    const files = parseDiffFiles(fileA + fileB);
    assert.equal(files.length, 2);
    assert.equal(files[0].path, 'src/a.js');
    assert.equal(files[1].path, 'src/b.js');
    assert.equal(files[0].text.startsWith('diff --git a/src/a.js'), true);
  });

  it('returns an empty list for an empty diff', () => {
    assert.deepEqual(parseDiffFiles(''), []);
  });

  it('parses quoted git paths with spaces', () => {
    const quoted = [
      'diff --git "a/my file.js" "b/my file.js"',
      '--- "a/my file.js"',
      '+++ "b/my file.js"',
      '+hello',
      '',
    ].join('\n');
    const files = parseDiffFiles(quoted);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'my file.js');
  });
});

describe('assembleReviewDiff', () => {
  it('returns a truncated full diff when over the cap', () => {
    const assembled = assembleReviewDiff({
      fullDiff: 'abcdefghij',
      maxChars: 4,
    });
    assert.equal(assembled.mode, 'full');
    assert.equal(assembled.truncated, true);
    assert.equal(assembled.text, 'abcd');
  });

  // The guarantee that replaces incremental review: previous findings never
  // narrow what gets scanned. A regression in a file this push did not touch
  // is still in the diff Claude sees.
  it('always sends the complete PR diff, even when a previous review exists', () => {
    const assembled = assembleReviewDiff({
      fullDiff: fileA + fileB,
      maxChars: 10_000,
    });
    assert.equal(assembled.mode, 'full');
    assert.equal(assembled.truncated, false);
    assert.equal(assembled.text.includes('added in a'), true);
    assert.equal(assembled.text.includes('added in b'), true);
  });

  it('omits later files instead of slicing mid-hunk', () => {
    const assembled = assembleReviewDiff({
      fullDiff: fileA + fileB,
      maxChars: fileA.length + 10,
    });
    assert.equal(assembled.truncated, true);
    assert.equal(assembled.text.includes('added in a'), true);
    assert.equal(assembled.text.includes('added in b'), false);
    assert.equal(assembled.omitted.includes('src/b.js'), true);
  });
});
