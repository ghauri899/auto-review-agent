'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  verdictHeadline,
  scoreTimeline,
  mustFixAlert,
  walkthroughBlock,
  sanitizeMermaid,
  diagramBlock,
  formatReviewComment,
} = require('../src/format-comment');

const open = (severity, extra = {}) => ({ severity, status: 'new', title: severity, file: 'a.js', ...extra });

describe('verdictHeadline', () => {
  it('leads with blockers when any CRITICAL or HIGH is open', () => {
    assert.equal(verdictHeadline([open('CRITICAL'), open('HIGH'), open('LOW')]), '## 🚫 Not ready to merge — 2 blockers · 1 suggestion');
  });

  it('is ready to merge with only advisory findings', () => {
    assert.equal(verdictHeadline([open('MEDIUM'), open('LOW')]), '## ✅ Ready to merge · 2 suggestions');
  });

  it('is ready to merge with nothing open', () => {
    assert.equal(verdictHeadline([]), '## ✅ Ready to merge · no issues found');
  });
});

describe('scoreTimeline', () => {
  it('stays hidden on the first run', () => {
    assert.equal(scoreTimeline([{ run: 1, score: 2 }]), '');
  });

  it('shows the trend with the latest run bold', () => {
    assert.equal(
      scoreTimeline([
        { run: 1, score: 1.5 },
        { run: 2, score: 3.9 },
      ]),
      '<sub>Score by review: #1 1.5 → <b>#2 3.9</b> 📈</sub>'
    );
  });

  it('elides older runs past the cap', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ run: i + 1, score: 3 }));
    assert.match(scoreTimeline(history, 3), /^<sub>Score by review: … → #8 3\.0 → #9 3\.0 → <b>#10 3\.0<\/b><\/sub>$/);
  });
});

describe('mustFixAlert', () => {
  it('is red for CRITICAL and amber for HIGH', () => {
    assert.match(mustFixAlert([open('CRITICAL'), open('HIGH')]), /^> \[!CAUTION\]\n> \*\*These 2 issues need fixing/);
    assert.match(mustFixAlert([open('HIGH')]), /^> \[!WARNING\]\n> \*\*This issue needs fixing/);
    assert.equal(mustFixAlert([]), '');
  });

  it('points at Commit suggestion when a one-click fix exists', () => {
    assert.match(mustFixAlert([open('HIGH', { suggestion: { code: 'x' } })]), /Commit suggestion/);
  });
});

describe('walkthroughBlock', () => {
  it('renders the overview and a file table', () => {
    const md = walkthroughBlock({ overview: 'Adds login audit.', files: [{ file: 'a|b.js', change: 'Audits logins.' }] });
    assert.match(md, /What this pull request does/);
    assert.match(md, /Adds login audit\./);
    assert.match(md, /<code>a\\\|b\.js<\/code> \| Audits logins\. \|/);
  });

  it('is empty without content', () => {
    assert.equal(walkthroughBlock(null), '');
    assert.equal(walkthroughBlock({ overview: '', files: [] }), '');
  });
});

describe('sanitizeMermaid', () => {
  it('accepts a sequence diagram and strips fences', () => {
    assert.equal(sanitizeMermaid('```mermaid\nsequenceDiagram\n  A->>B: "hi"\n```'), 'sequenceDiagram\n  A->>B: "hi"');
  });

  it('accepts flowcharts', () => {
    assert.equal(sanitizeMermaid('flowchart LR\n  a["A"] --> b["B"]'), 'flowchart LR\n  a["A"] --> b["B"]');
  });

  it('rejects other diagram kinds, oversize, and directives', () => {
    assert.equal(sanitizeMermaid('pie\n "a": 1'), '');
    assert.equal(sanitizeMermaid(`flowchart LR\n${'a-->b\n'.repeat(50)}`), '');
    assert.equal(sanitizeMermaid('flowchart LR\n a-->b\n click a "https://evil"'), '');
    assert.equal(sanitizeMermaid('flowchart LR\n a["```"]'), '');
    assert.equal(sanitizeMermaid('%%{init: {}}%%\nflowchart LR\n a-->b'), '');
    assert.equal(sanitizeMermaid(null), '');
  });

  it('renders in a collapsed block', () => {
    assert.match(diagramBlock('sequenceDiagram\n A->>B: x'), /<details>\n<summary><b>🗺️ How the change flows<\/b><\/summary>\n\n```mermaid\nsequenceDiagram/);
    assert.equal(diagramBlock('nonsense'), '');
  });
});

describe('formatReviewComment layout', () => {
  const review = {
    summary: { verdict: 'Risky', context: 'Adds audit' },
    score: 2,
    risk_level: 'CRITICAL',
    run_count: 2,
    score_history: [
      { run: 1, score: 1.5 },
      { run: 2, score: 2 },
    ],
    score_breakdown: { security: 2, correctness: 3, performance: 5, maintainability: 4, best_practices: 4 },
    walkthrough: {
      overview: 'Plain words.',
      files: [
        { file: 'a.js', change: 'Adds the audit call.' },
        { file: 'b.js', change: 'Stores the audit row.' },
        { file: 'c.js', change: 'Reads it back.' },
      ],
    },
    diagram: 'sequenceDiagram\n A->>B: x',
    issues: [
      open('CRITICAL', {
        id: 1,
        line_reference: 'L3',
        description: 'd',
        fix: 'f',
        suggestion: { line_reference: 'L3', code: 'safe();' },
      }),
    ],
  };
  const md = formatReviewComment(review, { env: {} });

  it('puts the verdict first and the score table last, collapsed', () => {
    assert.ok(md.startsWith('## 🚫 Not ready to merge — 1 blocker'));
    assert.ok(md.indexOf('Must-Fix Issues') < md.indexOf('Score Breakdown'));
    assert.match(md, /<details>\n<summary><b>📊 Score Breakdown<\/b><\/summary>/);
  });

  it('shows the timeline, walkthrough, diagram, alert, and one-click fix', () => {
    assert.match(md, /Score by review: #1 1\.5 → <b>#2 2\.0<\/b>/);
    assert.match(md, /What this pull request does/);
    assert.match(md, /```mermaid/);
    assert.match(md, /> \[!CAUTION\]/);
    assert.match(md, /\*\*One-click fix\*\* — replaces <code>a\.js:L3<\/code>/);
    assert.match(md, /```js\nsafe\(\);\n```/);
  });
});
