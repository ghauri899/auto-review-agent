'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatReviewComment,
  badge,
  scoreColor,
  progressBar,
  shieldEscape,
  normalizeSummary,
  formatSummaryBlock,
  rerunLink,
  rerunFooter,
} = require('../src/format-comment');
const { extractPayload, titleFromInline, isBotLogin } = require('../src/collect-context');
const { extractReviewJson, requestReview } = require('../src/claude-client');
const { SYSTEM_PROMPT, buildUserPrompt } = require('../src/prompts');
const { selectMustFixIssues, inlineCommentBody, buildCommentBody } = require('../src/post-comment');
const { STICKY_MARKER } = require('../src/constants');

describe('summary formatting', () => {
  it('renders structured summary as verdict + context', () => {
    const md = formatSummaryBlock(
      {
        verdict: 'Risky reporting refactor — reconciliation may silently break',
        context: 'Consolidates order-money SQL into a shared reporting kernel.',
      },
      '🔴'
    );
    assert.match(md, /\*\*🔴 Risky reporting refactor/);
    assert.match(md, /Consolidates order-money SQL/);
    assert.doesNotMatch(md, /\*\*🔴 .+Consolidates/);
  });

  it('splits legacy string summaries into verdict and context', () => {
    const { verdict, context } = normalizeSummary(
      'Risky reporting refactor. Consolidates order-money SQL into a shared kernel. Inventory reconciliation may break.'
    );
    assert.equal(verdict, 'Risky reporting refactor.');
    assert.match(context, /Consolidates order-money SQL/);
  });
});

describe('re-run link', () => {
  const env = {
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'example-org/app',
    GITHUB_RUN_ID: '12345',
  };

  it('builds the run URL from the Actions defaults', () => {
    assert.equal(rerunLink(env), 'https://github.com/example-org/app/actions/runs/12345');
  });

  it('renders nothing outside Actions, so local runs stay clean', () => {
    assert.equal(rerunLink({}), '');
    assert.equal(rerunFooter({ GITHUB_REPOSITORY: 'example-org/app' }), '');
  });

  it('appends the footer to the end of the review', () => {
    const md = formatReviewComment(
      { summary: 'x', score: 5, risk_level: 'LOW', issues: [], dismissed: [] },
      { env }
    );
    assert.match(md, /Re-run this review\]\(https:\/\/github\.com\/example-org\/app\/actions\/runs\/12345\)/);
    assert.match(md.trimEnd(), /<\/sub>$/);
  });

  it('leaves the review untouched when the env is missing', () => {
    const review = { summary: 'x', score: 5, risk_level: 'LOW', issues: [], dismissed: [] };
    assert.doesNotMatch(formatReviewComment(review, { env: {} }), /Re-run this review/);
  });
});

describe('formatReviewComment', () => {
  it('renders must-fix, advisory, resolved, and re-run notes', () => {
    const md = formatReviewComment({
      summary: 'Risky auth change',
      score: 2.5,
      risk_level: 'HIGH',
      review_mode: 'rerun',
      dismissed_count: 2,
      score_rationale: 'Auth checks were removed.',
      score_breakdown: {
        security: 1,
        correctness: 3,
        performance: 5,
        maintainability: 4,
        best_practices: 2,
      },
      issues: [
        {
          severity: 'CRITICAL',
          category: 'SECURITY',
          file: 'auth.js',
          line_reference: 'L12',
          title: 'Auth bypass',
          status: 'new',
          failure_mode: 'Anyone can call the admin endpoint.',
          description: 'Guard was deleted.',
          fix: 'Restore the role check.',
        },
        {
          severity: 'MEDIUM',
          category: 'BEST_PRACTICE',
          file: 'auth.js',
          title: 'Noisy log',
          status: 'still_open',
          description: 'Logs tokens.',
          fix: 'Redact.',
        },
        {
          severity: 'HIGH',
          category: 'BUG',
          file: 'old.js',
          title: 'Null crash',
          status: 'resolved',
          description: 'was a crash',
          fix: 'n/a',
        },
      ],
    });

    assert.match(md, /Quality Score/);
    assert.match(md, /Risky auth change/);
    assert.match(md, /Re-run on the same commit — applied 2 dismissals/);
    assert.match(md, /Must-Fix Issues \(1\)/);
    assert.match(md, /Auth bypass/);
    assert.match(md, /Advisory Issues \(1/);
    assert.match(md, /Previously resolved \(1\)/);
    assert.match(md, /Null crash/);
  });

  it('renders numbered findings, run count, and accumulated resolved', () => {
    const md = formatReviewComment({
      summary: 'Clean enough',
      score: 4,
      risk_level: 'LOW',
      run_count: 4,
      issues: [{ id: 3, severity: 'HIGH', category: 'BUG', file: 'a.js', title: 'Crash', status: 'new', description: 'x', fix: 'y' }],
      resolved: [{ id: 1, title: 'Old crash', file: 'z.js' }],
    });
    assert.match(md, /Review/);
    assert.match(md, /#4/);
    assert.match(md, /3\. Crash/);
    assert.match(md, /Previously resolved \(1\)/);
    assert.match(md, /1\. Old crash/);
  });

  it('records dismissed findings with their verdict, reason, and author', () => {
    const md = formatReviewComment({
      summary: 'Mostly fine',
      score: 4,
      risk_level: 'LOW',
      issues: [],
      dismissed: [
        {
          id: 3,
          title: 'Auth bypass',
          file: 'api/auth.js',
          label: 'False positive',
          reason: 'we validate at the gateway',
          by: 'octocat',
        },
        { id: 6, title: 'Slow loop', file: 'b.js', label: "Won't fix", reason: '', by: '' },
      ],
    });
    assert.match(md, /Marked not an issue by a reviewer \(2\)/);
    assert.match(md, /\| 3 \| ~~Auth bypass~~ <sub><code>api\/auth.js<\/code><\/sub> \| \*\*False positive\*\* \| we validate at the gateway \| @octocat \|/);
    assert.match(md, /\| 6 \| ~~Slow loop~~.*\| \*\*Won't fix\*\* \| _no reason given_ \| — \|/);
  });

  it('omits the dismissed section when nothing was dismissed', () => {
    const md = formatReviewComment({ summary: 'x', score: 5, risk_level: 'LOW', issues: [], dismissed: [] });
    assert.equal(md.includes('Marked not an issue'), false);
  });

  it('escapes pipes and newlines so a reason cannot break the dismissed table', () => {
    const md = formatReviewComment({
      summary: 'x',
      score: 5,
      risk_level: 'LOW',
      issues: [],
      dismissed: [{ id: 1, title: 'a | b', file: 'c.js', label: 'By design', reason: 'one | two\nthree' }],
    });
    const row = md.split('\n').find((line) => line.includes('~~a '));
    // 5 segments = the 5 table cells; an unescaped pipe would split into more.
    assert.equal(row.split(' | ').length, 5);
    assert.match(row, /one \\\| two three/);
  });

  it('escapes HTML in issue titles', () => {
    const md = formatReviewComment({
      summary: 'x',
      score: 1,
      risk_level: 'HIGH',
      issues: [
        {
          id: 1,
          severity: 'HIGH',
          category: 'BUG',
          file: 'a.js',
          title: '</summary><script>',
          status: 'new',
          description: '<b>nope</b>',
          fix: 'ok',
        },
      ],
    });
    assert.equal(md.includes('</summary><script>'), false);
    assert.match(md, /&lt;\/summary&gt;/);
    assert.match(md, /&lt;b&gt;nope&lt;\/b&gt;/);
  });
});

describe('badge helpers', () => {
  it('escapes shields.io separators', () => {
    assert.equal(shieldEscape('foo-bar_baz qux'), 'foo--bar__baz_qux');
  });

  it('builds a shields URL', () => {
    assert.match(badge('Risk', 'HIGH', 'e0823d'), /img\.shields\.io\/badge/);
  });

  it('maps scores to colors', () => {
    assert.equal(scoreColor(4.5), '2ea043');
    assert.equal(scoreColor(1), 'da3633');
  });

  it('renders a progress bar of fixed width', () => {
    assert.equal(progressBar(5).length, 10);
    assert.equal(progressBar(0), '░░░░░░░░░░');
  });
});

describe('collect-context helpers', () => {
  it('decodes the sticky payload', () => {
    const payload = { head_sha: 'abc', issues: [] };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const body = `comment\n<!-- inspector-g-data ${encoded} -->`;
    assert.deepEqual(extractPayload(body), payload);
  });

  it('extracts the title from an inline comment', () => {
    assert.equal(titleFromInline('🔴 **HIGH: Auth bypass**\n\nFix: nope'), 'Auth bypass');
  });

  it('detects bot logins', () => {
    assert.equal(isBotLogin('github-actions[bot]'), true);
    assert.equal(isBotLogin('human'), false);
  });
});

describe('extractReviewJson', () => {
  it('returns refusal when Claude refuses', () => {
    assert.deepEqual(extractReviewJson({ stop_reason: 'refusal' }), { kind: 'refusal' });
  });

  it('parses a fenced JSON payload', () => {
    const result = extractReviewJson({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '```json\n{"score": 4}\n```' }],
    });
    assert.equal(result.kind, 'ok');
    assert.equal(result.review.score, 4);
  });

  it('returns max_tokens when JSON is truncated', () => {
    const result = extractReviewJson({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"score":' }],
    });
    assert.equal(result.kind, 'max_tokens');
  });

  it('parses JSON that has a preamble before the object', () => {
    const result = extractReviewJson({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Here you go\n{"score": 4, "issues": []}' }],
    });
    assert.equal(result.kind, 'ok');
    assert.equal(result.review.score, 4);
  });
});

describe('requestReview', () => {
  it('retries 429 then returns the JSON body, sending a json_schema', async () => {
    let calls = 0;
    let schemaSent = false;
    const fetchImpl = async (_url, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      schemaSent = body.output_config?.format?.type === 'json_schema';
      if (calls === 1) {
        return { ok: false, status: 429, text: async () => 'slow down' };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'msg' }) };
    };
    const data = await requestReview({
      apiKey: 'k',
      systemPrompt: 's',
      userPrompt: 'u',
      fetchImpl,
      waitImpl: async () => {},
    });
    assert.equal(calls, 2);
    assert.equal(schemaSent, true);
    assert.equal(data.id, 'msg');
  });

  it('reviews on Sonnet 5.5 at high effort with refusal fallback on', async () => {
    let sent;
    const fetchImpl = async (_url, options) => {
      sent = options;
      return { ok: true, status: 200, json: async () => ({ id: 'msg' }) };
    };
    await requestReview({ apiKey: 'k', systemPrompt: 's', userPrompt: 'u', fetchImpl });
    const body = JSON.parse(sent.body);
    assert.equal(body.model, 'claude-sonnet-5-5');
    assert.equal(body.output_config.effort, 'high');
    assert.equal(body.fallbacks, 'default');
    assert.equal(sent.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  });
});

describe('buildUserPrompt', () => {
  it('frames the diff as the complete PR and includes dismissals', () => {
    const prompt = buildUserPrompt({
      prTitle: 'Fix auth',
      assembled: { mode: 'full', truncated: true, text: 'diff here' },
      previous: { issues: [{ title: 'old' }] },
      dismissals: [{ title: 'nope', file: 'a.js' }],
      maxChars: 12,
    });
    assert.match(prompt, /COMPLETE pull request as it stands now/);
    assert.match(prompt, /Previous Inspector G findings/);
    assert.match(prompt, /Human dismissals/);
    assert.match(prompt, /truncated to fit 12 characters/);
    assert.match(prompt, /Diff \(complete pull request, new-file line numbers/);
  });
});

describe('post-comment helpers', () => {
  const issue = {
    severity: 'HIGH',
    category: 'BUG',
    file: 'a.js',
    line_reference: 'L3',
    title: 'Crash',
    status: 'new',
    failure_mode: 'It throws.',
    fix: 'Catch it.',
  };

  it('posts inline comments for uncovered issues down to MEDIUM', () => {
    const selected = selectMustFixIssues(
      {
        issues: [
          issue,
          { ...issue, title: 'Already discussed', line_reference: 'L4' },
          { ...issue, title: 'Dismissed', line_reference: 'L5' },
          { ...issue, severity: 'MEDIUM', title: 'Advisory', line_reference: 'L6' },
          { ...issue, severity: 'LOW', title: 'Nitpick', line_reference: 'L8' },
          { ...issue, status: 'resolved', title: 'Fixed', line_reference: 'L7' },
        ],
      },
      {
        keep_inline: [{ file: 'a.js', title: 'Already discussed' }],
        dismissals: [{ file: 'a.js', title: 'Dismissed' }],
      }
    );
    assert.deepEqual(selected.map((item) => item.title), ['Crash', 'Advisory']);
  });

  it('skips carried-forward issues whose line reference is from an older commit', () => {
    const selected = selectMustFixIssues(
      {
        issues: [issue, { ...issue, title: 'Stale anchor', line_reference: 'L99', carried_forward: true }],
      },
      { keep_inline: [], dismissals: [] }
    );
    assert.deepEqual(selected.map((item) => item.title), ['Crash']);
  });

  it('notes a carried-forward finding and survives missing detail', () => {
    const md = formatReviewComment({
      summary: 'Carried over',
      score: 3,
      risk_level: 'CRITICAL',
      run_count: 5,
      issues: [
        {
          id: 2,
          severity: 'CRITICAL',
          category: 'SECURITY',
          file: 'a.js',
          line_reference: 'L1',
          title: 'Auth bypass',
          status: 'still_open',
          carried_forward: true,
        },
      ],
    });
    assert.match(md, /carried forward/);
    assert.match(md, /silence is not evidence it was fixed/);
    // Detail was compacted out of the checkpoint: say so rather than
    // rendering an empty "What's wrong" section.
    assert.match(md, /Detail for this finding was dropped/);
    assert.equal(md.includes('undefined'), false);
    assert.equal(/\*\*What's wrong\*\*\s*\n\s*\n\s*\*\*/.test(md), false);
  });

  it('builds an inline comment with the marker and id', () => {
    const body = inlineCommentBody({ ...issue, id: 3 });
    assert.match(body, /\*\*HIGH: 3\. Crash\*\*/);
    assert.match(body, /<!-- inspector-g-id: 3 -->/);
    assert.match(body, /Failure mode/);
    assert.match(body, /<!-- claude-inline-review -->/);
  });

  it('shortens the review, not the data, when the comment would exceed the limit', () => {
    const hugeReview = 'x'.repeat(70_000);
    const visibleBody = `${STICKY_MARKER}\n${hugeReview}`;
    const payload = {
      issues: compactIssuesForTest([{ title: 'Crash', description: 'y'.repeat(400) }]),
    };
    const body = buildCommentBody({
      visibleBody,
      payload,
      sourceIssues: [{ title: 'Crash', description: 'y'.repeat(400) }],
    });
    assert.equal(body.includes('inspector-g-data'), true);
    assert.match(body, /Review shortened to fit/);
    assert.ok(body.length <= 65_000);
    assert.equal(body.startsWith(STICKY_MARKER), true);
  });
});

function compactIssuesForTest(issues) {
  return issues.map((issue) => ({
    severity: 'HIGH',
    category: 'BUG',
    file: 'a.js',
    line_reference: 'L1',
    title: issue.title,
    status: 'new',
    description: issue.description,
  }));
}

describe('finding limit', () => {
  it('does not cap how many new findings a review may raise', () => {
    assert.doesNotMatch(SYSTEM_PROMPT, /at most \d+ NEW issues/i);
    assert.match(SYSTEM_PROMPT, /no limit on how many/);
  });
});
