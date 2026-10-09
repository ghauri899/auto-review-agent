'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DISMISS_RE, REPLY_MARKER, INLINE_MARKER } = require('../src/constants');
const { formatReviewComment, findingUrl, jobSummary, diagramBlock } = require('../src/format-comment');
const {
  closingNotes,
  threadUrls,
  syncInlineComments,
  annotationsFor,
  publishRunSummary,
} = require('../src/post-comment');
const { titleFromInline } = require('../src/collect-context');

const ENV = { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'acme/app' };
const SHA = 'abc1234def5678';
const LINKS = { server: 'https://github.com', repo: 'acme/app', headSha: SHA };

function finding(severity, extra = {}) {
  return {
    id: 1,
    severity,
    category: 'correctness',
    title: `${severity} finding`,
    file: 'src/a.js',
    line_reference: 'L10',
    status: 'new',
    failure_mode: 'Breaks when the cache is empty.',
    description: 'Long explanation.',
    fix: 'Check for empty.',
    ...extra,
  };
}

describe('findingUrl', () => {
  it('links the cited range at the reviewed commit', () => {
    assert.equal(
      findingUrl(finding('HIGH', { line_reference: 'L10-L14' }), LINKS),
      `https://github.com/acme/app/blob/${SHA}/src/a.js#L10-L14`
    );
    assert.equal(findingUrl(finding('HIGH'), LINKS), `https://github.com/acme/app/blob/${SHA}/src/a.js#L10`);
  });

  it('links only the file for a carried-forward finding, whose lines are from an older commit', () => {
    assert.equal(
      findingUrl(finding('HIGH', { carried_forward: true }), LINKS),
      `https://github.com/acme/app/blob/${SHA}/src/a.js`
    );
  });

  it('encodes path segments and gives up without repo details', () => {
    assert.match(findingUrl(finding('LOW', { file: 'src/my file#1.js' }), LINKS), /src\/my%20file%231\.js#L10$/);
    assert.equal(findingUrl(finding('LOW'), null), '');
  });
});

describe('formatReviewComment with inline threads', () => {
  const review = {
    summary: { verdict: 'Needs work', context: '' },
    score: 2,
    risk_level: 'CRITICAL',
    run_count: 1,
    issues: [
      finding('CRITICAL', { id: 1, suggestion: { line_reference: 'L10', code: 'fixed();' } }),
      finding('HIGH', { id: 2, title: 'No thread for this one' }),
      finding('LOW', { id: 3, title: 'Tiny nit' }),
    ],
  };
  const threads = new Map([[1, 'https://github.com/acme/app/pull/7#discussion_r11']]);
  const md = formatReviewComment(review, { env: ENV, headSha: SHA, threads });

  it('collapses a finding with a thread to one row linking the thread and the line', () => {
    assert.match(md, /- 🔴 <b>1\. CRITICAL finding<\/b> · <a href="[^"]+#L10"><code>src\/a\.js:L10<\/code><\/a> · new · ✨ one-click fix · <a href="https:\/\/github\.com\/acme\/app\/pull\/7#discussion_r11">💬 details &amp; fix<\/a><br><sub>Breaks when the cache is empty\.<\/sub>/);
    assert.equal(md.includes('1. CRITICAL finding</b> &nbsp;'), false, 'no full card for a threaded finding');
  });

  it('keeps full cards for findings without a thread', () => {
    assert.match(md, /<summary>🟠 <b>2\. No thread for this one<\/b>/);
    assert.match(md, /<summary>🔵 <b>3\. Tiny nit<\/b>/);
  });

  it('points the alert at the thread', () => {
    assert.match(md, /Open \*\*details & fix\*\*/);
  });

  it('uses the severity marks for risk too', () => {
    assert.match(md, /> \*\*🔴 Needs work\*\*/);
    assert.match(md, /### 💡 Advisory Issues/);
  });

  it('renders every finding as a card when no thread links are known', () => {
    const plain = formatReviewComment(review, { env: ENV, headSha: SHA });
    assert.match(plain, /<summary>🔴 <b>1\. CRITICAL finding<\/b>/);
  });
});

describe('diagramBlock', () => {
  const diagram = 'flowchart LR\n a["A"] --> b["B"]';
  it('is left out for a change across fewer than three files', () => {
    assert.equal(diagramBlock(diagram, { files: [{ file: 'a', change: 'x' }, { file: 'b', change: 'y' }] }), '');
  });
  it('renders for three or more files, or when there is no walkthrough to count', () => {
    const files = ['a', 'b', 'c'].map((file) => ({ file, change: 'x' }));
    assert.match(diagramBlock(diagram, { files }), /```mermaid/);
    assert.match(diagramBlock(diagram), /```mermaid/);
  });
});

describe('closingNotes', () => {
  const notes = closingNotes(
    {
      resolved: [{ id: 4, title: 'Fixed thing' }],
      dismissed: [{ id: 5, title: 'Noise', label: 'Dismissed', by: 'octocat' }],
    },
    SHA
  );

  it('says when a finding stopped appearing, and who closed a dismissed one', () => {
    assert.match(notes.get(4), /Resolved\*\* — as of `abc1234`/);
    assert.match(notes.get(5), /marked as \*Dismissed\* by @octocat/);
  });

  it('marks every reply so it is never read as a reviewer dismissing the finding', () => {
    for (const body of notes.values()) assert.ok(body.includes(REPLY_MARKER));
    assert.equal(DISMISS_RE.test(notes.get(4)), false);
  });
});

describe('titleFromInline', () => {
  it('reads MEDIUM comments and drops the number', () => {
    assert.equal(titleFromInline('🟡 **MEDIUM: 7. Slow loop**'), 'Slow loop');
  });
});

const BOT = { type: 'Bot', login: 'github-actions[bot]' };
function botComment(id, issueId, extra = {}) {
  return {
    id,
    user: BOT,
    path: 'src/a.js',
    line: 10,
    html_url: `https://github.com/acme/app/pull/7#discussion_r${id}`,
    body: `🟠 **HIGH: ${issueId}. x**\n\n<!-- inspector-g-id: ${issueId} -->\n\n${INLINE_MARKER}`,
    ...extra,
  };
}

function fakeGithub({ comments, threads }) {
  const calls = { replies: [], resolved: [], deleted: [], reviews: [] };
  let listed = comments;
  const github = {
    paginate: async () => listed,
    rest: {
      pulls: {
        listReviewComments: 'listReviewComments',
        createReplyForReviewComment: async (args) => calls.replies.push(args),
        deleteReviewComment: async (args) => calls.deleted.push(args.comment_id),
        createReview: async (args) => {
          calls.reviews.push(args);
          listed = [...listed, ...args.comments.map((c, i) => botComment(900 + i, 2, { body: c.body }))];
        },
        createReviewComment: async () => {},
      },
    },
    graphql: async (query, vars) => {
      if (query.includes('resolveReviewThread')) {
        calls.resolved.push(vars.id);
        return {};
      }
      return {
        repository: {
          pullRequest: {
            reviewThreads: { pageInfo: { hasNextPage: false }, nodes: threads },
          },
        },
      };
    },
  };
  return { github, calls };
}

const CONTEXT = {
  repo: { owner: 'acme', repo: 'app' },
  issue: { number: 7 },
  payload: { pull_request: { head: { sha: SHA } } },
};

describe('syncInlineComments', () => {
  it('replies to and resolves the thread of a fixed finding instead of deleting it', async () => {
    const { github, calls } = fakeGithub({
      comments: [botComment(11, 4)],
      threads: [{ id: 'T11', isResolved: false, comments: { nodes: [{ databaseId: 11, body: '' }] } }],
    });
    await syncInlineComments({
      github,
      context: CONTEXT,
      parsedReview: { issues: [], resolved: [{ id: 4, title: 'x' }] },
      reviewContext: {},
    });
    assert.equal(calls.replies.length, 1);
    assert.equal(calls.replies[0].comment_id, 11);
    assert.deepEqual(calls.resolved, ['T11']);
    assert.deepEqual(calls.deleted, []);
  });

  it('does not reply twice: a resolved thread, or one already answered, is left alone', async () => {
    const { github, calls } = fakeGithub({
      comments: [botComment(11, 4), botComment(12, 5)],
      threads: [
        { id: 'T11', isResolved: true, comments: { nodes: [{ databaseId: 11, body: '' }] } },
        { id: 'T12', isResolved: false, comments: { nodes: [{ databaseId: 12, body: '' }, { databaseId: 13, body: REPLY_MARKER }] } },
      ],
    });
    await syncInlineComments({
      github,
      context: CONTEXT,
      parsedReview: { issues: [], resolved: [{ id: 4 }, { id: 5 }] },
      reviewContext: {},
    });
    assert.equal(calls.replies.length, 0);
    assert.deepEqual(calls.resolved, ['T12']);
  });

  it('leaves threads untouched when they cannot be listed', async () => {
    const { github, calls } = fakeGithub({ comments: [botComment(11, 4)], threads: [] });
    github.graphql = async () => {
      throw new Error('forbidden');
    };
    await syncInlineComments({
      github,
      context: CONTEXT,
      parsedReview: { issues: [], resolved: [{ id: 4 }] },
      reviewContext: {},
    });
    assert.equal(calls.replies.length, 0);
    assert.deepEqual(calls.deleted, []);
  });

  it('returns thread links for open findings, including ones posted this run', async () => {
    const { github, calls } = fakeGithub({ comments: [], threads: [] });
    const urls = await syncInlineComments({
      github,
      context: CONTEXT,
      parsedReview: { issues: [finding('HIGH', { id: 2, anchor: { line: 10 } })], resolved: [] },
      reviewContext: {},
    });
    assert.equal(calls.reviews.length, 1);
    assert.equal(urls.get(2), 'https://github.com/acme/app/pull/7#discussion_r900');
  });
});

describe('threadUrls', () => {
  it('maps only bot inline comments for open findings', () => {
    const urls = threadUrls(
      [botComment(1, 1), botComment(2, 2), { ...botComment(3, 1), user: { type: 'User' } }],
      new Set([1])
    );
    assert.deepEqual([...urls.entries()], [[1, 'https://github.com/acme/app/pull/7#discussion_r1']]);
  });
});

describe('annotationsFor', () => {
  it('annotates findings without a thread, by severity, at their lines', () => {
    const review = {
      issues: [
        finding('CRITICAL', { id: 1 }),
        finding('MEDIUM', { id: 2, line_reference: 'L3-L5' }),
        finding('LOW', { id: 3, carried_forward: true }),
      ],
    };
    const annotations = annotationsFor(review, new Map([[1, 'url']]));
    assert.deepEqual(
      annotations.map((a) => [a.level, a.properties.file, a.properties.startLine, a.properties.endLine]),
      [
        ['warning', 'src/a.js', 3, 5],
        ['notice', 'src/a.js', undefined, undefined],
      ]
    );
    assert.equal(annotations[0].properties.title, 'Inspector G · 2. MEDIUM finding');
  });

  it('stops at GitHub’s per-level limit', () => {
    const issues = Array.from({ length: 14 }, (_, i) => finding('HIGH', { id: i + 1 }));
    assert.equal(annotationsFor({ issues }, new Map()).length, 10);
  });
});

describe('publishRunSummary', () => {
  it('writes annotations and a summary table, and skips quietly without core', async () => {
    const seen = [];
    const core = {
      error: (message, props) => seen.push(['error', props.file]),
      warning: () => {},
      notice: () => {},
      summary: {
        text: '',
        addRaw(md) {
          this.text += md;
          return this;
        },
        async write() {},
      },
    };
    const review = { score: 3, risk_level: 'HIGH', issues: [finding('HIGH', { id: 9 })] };
    await publishRunSummary({ core, review, threads: new Map(), env: ENV, headSha: SHA });
    assert.deepEqual(seen, [['error', 'src/a.js']]);
    assert.match(core.summary.text, /## 🚫 Not ready to merge — 1 blocker/);
    assert.match(core.summary.text, /\| 🟠 \| 9\. HIGH finding \|/);
    await publishRunSummary({ core: null, review, threads: new Map(), env: ENV, headSha: SHA });
  });

  it('jobSummary links each finding to its thread', () => {
    const md = jobSummary(
      { issues: [finding('HIGH', { id: 9 })] },
      { env: ENV, headSha: SHA, threads: new Map([[9, 'https://t']]) }
    );
    assert.match(md, /<a href="https:\/\/t">💬<\/a>/);
  });
});
