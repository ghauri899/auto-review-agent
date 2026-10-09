'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { changedLineMap, inlinePlacement } = require('../src/diff-lines');
const {
  selectInlineIssues,
  inlineCommentBody,
  reviewCommentPayload,
  sameInlineComment,
} = require('../src/post-comment');

const DIFF = [
  'diff --git a/src/auth.js b/src/auth.js',
  '--- a/src/auth.js',
  '+++ b/src/auth.js',
  '@@ -10,3 +10,5 @@',
  '   const token = sign(user);',
  '+  cache.set(user.id, token);',
  '+  audit(user);',
  '   return token;',
  ' }',
  '@@ -40,2 +42,2 @@',
  '   clear();',
  '-  return true;',
  '+  return false;',
  '',
].join('\n');

const map = changedLineMap(DIFF);
const issue = (overrides) => ({ file: 'src/auth.js', line_reference: 'L11', suggestion: null, ...overrides });

describe('inlinePlacement', () => {
  it('anchors to the cited changed lines', () => {
    assert.deepEqual(inlinePlacement(issue({ line_reference: 'L11-L12' }), map).anchor, { start_line: 11, line: 12 });
  });

  it('accepts a suggestion inside one hunk and anchors the comment to it', () => {
    const placed = inlinePlacement(issue({ suggestion: { line_reference: 'L11-L12', code: '  audit(user);\n  cache.set(user.id, token);\n' } }), map);
    assert.deepEqual(placed.anchor, { start_line: 11, line: 12 });
    assert.equal(placed.suggestion.code, '  audit(user);\n  cache.set(user.id, token);');
  });

  it('refuses a suggestion that spans hunks or only unchanged lines', () => {
    assert.equal(inlinePlacement(issue({ suggestion: { line_reference: 'L12-L43', code: 'x' } }), map).suggestion, null);
    assert.equal(inlinePlacement(issue({ suggestion: { line_reference: 'L10', code: 'x' } }), map).suggestion, null);
  });

  it('pins a region that spans hunks to its first changed line', () => {
    assert.deepEqual(inlinePlacement(issue({ line_reference: 'L10-L43' }), map).anchor, { line: 11 });
  });

  it('has no anchor for lines outside the diff', () => {
    assert.equal(inlinePlacement(issue({ line_reference: 'L80' }), map).anchor, null);
    assert.equal(inlinePlacement(issue({ file: 'other.js' }), map).anchor, null);
  });
});

describe('inline comments', () => {
  const finding = {
    id: 4,
    severity: 'HIGH',
    category: 'BUG',
    file: 'src/auth.js',
    line_reference: 'L11-L12',
    title: 'Token cached before audit',
    status: 'new',
    failure_mode: 'A failed audit leaves a live token in cache.',
    fix: 'Audit first.',
    anchor: { start_line: 11, line: 12 },
    suggestion: { line_reference: 'L11-L12', code: '  audit(user);\n  cache.set(user.id, token);' },
  };

  it('renders a one-click suggestion block', () => {
    const body = inlineCommentBody(finding);
    assert.match(body, /```suggestion\n {2}audit\(user\);\n {2}cache\.set\(user\.id, token\);\n```/);
    assert.match(body, /Reply `4\. false positive because …`/);
  });

  it('lengthens the fence when the suggested code contains backticks', () => {
    const body = inlineCommentBody({ ...finding, suggestion: { line_reference: 'L11', code: 'const s = ```;' } });
    assert.match(body, /````suggestion\nconst s = ```;\n````/);
  });

  it('builds a multi-line review comment payload', () => {
    const payload = reviewCommentPayload(finding);
    assert.equal(payload.path, 'src/auth.js');
    assert.equal(payload.line, 12);
    assert.equal(payload.start_line, 11);
    assert.equal(payload.start_side, 'RIGHT');
  });

  it('skips findings with no valid anchor on this diff', () => {
    const selected = selectInlineIssues({ issues: [finding, { ...finding, id: 5, title: 'Off diff', anchor: null }] }, {});
    assert.deepEqual(selected.map((item) => item.id), [4]);
  });

  it('recognises an identical comment already on the PR', () => {
    const payload = reviewCommentPayload(finding);
    assert.equal(sameInlineComment({ path: payload.path, line: 12, start_line: 11, body: payload.body }, payload), true);
    assert.equal(sameInlineComment({ path: payload.path, line: 13, start_line: 11, body: payload.body }, payload), false);
  });
});
