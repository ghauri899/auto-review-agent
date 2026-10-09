'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { STICKY_MARKER, BODY_START, BODY_END } = require('../src/constants');
const { removePrBlock, upsertPrBody, extractPayload, isCheckpointComment } = require('../src/shared');
const {
  buildVisibleBody,
  buildCommentBody,
  verdictChangeNote,
  removeDescriptionReview,
} = require('../src/post-comment');

const high = { id: 1, severity: 'HIGH', title: 'Crash', status: 'new' };
const low = { id: 2, severity: 'LOW', title: 'Nit', status: 'new' };

describe('review comment body', () => {
  const visible = buildVisibleBody('## ✅ Ready to merge · no issues found', 3);
  const body = buildCommentBody({ visibleBody: visible, payload: { run_count: 3, issues: [] }, sourceIssues: [] });

  it('is the checkpoint comment and carries the review and the data', () => {
    assert.ok(body.startsWith(STICKY_MARKER));
    assert.ok(isCheckpointComment({ body, user: { login: 'github-actions[bot]' } }));
    assert.match(body, /## ✅ Ready to merge/);
    assert.equal(extractPayload(body).run_count, 3);
  });

  it('does not let the run number link to an issue', () => {
    assert.match(body, /run <span>#<\/span>3/);
    assert.equal(/run #3/.test(body), false);
  });
});

describe('verdictChangeNote', () => {
  const url = 'https://github.com/acme/app/pull/7#issuecomment-1';

  it('announces a flip from blocked to ready, linking the review', () => {
    const note = verdictChangeNote({
      previous: { issues: [high] },
      review: { issues: [low] },
      headSha: 'abc1234def',
      commentUrl: url,
    });
    assert.equal(note, `🕵️ Re-reviewed \`abc1234\`: **✅ Ready to merge · 1 suggestion** — [full review ↑](${url})`);
  });

  it('announces a flip from ready to blocked', () => {
    const note = verdictChangeNote({ previous: { issues: [] }, review: { issues: [high] }, headSha: 'abc1234', commentUrl: url });
    assert.match(note, /🚫 Not ready to merge — 1 blocker/);
  });

  it('stays quiet when the verdict holds, and on the first review', () => {
    assert.equal(verdictChangeNote({ previous: { issues: [high] }, review: { issues: [high, low] }, headSha: 'a' }), '');
    assert.equal(verdictChangeNote({ previous: null, review: { issues: [high] }, headSha: 'a' }), '');
  });
});

describe('removePrBlock', () => {
  it('leaves only the author text', () => {
    const withReview = upsertPrBody('Author wrote this.', 'REVIEW', { start: BODY_START, end: BODY_END });
    assert.equal(removePrBlock(withReview, { start: BODY_START, end: BODY_END }), 'Author wrote this.');
  });

  it('keeps text after the block and handles a missing end marker', () => {
    const body = `Top\n\n${BODY_START}\nREVIEW\n${BODY_END}\n\nBottom`;
    assert.equal(removePrBlock(body, { start: BODY_START, end: BODY_END }), 'Top\n\nBottom');
    assert.equal(removePrBlock(`Top\n${BODY_START}\nREVIEW`, { start: BODY_START, end: BODY_END }), 'Top');
    assert.equal(removePrBlock('Untouched', { start: BODY_START, end: BODY_END }), 'Untouched');
  });
});

describe('removeDescriptionReview', () => {
  function fake(body) {
    const calls = { get: 0, update: [] };
    const github = {
      rest: {
        pulls: {
          get: async () => {
            calls.get += 1;
            return { data: { body } };
          },
          update: async (args) => calls.update.push(args.body),
        },
      },
    };
    return { github, calls };
  }
  const context = (body) => ({ repo: { owner: 'acme', repo: 'app' }, issue: { number: 7 }, payload: { pull_request: { number: 7, body } } });

  it('removes an old review from the description once', async () => {
    const current = `Author.\n\n${BODY_START}\nREVIEW\n${BODY_END}`;
    const { github, calls } = fake(current);
    await removeDescriptionReview({ github, context: context(current) });
    assert.deepEqual(calls.update, ['Author.']);
  });

  it('makes no API call when the description has no review', async () => {
    const { github, calls } = fake('Author.');
    await removeDescriptionReview({ github, context: context('Author.') });
    assert.equal(calls.get, 0);
    assert.deepEqual(calls.update, []);
  });
});
