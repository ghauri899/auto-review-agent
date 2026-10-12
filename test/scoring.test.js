'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { deriveRiskLevel, deriveScore, appendScoreHistory, countBySeverity } = require('../src/scoring');

function issue(severity, category = 'BUG', status = 'still_open') {
  return { severity, category, status, file: 'a.js', title: `${severity} ${category}` };
}

describe('deriveRiskLevel', () => {
  it('is LOW with no open findings', () => {
    assert.equal(deriveRiskLevel([]), 'LOW');
    assert.equal(deriveRiskLevel(null), 'LOW');
  });

  it('takes the worst severity still open', () => {
    assert.equal(deriveRiskLevel([issue('LOW'), issue('CRITICAL'), issue('MEDIUM')]), 'CRITICAL');
    assert.equal(deriveRiskLevel([issue('LOW'), issue('HIGH')]), 'HIGH');
  });

  it('ignores resolved findings', () => {
    assert.equal(deriveRiskLevel([issue('CRITICAL', 'SECURITY', 'resolved'), issue('LOW')]), 'LOW');
  });

  it('cannot report LOW while a CRITICAL carried over from an earlier run is open', () => {
    const carried = { ...issue('CRITICAL', 'SECURITY'), id: 1 };
    assert.equal(deriveRiskLevel([carried]), 'CRITICAL');
  });
});

describe('deriveScore', () => {
  // paramount-rx#667: 4.5/5 published with no finding to say what was wrong.
  it('ignores a model deduction when nothing is open to explain it', () => {
    const { score, ledger_score } = deriveScore({ issues: [], modelScore: 3.5 });
    assert.equal(ledger_score, 5);
    assert.equal(score, 5);
  });

  it('penalises open findings by severity', () => {
    assert.equal(deriveScore({ issues: [issue('CRITICAL')], modelScore: 5 }).score, 3);
    assert.equal(deriveScore({ issues: [issue('HIGH')], modelScore: 5 }).score, 4);
    assert.equal(deriveScore({ issues: [issue('CRITICAL'), issue('CRITICAL')], modelScore: 5 }).score, 1);
  });

  it('floors at zero rather than going negative', () => {
    const issues = [issue('CRITICAL'), issue('CRITICAL'), issue('CRITICAL')];
    assert.equal(deriveScore({ issues, modelScore: 5 }).score, 0);
  });

  it('ignores resolved findings', () => {
    const issues = [issue('CRITICAL', 'SECURITY', 'resolved'), issue('LOW')];
    assert.equal(deriveScore({ issues, modelScore: 5 }).score, 4.9);
  });

  // The complaint that started this: a clean run made Claude return a high
  // score while CRITICALs raised earlier in the PR stayed open.
  it('does not let a clean run wash out open findings', () => {
    const carried = [issue('CRITICAL', 'SECURITY'), issue('HIGH')];
    const { score } = deriveScore({ issues: carried, modelScore: 4.8 });
    assert.equal(score, 2);
  });

  it('keeps the model score as a ceiling once a finding is open', () => {
    const { score } = deriveScore({ issues: [issue('LOW')], modelScore: 2.5 });
    assert.equal(score, 2.5);
  });

  it('defaults to 5 when the model score is missing or garbage', () => {
    assert.equal(deriveScore({ issues: [], modelScore: undefined }).score, 5);
    assert.equal(deriveScore({ issues: [], modelScore: 'n/a' }).score, 5);
  });

  it('clamps an out-of-range model score', () => {
    assert.equal(deriveScore({ issues: [issue('LOW')], modelScore: 9 }).score, 4.9);
    assert.equal(deriveScore({ issues: [issue('LOW')], modelScore: -3 }).score, 0);
  });

  it('charges each finding to the dimension its category belongs to', () => {
    const { score_breakdown } = deriveScore({
      issues: [issue('CRITICAL', 'SECURITY'), issue('HIGH', 'DATA_INTEGRITY'), issue('MEDIUM', 'PERFORMANCE')],
      modelScore: 5,
    });
    assert.equal(score_breakdown.security, 3);
    assert.equal(score_breakdown.correctness, 4);
    assert.equal(score_breakdown.performance, 4.6);
    assert.equal(score_breakdown.maintainability, 5);
    assert.equal(score_breakdown.best_practices, 5);
  });

  it('cannot rate a dimension above what the model gave it', () => {
    const { score_breakdown } = deriveScore({
      issues: [issue('LOW', 'BUG'), issue('LOW', 'MAINTAINABILITY')],
      modelScore: 5,
      modelBreakdown: { security: 5, correctness: 2, performance: 5, maintainability: 3, best_practices: 5 },
    });
    assert.equal(score_breakdown.correctness, 2);
    assert.equal(score_breakdown.maintainability, 3);
  });

  it('ignores a dimension deduction with no finding in that dimension', () => {
    const { score_breakdown } = deriveScore({
      issues: [issue('LOW', 'BUG')],
      modelScore: 4,
      modelBreakdown: { security: 4.5, correctness: 4, performance: 4.5, maintainability: 4.5, best_practices: 4.5 },
    });
    assert.deepEqual(score_breakdown, {
      security: 5,
      correctness: 4,
      performance: 5,
      maintainability: 5,
      best_practices: 5,
    });
  });

  it('charges MAINTAINABILITY findings to maintainability', () => {
    const { score_breakdown } = deriveScore({ issues: [issue('MEDIUM', 'MAINTAINABILITY')], modelScore: 5 });
    assert.equal(score_breakdown.maintainability, 4.6);
    assert.equal(score_breakdown.best_practices, 5);
  });

  it('cannot rate a dimension above what the ledger allows', () => {
    const { score_breakdown } = deriveScore({
      issues: [issue('CRITICAL', 'SECURITY')],
      modelScore: 5,
      modelBreakdown: { security: 5, correctness: 5, performance: 5, maintainability: 5, best_practices: 5 },
    });
    assert.equal(score_breakdown.security, 3);
  });
});

describe('countBySeverity', () => {
  it('counts open findings only', () => {
    const counts = countBySeverity([issue('CRITICAL'), issue('CRITICAL'), issue('LOW', 'BUG', 'resolved')]);
    assert.deepEqual(counts, { CRITICAL: 2, HIGH: 0, MEDIUM: 0, LOW: 0 });
  });
});

describe('appendScoreHistory', () => {
  it('starts a history from nothing', () => {
    assert.deepEqual(appendScoreHistory(null, { run: 1, score: 4.2, head_sha: 'abc' }), [
      { run: 1, score: 4.2, head_sha: 'abc' },
    ]);
  });

  it('appends in run order', () => {
    const history = appendScoreHistory([{ run: 1, score: 4, head_sha: 'a' }], { run: 2, score: 3, head_sha: 'b' });
    assert.deepEqual(history.map((item) => item.run), [1, 2]);
  });

  it('replaces the entry for a run that is recomputed', () => {
    const history = appendScoreHistory(
      [
        { run: 1, score: 4, head_sha: 'a' },
        { run: 2, score: 3, head_sha: 'b' },
      ],
      { run: 2, score: 4.5, head_sha: 'b' }
    );
    assert.equal(history.length, 2);
    assert.equal(history[1].score, 4.5);
  });

  it('drops malformed entries and caps the length', () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ run: i + 1, score: 3, head_sha: null }));
    const history = appendScoreHistory([...long, { run: 'x', score: null }], { run: 31, score: 2 });
    assert.equal(history.length, 20);
    assert.equal(history[history.length - 1].run, 31);
  });
});
