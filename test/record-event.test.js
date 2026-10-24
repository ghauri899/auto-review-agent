'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildRunEvent, diffStats, originOf, pushedCommits, usageSummary } = require('../src/record-event');

const context = {
  repo: { owner: 'example-org', repo: 'app' },
  issue: { number: 42 },
  actor: 'fallback-actor',
  payload: {
    action: 'synchronize',
    before: 'aaa',
    after: 'bbb',
    sender: { login: 'dev-b' },
    pull_request: {
      number: 42,
      title: 'Add billing',
      user: { login: 'dev-a' },
      html_url: 'https://github.com/example-org/app/pull/42',
      base: { ref: 'staging' },
      head: { ref: 'feat/billing', sha: 'bbb' },
      draft: false,
      created_at: '2026-10-20T10:00:00Z',
    },
  },
};

const issue = (overrides) => ({ severity: 'MEDIUM', category: 'BUG', file: 'a.js', status: 'new', ...overrides });

describe('buildRunEvent', () => {
  it('records who, what was found, where it came from, and what it cost', () => {
    const event = buildRunEvent({
      context,
      env: { GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1' },
      now: new Date('2026-10-24T00:00:00Z'),
      reviewContext: {
        previous: { head_sha: 'aaa', run_count: 1, issues: [{ id: 1 }, { id: 2 }], resolved: [] },
        dismissals: [{ id: 2, reply: '2. false positive, validated upstream', by: 'lead' }],
      },
      stats: { kind: 'ok', late_catch_check: true, usage: [{ call: 'review', model: 'm', input_tokens: 10, output_tokens: 5 }] },
      review: {
        run_count: 2,
        score: 4,
        model_score: 4.5,
        risk_level: 'HIGH',
        carried_forward_count: 0,
        issues: [
          issue({ id: 3, severity: 'HIGH', status: 'new', late_catch: true }),
          issue({ id: 4, severity: 'LOW', status: 'new' }),
        ],
        resolved: [issue({ id: 1, status: 'resolved' })],
        dismissed: [issue({ id: 2 })],
        filtered: { out_of_scope: 0, not_confirmed: 1, verified: true },
      },
      diff: 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-x\n+y\n+z\n',
      commits: { count: 1, authors: ['dev-b'] },
    });

    assert.equal(event.repo, 'example-org/app');
    assert.deepEqual([event.pr.number, event.pr.author, event.trigger.actor], [42, 'dev-a', 'dev-b']);
    assert.deepEqual(event.run, { number: 2, kind: 'ok', late_catch_check: true });
    assert.deepEqual(event.diff, { files: 1, additions: 2, deletions: 1 });
    assert.deepEqual(event.findings.map((f) => [f.id, f.status, f.origin]), [
      [3, 'new', 'late_catch'],
      [4, 'new', 'this_push'],
      [1, 'resolved', null],
    ]);
    assert.deepEqual(event.counts.raised, { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 1 });
    assert.deepEqual(event.counts.open, { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 1 });
    assert.equal(event.counts.raised_late_catch, 1);
    assert.equal(event.counts.resolved_this_run, 1);
    assert.deepEqual(event.outcome, { score: 4, model_score: 4.5, risk_level: 'HIGH', blocking_open: 1, open: 2, ready_to_merge: false });
    assert.deepEqual(event.dismissals, [{ issue_id: 2, label: 'False positive', by: 'lead' }]);
    assert.equal(event.usage.length, 1);
  });

  it('still records a run whose review failed', () => {
    const event = buildRunEvent({
      context,
      reviewContext: { previous: { run_count: 3 } },
      stats: { kind: 'max_tokens', usage: [] },
      review: null,
      diff: '',
    });
    assert.deepEqual([event.run.number, event.run.kind], [4, 'max_tokens']);
    assert.equal(event.outcome, null);
    assert.deepEqual(event.findings, []);
  });

  it('marks a same-commit re-run as a replay', () => {
    const event = buildRunEvent({ context, review: { review_mode: 'rerun', run_count: 2, issues: [] }, stats: { kind: 'rerun' } });
    assert.equal(event.run.kind, 'replay');
  });
});

describe('originOf', () => {
  it('separates first review, this push, late catch and unknown', () => {
    assert.equal(originOf({ status: 'new' }, { runNumber: 1, lateCatchCheck: false }), 'first_review');
    assert.equal(originOf({ status: 'new' }, { runNumber: 2, lateCatchCheck: true }), 'this_push');
    assert.equal(originOf({ status: 'new', late_catch: true }, { runNumber: 2, lateCatchCheck: true }), 'late_catch');
    assert.equal(originOf({ status: 'new' }, { runNumber: 2, lateCatchCheck: false }), 'unknown');
    assert.equal(originOf({ status: 'still_open' }, { runNumber: 2, lateCatchCheck: true }), null);
  });
});

describe('diffStats', () => {
  it('ignores file headers', () => {
    assert.deepEqual(diffStats('diff --git a/x b/x\n--- a/x\n+++ b/x\n+a\n-b\n'), { files: 1, additions: 1, deletions: 1 });
  });
});

describe('pushedCommits', () => {
  it('compares before...after on a push and lists the PR commits otherwise', async () => {
    const calls = [];
    const github = {
      rest: {
        repos: {
          compareCommitsWithBasehead: async (args) => {
            calls.push(args.basehead);
            return { data: { commits: [{ author: { login: 'dev-b' } }, { author: null, commit: { author: { email: 'x@y' } } }] } };
          },
        },
        pulls: { listCommits: async () => ({ data: [{ author: { login: 'dev-a' } }, { author: { login: 'dev-a' } }] }) },
      },
    };
    assert.deepEqual(await pushedCommits({ github, context }), { count: 2, authors: ['dev-b', 'x@y'] });
    assert.deepEqual(calls, ['aaa...bbb']);
    const opened = { ...context, payload: { ...context.payload, action: 'opened' } };
    assert.deepEqual(await pushedCommits({ github, context: opened }), { count: 2, authors: ['dev-a'] });
  });

  it('returns null instead of failing when the API errors', async () => {
    const github = { rest: { repos: { compareCommitsWithBasehead: async () => { throw new Error('404'); } } } };
    assert.equal(await pushedCommits({ github, context }), null);
  });
});

describe('usageSummary', () => {
  it('is empty without calls and a table with them', () => {
    assert.equal(usageSummary([]), '');
    assert.match(
      usageSummary([{ call: 'verify', model: 'claude-sonnet-5-5', input_tokens: 9, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }]),
      /\| verify \| claude-sonnet-5-5 \| 9 \| 3 \| 0 \| 0 \|/
    );
  });
});
