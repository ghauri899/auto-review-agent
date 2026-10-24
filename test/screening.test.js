'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { verifyFindings } = require('../src/verify');
const { runReview } = require('../src/review');
const { screeningNote } = require('../src/format-comment');
const { collectLearnedDismissals, isTrustedAssociation } = require('../src/collect-context');
const { encodePayload } = require('../src/shared');
const { PATHS, STICKY_MARKER } = require('../src/constants');

function claudeReply(body) {
  return {
    ok: true,
    json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }] }),
  };
}

function finding(overrides = {}) {
  return {
    id: null,
    severity: 'HIGH',
    category: 'BUG',
    file: 'src/auth.js',
    line_reference: 'L11',
    title: 'Token cached before audit',
    status: 'new',
    failure_mode: 'A failed audit leaves a live token in cache.',
    description: 'd',
    fix: 'f',
    ...overrides,
  };
}

const assembled = { text: 'diff', truncated: false, mode: 'full' };

describe('verifyFindings', () => {
  it('drops rejected and pre-existing findings, keeps confirmed ones', async () => {
    const candidates = [finding({ title: 'real' }), finding({ title: 'wrong' }), finding({ title: 'old bug' })];
    const result = await verifyFindings({
      candidates,
      assembled,
      fetchImpl: async () =>
        claudeReply({
          verdicts: [
            { index: 0, verdict: 'confirmed', introduced_by_pr: true, reason: 'ok' },
            { index: 1, verdict: 'rejected', introduced_by_pr: true, reason: 'guarded above' },
            { index: 2, verdict: 'confirmed', introduced_by_pr: false, reason: 'on base already' },
          ],
        }),
    });
    assert.deepEqual(result.kept.map((issue) => issue.title), ['real']);
    assert.deepEqual(
      result.rejected.map((item) => [item.issue.title, item.reason]),
      [
        ['wrong', 'not_reproducible'],
        ['old bug', 'pre_existing'],
      ]
    );
    assert.equal(result.verified, true);
  });

  it('keeps a candidate the verifier skipped', async () => {
    const result = await verifyFindings({
      candidates: [finding({ title: 'a' }), finding({ title: 'b' })],
      assembled,
      fetchImpl: async () => claudeReply({ verdicts: [{ index: 0, verdict: 'confirmed', introduced_by_pr: true, reason: '' }] }),
    });
    assert.deepEqual(result.kept.map((issue) => issue.title), ['a', 'b']);
  });

  it('fails open when the verifier errors', async () => {
    const result = await verifyFindings({
      candidates: [finding()],
      assembled,
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'bad request' }),
    });
    assert.equal(result.kept.length, 1);
    assert.equal(result.verified, false);
  });

  it('sends the verification to the verify model with its own schema', async () => {
    let body;
    await verifyFindings({
      candidates: [finding()],
      assembled,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init.body);
        return claudeReply({ verdicts: [] });
      },
    });
    assert.equal(body.model, 'claude-sonnet-5-5');
    assert.deepEqual(body.output_config.format.schema.required, ['verdicts']);
  });

  it('makes no call when there is nothing to verify', async () => {
    const result = await verifyFindings({
      candidates: [],
      assembled,
      fetchImpl: async () => {
        throw new Error('should not be called');
      },
    });
    assert.deepEqual(result, { kept: [], rejected: [], verified: false });
  });
});

describe('runReview PR-scope screening', () => {
  const diff = [
    'diff --git a/src/auth.js b/src/auth.js',
    '--- a/src/auth.js',
    '+++ b/src/auth.js',
    '@@ -10,2 +10,3 @@',
    '   const token = sign(user);',
    '+  cache.set(user.id, token);',
    '   return token;',
    '',
  ].join('\n');

  function memoryFs(files) {
    const store = { ...files };
    return {
      store,
      readFile: (file) => store[file],
      writeFile: (file, data) => {
        store[file] = String(data);
      },
      exists: (file) => file in store,
    };
  }

  it('publishes only findings on changed lines that survive verification', async () => {
    const fs = memoryFs({ '/tmp/pr.diff': diff });
    const calls = [];
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (calls.length === 1) {
        return claudeReply({
          summary: { verdict: 'v', context: 'c' },
          score: 4,
          score_breakdown: { security: 4, correctness: 4, performance: 4, maintainability: 4, best_practices: 4 },
          score_rationale: '',
          issues: [
            finding({ title: 'On the new line', line_reference: 'L11' }),
            finding({ title: 'Pre-existing elsewhere', line_reference: 'L80' }),
            finding({ title: 'Other file', file: 'src/db.js', line_reference: 'L3' }),
            finding({ title: 'Not real', line_reference: 'L11' }),
          ],
        });
      }
      // Only the two in-scope findings reach the verifier.
      const prompt = body.messages[0].content;
      assert.match(prompt, /On the new line/);
      assert.match(prompt, /Not real/);
      assert.doesNotMatch(prompt, /Pre-existing elsewhere/);
      return claudeReply({
        verdicts: [
          { index: 0, verdict: 'confirmed', introduced_by_pr: true, reason: '' },
          { index: 1, verdict: 'rejected', introduced_by_pr: true, reason: 'cannot happen' },
        ],
      });
    };

    const result = await runReview({ diffPath: '/tmp/pr.diff', env: {}, fetchImpl, ...fs });
    assert.equal(calls.length, 2);
    assert.match(calls[0].messages[0].content, /11 \+  cache\.set/);
    assert.deepEqual(result.review.issues.map((issue) => issue.title), ['On the new line']);
    assert.deepEqual(result.review.issues[0].anchor, { line: 11 });
    assert.deepEqual(result.review.filtered, { out_of_scope: 2, not_confirmed: 1, verified: true });
    assert.match(fs.store[PATHS.reviewTxt], /3 possible findings were double-checked and left out/);
  });

  it('never screens out a finding carried over from an earlier run', async () => {
    const previous = {
      head_sha: 'old',
      run_count: 1,
      next_id: 2,
      issues: [finding({ id: 1, title: 'Old finding', line_reference: 'L80', status: 'new' })],
    };
    const fs = memoryFs({
      '/tmp/pr.diff': diff,
      '/tmp/ctx.json': JSON.stringify({ previous, dismissals: [] }),
    });
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return claudeReply({
        summary: { verdict: 'v', context: '' },
        score: 4,
        score_breakdown: { security: 4, correctness: 4, performance: 4, maintainability: 4, best_practices: 4 },
        score_rationale: '',
        issues: [finding({ id: 1, title: 'Old finding', line_reference: 'L80', status: 'still_open' })],
      });
    };
    const result = await runReview({
      diffPath: '/tmp/pr.diff',
      env: { REVIEW_CONTEXT_PATH: '/tmp/ctx.json', HEAD_SHA: 'new' },
      fetchImpl,
      gitImpl: () => {
        throw new Error('no git');
      },
      ...fs,
    });
    assert.equal(calls, 1, 'no verification call when there are no new findings');
    assert.deepEqual(result.review.issues.map((issue) => issue.id), [1]);
  });

  describe('tracking', () => {
    // The last push only touched another file, so src/auth.js L11 was already
    // reviewed on the previous run.
    const pushDiff = [
      'diff --git a/src/other.js b/src/other.js',
      '--- a/src/other.js',
      '+++ b/src/other.js',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');
    const previous = { head_sha: 'old', run_count: 1, next_id: 1, issues: [] };

    async function reviewWith(issues, git) {
      const fs = memoryFs({ '/tmp/pr.diff': diff, '/tmp/ctx.json': JSON.stringify({ previous, dismissals: [] }) });
      let calls = 0;
      const fetchImpl = async () => {
        calls += 1;
        const body =
          calls === 1
            ? {
                summary: { verdict: 'v', context: '' },
                score: 4,
                score_breakdown: { security: 4, correctness: 4, performance: 4, maintainability: 4, best_practices: 4 },
                score_rationale: '',
                issues,
              }
            : { verdicts: issues.map((_, index) => ({ index, verdict: 'confirmed', introduced_by_pr: true, reason: '' })) };
        return {
          ok: true,
          json: async () => ({
            stop_reason: 'end_turn',
            model: calls === 1 ? 'claude-opus-5-5' : 'claude-sonnet-5-5',
            usage: { input_tokens: 100 * calls, output_tokens: 10 * calls },
            content: [{ type: 'text', text: JSON.stringify(body) }],
          }),
        };
      };
      const result = await runReview({
        diffPath: '/tmp/pr.diff',
        env: { REVIEW_CONTEXT_PATH: '/tmp/ctx.json', HEAD_SHA: 'new' },
        fetchImpl,
        gitImpl: git,
        ...fs,
      });
      return { result, fs };
    }

    const gitWithPush = (args) => {
      if (args[0] === 'diff' && args[1] === 'old' && args[2] === 'new') return pushDiff;
      throw new Error('not in this fake');
    };

    it('records token usage for both calls, even alongside the review', async () => {
      const { fs } = await reviewWith([finding({ title: 'A' })], gitWithPush);
      const stats = JSON.parse(fs.store[PATHS.runStats]);
      assert.equal(stats.kind, 'ok');
      assert.equal(stats.late_catch_check, true);
      assert.deepEqual(
        stats.usage.map((call) => [call.call, call.model, call.input_tokens, call.output_tokens]),
        [
          ['review', 'claude-opus-5-5', 100, 10],
          ['verify', 'claude-sonnet-5-5', 200, 20],
        ]
      );
    });

    it('marks a new finding on code the latest push did not touch, without changing the review', async () => {
      const issues = [finding({ title: 'Earlier miss', severity: 'MEDIUM', failure_mode: null })];
      const late = await reviewWith(issues, gitWithPush);
      const touched = await reviewWith(issues, (args) => (args[0] === 'diff' ? diff : gitWithPush(args)));
      assert.equal(late.result.review.issues[0].late_catch, true);
      assert.equal(touched.result.review.issues[0].late_catch, undefined);
      assert.equal(late.fs.store[PATHS.reviewTxt], touched.fs.store[PATHS.reviewTxt]);
    });

    it('still writes the run stats when the review throws', async () => {
      const fs = memoryFs({ '/tmp/pr.diff': diff });
      await assert.rejects(
        runReview({
          diffPath: '/tmp/pr.diff',
          env: {},
          fetchImpl: async () => {
            throw new Error('network down');
          },
          ...fs,
        })
      );
      assert.deepEqual(JSON.parse(fs.store[PATHS.runStats]), { kind: 'error', usage: [], late_catch_check: false });
    });
  });
});

describe('screeningNote', () => {
  it('is empty when nothing was held back', () => {
    assert.equal(screeningNote(null), '');
    assert.equal(screeningNote({ out_of_scope: 0, not_confirmed: 0 }), '');
  });

  it('counts both kinds', () => {
    assert.match(screeningNote({ out_of_scope: 1, not_confirmed: 0 }), /1 possible finding was double-checked and left out: 1 in code this pull request did not change\./);
  });
});

describe('learned dismissals', () => {
  function checkpoint(issueNumber, payload) {
    return {
      issue_url: `https://api.github.com/repos/o/r/issues/${issueNumber}`,
      user: { login: 'github-actions[bot]', type: 'Bot' },
      body: `${STICKY_MARKER}\n<!-- inspector-g-data ${encodePayload(payload)} -->`,
    };
  }

  const github = (comments) => ({
    rest: { issues: { listCommentsForRepo: async () => ({ data: comments }) } },
  });
  const context = { repo: { owner: 'o', repo: 'r' }, issue: { number: 9 } };

  it('learns only trusted dismissals from other pull requests', async () => {
    const comments = [
      checkpoint(3, {
        dismissals: [
          { id: 1, file: 'a.js', title: 'Missing null check', reply: '1. by design, caller validates', trusted: true },
          { id: 2, file: 'b.js', title: 'SQL injection', reply: '2. false positive', trusted: false },
        ],
      }),
      // The current PR's own checkpoint is not "another" PR.
      checkpoint(9, { dismissals: [{ id: 1, file: 'c.js', title: 'Own PR', reply: '1. not a bug', trusted: true }] }),
      { issue_url: '/issues/4', user: { login: 'someone' }, body: 'hello' },
    ];
    const learned = await collectLearnedDismissals({ github: github(comments), context });
    assert.deepEqual(learned, [{ title: 'Missing null check', file: 'a.js', label: 'By design', reason: 'by design, caller validates' }]);
  });

  it('dedupes the same finding dismissed on several PRs', async () => {
    const d = { id: 1, file: 'a.js', title: 'Missing null check', reply: '1. by design', trusted: true };
    const learned = await collectLearnedDismissals({
      github: github([checkpoint(3, { dismissals: [d] }), checkpoint(4, { dismissals: [d] })]),
      context,
    });
    assert.equal(learned.length, 1);
  });

  it('trusts members and collaborators only', () => {
    assert.equal(isTrustedAssociation('MEMBER'), true);
    assert.equal(isTrustedAssociation('collaborator'), true);
    assert.equal(isTrustedAssociation('CONTRIBUTOR'), false);
    assert.equal(isTrustedAssociation(undefined), false);
  });
});
