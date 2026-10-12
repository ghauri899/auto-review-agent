'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runReview } = require('../src/review');
const { PATHS } = require('../src/constants');

function memoryFs(files) {
  const store = { ...files };
  return {
    store,
    readFile: (file) => {
      if (!(file in store)) throw new Error(`ENOENT: ${file}`);
      return store[file];
    },
    writeFile: (file, data) => {
      store[file] = String(data);
    },
    exists: (file) => file in store,
  };
}

function jsonResponse(body, extras = {}) {
  return {
    ok: true,
    json: async () => body,
    ...extras,
  };
}

describe('runReview', () => {
  it('writes a successful no-op when the diff is empty', async () => {
    const fs = memoryFs({ '/tmp/pr.diff': '   \n' });
    const result = await runReview({
      diffPath: '/tmp/pr.diff',
      ...fs,
    });
    assert.equal(result.kind, 'empty');
    assert.match(fs.store[PATHS.reviewTxt], /No changes to review/);
    const written = JSON.parse(fs.store[PATHS.reviewJson]);
    assert.deepEqual(written.issues, []);
    assert.equal(written.run_count, 1);
  });

  it('filters dismissed issues and writes the formatted comment', async () => {
    const fs = memoryFs({
      '/tmp/pr.diff': 'diff --git a/a.js b/a.js\n+oops\n',
      '/tmp/review-context.json': JSON.stringify({
        previous: null,
        dismissals: [{ file: 'a.js', title: 'Old noise' }],
      }),
    });

    const fetchImpl = async () =>
      jsonResponse({
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              summary: 'Looks risky',
              score: 3,
              risk_level: 'HIGH',
              issues: [
                {
                  severity: 'HIGH',
                  category: 'BUG',
                  file: 'a.js',
                  line_reference: 'L1',
                  title: 'Old noise',
                  description: 'dismiss me',
                  fix: 'nope',
                },
                {
                  severity: 'HIGH',
                  category: 'BUG',
                  file: 'a.js',
                  line_reference: 'L2',
                  title: 'Real crash',
                  failure_mode: 'It throws.',
                  description: 'unguarded null',
                  fix: 'check it',
                },
              ],
            }),
          },
        ],
      });

    const result = await runReview({
      diffPath: '/tmp/pr.diff',
      env: {
        REVIEW_CONTEXT_PATH: '/tmp/review-context.json',
        PR_TITLE: JSON.stringify('Fix stuff'),
        ANTHROPIC_API_KEY: 'test-key',
      },
      fetchImpl,
      ...fs,
    });

    assert.equal(result.kind, 'ok');
    assert.equal(result.review.issues.length, 1);
    assert.equal(result.review.issues[0].title, 'Real crash');
    assert.equal(result.review.issues[0].id, 2);
    assert.equal(result.review.next_id, 3);
    assert.equal(result.review.run_count, 1);
    assert.equal(result.review.review_mode, 'full');
    assert.match(fs.store[PATHS.reviewTxt], /Real crash/);
    // Dismissed, so it is off the open list but still on the record.
    assert.equal(result.review.dismissed.length, 1);
    assert.equal(result.review.dismissed[0].title, 'Old noise');
    assert.match(fs.store[PATHS.reviewTxt], /Marked not an issue by a reviewer \(1\)/);
    assert.match(fs.store[PATHS.reviewTxt], /~~Old noise~~/);
  });

  it('defaults a missing issue title instead of rendering "undefined"', async () => {
    const fs = memoryFs({ '/tmp/pr.diff': 'diff --git a/a.js b/a.js\n+oops\n' });

    const fetchImpl = async () =>
      jsonResponse({
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              summary: 'Looks risky',
              score: 3,
              risk_level: 'HIGH',
              issues: [
                {
                  severity: 'HIGH',
                  category: 'BUG',
                  file: 'a.js',
                  line_reference: 'L1',
                  description: 'unguarded null',
                  fix: 'check it',
                },
              ],
            }),
          },
        ],
      });

    const result = await runReview({
      diffPath: '/tmp/pr.diff',
      env: { ANTHROPIC_API_KEY: 'test-key', PR_TITLE: '"t"' },
      fetchImpl,
      ...fs,
    });

    assert.equal(result.kind, 'ok');
    assert.equal(result.review.issues[0].title, 'Untitled issue');
    assert.equal(fs.store[PATHS.reviewTxt].includes('undefined'), false);
  });

  it('replays the checkpoint and applies dismissals on a same-commit re-run without calling Claude', async () => {
    const previous = {
      head_sha: 'abc123',
      run_count: 1,
      next_id: 5,
      score: 2.5,
      risk_level: 'HIGH',
      summary: { verdict: 'Risky', context: 'Ledger drift' },
      score_breakdown: { security: 3, correctness: 2, performance: 4, maintainability: 4, best_practices: 3 },
      score_rationale: 'Two data issues.',
      issues: [1, 2, 3, 4].map((id) => ({
        id,
        severity: id === 3 ? 'MEDIUM' : 'HIGH',
        category: 'BUG',
        file: `f${id}.js`,
        line_reference: 'L1',
        title: `Finding ${id}`,
        status: 'new',
        description: `d${id}`,
        fix: `fix ${id}`,
        failure_mode: 'boom',
      })),
      resolved: [],
      dismissals: [],
    };
    const fs = memoryFs({
      '/tmp/pr.diff': 'diff --git a/a.js b/a.js\n+same\n',
      '/tmp/review-context.json': JSON.stringify({
        previous,
        dismissals: [
          { id: 1, reason: 'numbered_comment', reply: '1. false positive, the gateway validates this', by: 'octocat' },
          { id: 2, reason: 'numbered_comment', reply: "2. won't fix before the v2 rewrite" },
          { id: 4, reason: 'numbered_comment' },
        ],
      }),
    });
    let claudeCalled = false;

    const result = await runReview({
      diffPath: '/tmp/pr.diff',
      env: {
        REVIEW_CONTEXT_PATH: '/tmp/review-context.json',
        PR_ACTION: 'synchronize',
        HEAD_SHA: 'abc123',
        ANTHROPIC_API_KEY: 'test-key',
        PR_TITLE: '"t"',
      },
      fetchImpl: async () => {
        claudeCalled = true;
        throw new Error('should not be called');
      },
      ...fs,
    });

    assert.equal(claudeCalled, false);
    assert.equal(result.kind, 'rerun');
    assert.equal(result.review.run_count, 2);
    assert.equal(result.review.dismissed_count, 3);
    assert.deepEqual(
      result.review.issues.map((issue) => issue.id),
      [3]
    );
    assert.equal(result.review.issues[0].fix, 'fix 3');
    assert.match(fs.store[PATHS.reviewTxt], /Re-run on the same commit — applied 3 dismissals/);
    assert.match(fs.store[PATHS.reviewTxt], /3\. Finding 3/);
    assert.deepEqual(
      result.review.dismissed.map((item) => [item.id, item.label, item.reason, item.by]),
      [
        [1, 'False positive', 'false positive, the gateway validates this', 'octocat'],
        [2, "Won't fix", "won't fix before the v2 rewrite", ''],
        [4, 'Dismissed', '', ''],
      ]
    );
    // Dismissed findings stay visible, labelled and struck through, never dropped.
    assert.match(fs.store[PATHS.reviewTxt], /Marked not an issue by a reviewer \(3\)/);
    assert.match(fs.store[PATHS.reviewTxt], /~~Finding 1~~.*\*\*False positive\*\* \| false positive, the gateway validates this \| @octocat/);
    assert.match(fs.store[PATHS.reviewTxt], /~~Finding 4~~.*\*\*Dismissed\*\* \| _no reason given_ \| —/);
    // …but not as an open issue card.
    assert.equal(fs.store[PATHS.reviewTxt].includes('Finding 1</b>'), false);
  });

  it('does not replay when the head commit changed', async () => {
    const fs = memoryFs({
      '/tmp/pr.diff': 'diff --git a/a.js b/a.js\n+new\n',
      '/tmp/review-context.json': JSON.stringify({
        previous: { head_sha: 'old', summary: { verdict: 'x', context: '' }, issues: [], run_count: 1 },
        dismissals: [],
      }),
    });
    let claudeCalled = false;
    await runReview({
      diffPath: '/tmp/pr.diff',
      env: { REVIEW_CONTEXT_PATH: '/tmp/review-context.json', HEAD_SHA: 'new', ANTHROPIC_API_KEY: 'k', PR_TITLE: '"t"' },
      fetchImpl: async () => {
        claudeCalled = true;
        return jsonResponse({ stop_reason: 'refusal', content: [] });
      },
      ...fs,
    });
    assert.equal(claudeCalled, true);
  });

  // Inspector G deliberately does not do incremental review. A PR whose
  // earlier commits touched auth.js must still have auth.js in front of
  // Claude on a later push that only touched README.md — otherwise a
  // regression introduced earlier in the PR is never looked for again.
  it('sends the whole PR to Claude on a re-push, not just the new commits', async () => {
    const fullDiff =
      'diff --git a/auth.js b/auth.js\n+const user = req.query.user;\n' +
      'diff --git a/README.md b/README.md\n+typo fix\n';
    const fs = memoryFs({
      '/tmp/pr.diff': fullDiff,
      '/tmp/review-context.json': JSON.stringify({
        previous: {
          head_sha: 'old',
          run_count: 1,
          next_id: 2,
          issues: [
            {
              id: 1,
              severity: 'HIGH',
              category: 'SECURITY',
              file: 'auth.js',
              title: 'Unvalidated user param',
              status: 'still_open',
              description: 'taken straight from the query string',
              fix: 'validate it',
              failure_mode: 'Attacker controls the user id.',
            },
          ],
          resolved: [],
          dismissals: [],
        },
        dismissals: [],
      }),
    });

    let sentPrompt = '';
    const fetchImpl = async (_url, init) => {
      sentPrompt = JSON.parse(init.body).messages[0].content;
      return jsonResponse({
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              summary: { verdict: 'Docs change', context: '' },
              score: 5,
              score_breakdown: { security: 5, correctness: 5, performance: 5, maintainability: 5, best_practices: 5 },
              score_rationale: 'Fine.',
              issues: [],
            }),
          },
        ],
      });
    };

    const result = await runReview({
      diffPath: '/tmp/pr.diff',
      env: {
        REVIEW_CONTEXT_PATH: '/tmp/review-context.json',
        HEAD_SHA: 'new',
        // A re-push: the event that used to trigger incremental review.
        PR_ACTION: 'synchronize',
        ANTHROPIC_API_KEY: 'test-key',
        PR_TITLE: '"Fix typo"',
      },
      fetchImpl,
      ...fs,
    });

    assert.equal(result.review.review_mode, 'full');
    // The file no commit in this push touched is still under review.
    assert.ok(sentPrompt.includes('auth.js'), 'auth.js must be in the reviewed diff');
    assert.ok(sentPrompt.includes('README.md'));
    assert.match(sentPrompt, /COMPLETE pull request as it stands now/);
  });

  // The complaint that motivated ledger-derived scoring. Claude rates the code
  // it chooses to report on; when it returns a clean sheet, previously open
  // findings must still hold the published badge down. Reviewing the full PR
  // every run makes Claude's silence less likely, but never impossible — the
  // per-run cap on new findings alone can drop an older one from the response.
  it('scores the whole ledger, not just what Claude reported this run', async () => {
    const previous = {
      head_sha: 'old',
      run_count: 3,
      next_id: 3,
      score: 1.8,
      model_score: 3.2,
      score_history: [
        { run: 1, score: 2.5, head_sha: 'aaa' },
        { run: 2, score: 1.8, head_sha: 'bbb' },
        { run: 3, score: 1.8, head_sha: 'old' },
      ],
      issues: [
        {
          id: 1,
          severity: 'CRITICAL',
          category: 'SECURITY',
          file: 'auth.js',
          line_reference: 'L10',
          title: 'Auth bypass',
          status: 'still_open',
          description: 'guard removed',
          fix: 'restore it',
          failure_mode: 'Anyone can call admin.',
        },
        {
          id: 2,
          severity: 'HIGH',
          category: 'BUG',
          file: 'pay.js',
          line_reference: 'L4',
          title: 'Double charge',
          status: 'still_open',
          description: 'retry loop',
          fix: 'idempotency key',
          failure_mode: 'Customers billed twice.',
        },
      ],
      resolved: [],
      dismissals: [],
    };
    const fs = memoryFs({
      '/tmp/pr.diff': 'diff --git a/auth.js b/auth.js\n+x\ndiff --git a/pay.js b/pay.js\n+y\n',
      '/tmp/review-context.json': JSON.stringify({ previous, dismissals: [] }),
    });

    // Claude returns a clean sheet and a high score, saying nothing about the
    // two findings still open in the PR.
    const fetchImpl = async () =>
      jsonResponse({
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              summary: { verdict: 'Docs-only change', context: 'Fixes a typo.' },
              score: 4.8,
              score_breakdown: { security: 5, correctness: 5, performance: 5, maintainability: 5, best_practices: 5 },
              score_rationale: 'Trivial documentation fix.',
              issues: [],
            }),
          },
        ],
      });

    const result = await runReview({
      diffPath: '/tmp/pr.diff',
      env: {
        REVIEW_CONTEXT_PATH: '/tmp/review-context.json',
        HEAD_SHA: 'new',
        ANTHROPIC_API_KEY: 'test-key',
        PR_TITLE: '"Fix typo"',
      },
      fetchImpl,
      ...fs,
    });

    assert.equal(result.review.review_mode, 'full');
    // Both findings survive Claude's silence.
    assert.equal(result.review.carried_forward_count, 2);
    assert.deepEqual(result.review.issues.map((issue) => issue.id), [1, 2]);
    assert.deepEqual(result.review.resolved, []);
    // CRITICAL (2.0) + HIGH (1.0) off a 5.0 ledger, well under Claude's 4.8.
    assert.equal(result.review.score, 2);
    assert.equal(result.review.model_score, 4.8);
    assert.equal(result.review.risk_level, 'CRITICAL');
    assert.equal(result.review.score_breakdown.security, 3);
    assert.equal(result.review.score_breakdown.correctness, 4);
    assert.deepEqual(result.review.score_history.map((item) => item.run), [1, 2, 3, 4]);
    assert.equal(result.review.score_history[3].head_sha, 'new');
    assert.match(fs.store[PATHS.reviewTxt], /2 findings still open after 4 runs — 1 CRITICAL · 1 HIGH/);
    assert.match(fs.store[PATHS.reviewTxt], /Scored on the whole pull request/);
    assert.match(fs.store[PATHS.reviewTxt], /Must-Fix Issues \(2\)/);
    // Their line refs are from an older commit, so they are flagged as
    // unverified rather than presented as freshly confirmed.
    assert.equal(result.review.issues.every((issue) => issue.carried_forward === true), true);
    assert.match(fs.store[PATHS.reviewTxt], /carried forward/);
    assert.match(fs.store[PATHS.reviewTxt], /silence is not evidence it was fixed/);
  });

  it('closes carried-forward findings whose file the PR no longer touches', async () => {
    const previous = {
      head_sha: 'old',
      run_count: 1,
      next_id: 3,
      model_score: 4.5,
      issues: [
        {
          id: 1,
          severity: 'CRITICAL',
          category: 'SECURITY',
          file: 'reverted.js',
          line_reference: 'L10',
          title: 'Gone with the revert',
          status: 'still_open',
          description: 'd',
          fix: 'f',
        },
        {
          id: 2,
          severity: 'HIGH',
          category: 'BUG',
          file: 'kept.js',
          line_reference: 'L4',
          title: 'Still there',
          status: 'still_open',
          description: 'd',
          fix: 'f',
        },
      ],
      resolved: [],
      dismissals: [],
    };
    const fs = memoryFs({
      // reverted.js is no longer part of the PR; kept.js still is.
      '/tmp/pr.diff': 'diff --git a/kept.js b/kept.js\n+x\n',
      '/tmp/review-context.json': JSON.stringify({ previous, dismissals: [] }),
    });

    const result = await runReview({
      diffPath: '/tmp/pr.diff',
      env: { REVIEW_CONTEXT_PATH: '/tmp/review-context.json', HEAD_SHA: 'new', ANTHROPIC_API_KEY: 'k', PR_TITLE: '"t"' },
      fetchImpl: async () =>
        jsonResponse({
          stop_reason: 'end_turn',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                summary: { verdict: 'ok', context: '' },
                score: 4.5,
                score_breakdown: { security: 5, correctness: 5, performance: 5, maintainability: 5, best_practices: 5 },
                score_rationale: 'x',
                issues: [],
              }),
            },
          ],
        }),
      ...fs,
    });

    assert.deepEqual(result.review.resolved.map((item) => item.id), [1]);
    assert.deepEqual(result.review.issues.map((issue) => issue.id), [2]);
    assert.equal(result.review.risk_level, 'HIGH');
    assert.equal(result.review.score, 4);
  });

  it('closes the ledger instead of stranding it when the PR diff is empty', async () => {
    const previous = {
      head_sha: 'old',
      run_count: 2,
      next_id: 2,
      model_score: 4,
      issues: [
        {
          id: 1,
          severity: 'CRITICAL',
          category: 'SECURITY',
          file: 'a.js',
          line_reference: 'L1',
          title: 'Auth bypass',
          status: 'still_open',
          description: 'd',
          fix: 'f',
        },
      ],
      resolved: [],
      dismissals: [],
    };
    const fs = memoryFs({
      '/tmp/pr.diff': '   \n',
      '/tmp/review-context.json': JSON.stringify({ previous, dismissals: [] }),
    });

    const result = await runReview({
      diffPath: '/tmp/pr.diff',
      env: { REVIEW_CONTEXT_PATH: '/tmp/review-context.json', HEAD_SHA: 'new', ANTHROPIC_API_KEY: 'k', PR_TITLE: '"t"' },
      ...fs,
    });

    assert.equal(result.kind, 'empty');
    // Nothing is left to review, so no Must-Fix card can outlive the diff.
    assert.deepEqual(result.review.issues, []);
    assert.deepEqual(result.review.resolved.map((item) => item.id), [1]);
    assert.equal(result.review.risk_level, 'LOW');
    // Nothing open, so the earlier model deduction has no finding behind it.
    assert.equal(result.review.score, 5);
    assert.match(fs.store[PATHS.reviewTxt], /No Must-Fix Issues/);
  });

  it('lifts the score on a re-run once the open findings are dismissed', async () => {
    const previous = {
      head_sha: 'abc123',
      run_count: 1,
      next_id: 3,
      score: 2,
      model_score: 4.5,
      summary: { verdict: 'Risky', context: '' },
      model_breakdown: { security: 5, correctness: 5, performance: 5, maintainability: 5, best_practices: 5 },
      issues: [
        {
          id: 1,
          severity: 'CRITICAL',
          category: 'SECURITY',
          file: 'a.js',
          line_reference: 'L1',
          title: 'Auth bypass',
          status: 'still_open',
          description: 'd',
          fix: 'f',
        },
        {
          id: 2,
          severity: 'HIGH',
          category: 'BUG',
          file: 'b.js',
          line_reference: 'L1',
          title: 'Crash',
          status: 'still_open',
          description: 'd',
          fix: 'f',
        },
      ],
      resolved: [],
      dismissals: [],
    };
    const fs = memoryFs({
      '/tmp/pr.diff': 'diff --git a/a.js b/a.js\n+same\n',
      '/tmp/review-context.json': JSON.stringify({
        previous,
        dismissals: [{ id: 1, reason: 'numbered_comment', reply: '1. false positive, gateway validates', by: 'octocat' }],
      }),
    });

    const result = await runReview({
      diffPath: '/tmp/pr.diff',
      env: {
        REVIEW_CONTEXT_PATH: '/tmp/review-context.json',
        PR_ACTION: 'synchronize',
        HEAD_SHA: 'abc123',
        ANTHROPIC_API_KEY: 'test-key',
        PR_TITLE: '"t"',
      },
      fetchImpl: async () => {
        throw new Error('should not be called');
      },
      ...fs,
    });

    assert.equal(result.kind, 'rerun');
    // Only the HIGH is left, so the ledger allows 4.0 — capped by the model's
    // 4.5 baseline, not frozen at the 2.0 published last run.
    assert.equal(result.review.score, 4);
    assert.equal(result.review.risk_level, 'HIGH');
    assert.equal(result.review.model_score, 4.5);
  });

  it('derives risk from the ledger even when Claude reports nothing', async () => {
    const fs = memoryFs({ '/tmp/pr.diff': 'diff --git a/a.js b/a.js\n+x\n' });
    const fetchImpl = async () =>
      jsonResponse({
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              summary: { verdict: 'Fine', context: '' },
              score: 5,
              score_breakdown: { security: 5, correctness: 5, performance: 5, maintainability: 5, best_practices: 5 },
              score_rationale: 'Clean.',
              issues: [],
            }),
          },
        ],
      });

    const result = await runReview({
      diffPath: '/tmp/pr.diff',
      env: { ANTHROPIC_API_KEY: 'k', PR_TITLE: '"t"', HEAD_SHA: 'sha1' },
      fetchImpl,
      ...fs,
    });

    assert.equal(result.review.risk_level, 'LOW');
    assert.equal(result.review.score, 5);
    assert.match(fs.store[PATHS.reviewTxt], /No findings open after 1 run\./);
  });

  it('writes the refusal fallback instead of review.json', async () => {
    const fs = memoryFs({ '/tmp/pr.diff': 'diff --git a/a.js b/a.js\n+x\n' });
    const result = await runReview({
      diffPath: '/tmp/pr.diff',
      env: { ANTHROPIC_API_KEY: 'test-key', PR_TITLE: '"t"' },
      fetchImpl: async () => jsonResponse({ stop_reason: 'refusal', content: [] }),
      ...fs,
    });
    assert.equal(result.kind, 'refusal');
    assert.match(fs.store[PATHS.reviewTxt], /declined to review/);
    assert.equal(fs.store[PATHS.reviewJson], undefined);
  });
});
