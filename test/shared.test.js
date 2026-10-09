'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  titlesEqual,
  issueKey,
  isDismissed,
  compactIssues,
  parseLineRef,
  parseNumberedDismissal,
  parseNumberedDismissals,
  extractPayload,
  encodePayload,
  assignIssueIds,
  cleanDismissReason,
  dismissLabel,
  collectDismissed,
  redactSecrets,
  escapeHtml,
  upsertPrBody,
  isCheckpointComment,
} = require('../src/shared');
const { DISMISS_RE, STICKY_MARKER, BODY_START, BODY_END } = require('../src/constants');

describe('titlesEqual', () => {
  it('matches equivalent titles ignoring punctuation and case', () => {
    assert.equal(titlesEqual('SQL Injection in /users', 'sql injection in users'), true);
  });

  it('does not match when one title merely contains the other', () => {
    assert.equal(titlesEqual('SQL injection in login handler', 'SQL injection'), false);
  });

  it('rejects unrelated titles', () => {
    assert.equal(titlesEqual('SQL injection', 'XSS in profile'), false);
  });

  it('rejects empty titles', () => {
    assert.equal(titlesEqual('', 'anything'), false);
    assert.equal(titlesEqual('anything', null), false);
  });
});

describe('issueKey / isDismissed', () => {
  it('keys file+title case-insensitively', () => {
    assert.equal(issueKey('Src/App.js', '  SQL   Injection  '), 'src/app.js::sql injection');
  });

  it('treats a same-file equal title as dismissed', () => {
    const issue = { file: 'api/auth.js', title: 'Auth bypass via missing check' };
    const dismissals = [{ file: 'api/auth.js', title: 'auth bypass via missing check' }];
    assert.equal(isDismissed(issue, dismissals), true);
  });

  it('dismisses by numeric id even if the title changed', () => {
    const issue = { id: 3, file: 'api/auth.js', title: 'Auth bypass rewritten' };
    const dismissals = [{ id: 3, file: 'api/auth.js', title: 'Auth bypass' }];
    assert.equal(isDismissed(issue, dismissals), true);
  });

  it('does not dismiss a different file', () => {
    const issue = { file: 'api/auth.js', title: 'Auth bypass' };
    const dismissals = [{ file: 'api/other.js', title: 'Auth bypass' }];
    assert.equal(isDismissed(issue, dismissals), false);
  });
});

describe('parseNumberedDismissal', () => {
  it('parses “3. this one is false positive because …”', () => {
    const parsed = parseNumberedDismissal('3. this one is false positive because we validate at the gateway');
    assert.equal(parsed.id, 3);
    assert.match(parsed.reply, /validate at the gateway/);
  });

  it('rejects a numbered comment without a dismiss phrase', () => {
    assert.equal(parseNumberedDismissal('3. please explain this finding'), null);
  });

  it('rejects a dismiss phrase that is not numbered', () => {
    assert.equal(parseNumberedDismissal('this is a false positive'), null);
  });

  it('parses every numbered item in one comment', () => {
    const body = [
      '1. false positive because the ledger join is an `INNER JOIN`: rows are excluded.',
      '2. by design because the statement only appends to the ENUM.',
      '3. please explain this one',
      '4. by design because `umar/feat/better-structure` is the current branch.',
    ].join('\n');
    const parsed = parseNumberedDismissals(body);
    assert.deepEqual(
      parsed.map((item) => item.id),
      [1, 2, 4]
    );
    assert.match(parsed[1].reply, /appends to the ENUM/);
  });

  it('accepts "3)" and "#3" numbering', () => {
    assert.equal(parseNumberedDismissals('3) not a bug, handled upstream')[0].id, 3);
    assert.equal(parseNumberedDismissals("#7 won't fix for now")[0].id, 7);
  });
});

describe('extractPayload', () => {
  it('uses the last inspector-g-data blob when several are present', () => {
    const fake = encodePayload({ head_sha: 'evil', issues: [] });
    const real = encodePayload({ head_sha: 'abc', issues: [{ id: 1, title: 'Crash' }] });
    const body = `<!-- inspector-g-data ${fake} -->\nreview\n<!-- inspector-g-data ${real} -->`;
    assert.equal(extractPayload(body).head_sha, 'abc');
    assert.equal(extractPayload(body).issues[0].id, 1);
  });
});

describe('assignIssueIds', () => {
  it('reuses previous ids and assigns the next number to new findings', () => {
    const assigned = assignIssueIds(
      [
        { file: 'a.js', title: 'Crash', status: 'still_open' },
        { file: 'b.js', title: 'New leak', status: 'new' },
      ],
      { issues: [{ id: 2, file: 'a.js', title: 'Crash', status: 'new' }], next_id: 3 }
    );
    assert.equal(assigned.issues[0].id, 2);
    assert.equal(assigned.issues[1].id, 3);
    assert.equal(assigned.next_id, 4);
  });

  it('re-attaches a previous id when Claude paraphrases the title', () => {
    const assigned = assignIssueIds(
      [{ file: 'a.js', title: 'SQL injection in the login handler query', status: 'still_open' }],
      { issues: [{ id: 4, file: 'a.js', title: 'SQL injection in login handler', status: 'new' }] }
    );
    assert.equal(assigned.issues[0].id, 4);
  });

  it('accumulates previously resolved findings and newly resolved ones', () => {
    const assigned = assignIssueIds(
      [{ id: 1, file: 'a.js', title: 'Crash', status: 'resolved' }],
      {
        issues: [
          { id: 1, file: 'a.js', title: 'Crash', status: 'still_open' },
          { id: 2, file: 'b.js', title: 'Leak', status: 'still_open' },
        ],
        resolved: [{ id: 9, file: 'old.js', title: 'Ancient' }],
      }
    );
    const ids = assigned.resolved.map((item) => item.id).sort((a, b) => a - b);
    // 2 was never mentioned this run, so it stays open rather than silently resolving.
    assert.deepEqual(ids, [1, 9]);
    assert.deepEqual(
      assigned.issues.filter((issue) => issue.status !== 'resolved').map((issue) => issue.id),
      [2]
    );
  });

  it('carries an unmentioned open finding forward instead of resolving it', () => {
    const assigned = assignIssueIds(
      [{ file: 'new.js', title: 'Fresh bug', status: 'new' }],
      {
        issues: [
          { id: 4, file: 'b.js', title: 'Leak', status: 'still_open', severity: 'CRITICAL' },
          { id: 5, file: 'c.js', title: 'Race', status: 'new', severity: 'HIGH' },
        ],
        next_id: 6,
      }
    );
    assert.equal(assigned.carried_forward, 2);
    assert.deepEqual(assigned.resolved, []);
    const carried = assigned.issues.filter((issue) => [4, 5].includes(issue.id));
    assert.equal(carried.length, 2);
    // Carried-forward findings are open, and keep the severity the ledger recorded.
    assert.deepEqual(carried.map((issue) => issue.status), ['still_open', 'still_open']);
    assert.deepEqual(carried.map((issue) => issue.severity), ['CRITICAL', 'HIGH']);
  });

  it('still closes a finding Claude explicitly marks resolved', () => {
    const assigned = assignIssueIds([{ id: 4, file: 'b.js', title: 'Leak', status: 'resolved' }], {
      issues: [{ id: 4, file: 'b.js', title: 'Leak', status: 'still_open' }],
    });
    assert.equal(assigned.carried_forward, 0);
    assert.deepEqual(assigned.resolved.map((item) => item.id), [4]);
    assert.deepEqual(assigned.issues.filter((issue) => issue.status !== 'resolved'), []);
  });

  it('keeps a null id null instead of numbering carried-forward findings "0"', () => {
    const assigned = assignIssueIds([], {
      issues: [
        { id: null, file: 'a.js', title: 'Nameless one', status: 'still_open' },
        { file: 'b.js', title: 'Nameless two', status: 'still_open' },
      ],
    });
    assert.equal(assigned.carried_forward, 2);
    // Number(null) is 0 and finite — two id-less findings must not both
    // become "0." and collide for numbered dismissal.
    assert.deepEqual(assigned.issues.map((issue) => issue.id), [null, null]);
  });

  it('resolves an unmentioned finding whose file left the PR diff', () => {
    const assigned = assignIssueIds(
      [],
      { issues: [{ id: 1, file: 'Reverted.js', title: 'Gone', status: 'still_open' }] },
      [],
      { prFiles: new Set(['kept.js']) }
    );
    assert.equal(assigned.carried_forward, 0);
    assert.deepEqual(assigned.resolved.map((item) => item.id), [1]);
  });

  it('keeps carrying a finding whose file is still in the PR diff', () => {
    const assigned = assignIssueIds(
      [],
      { issues: [{ id: 1, file: 'Kept.js', title: 'Here', status: 'still_open' }] },
      [],
      { prFiles: new Set(['kept.js']) }
    );
    assert.equal(assigned.carried_forward, 1);
    assert.deepEqual(assigned.resolved, []);
  });

  it('resolves rather than carries when carry-forward is disabled', () => {
    const assigned = assignIssueIds([], { issues: [{ id: 1, file: 'a.js', title: 'x', status: 'still_open' }] }, [], {
      carryForwardUnmentioned: false,
    });
    assert.equal(assigned.carried_forward, 0);
    assert.deepEqual(assigned.resolved.map((item) => item.id), [1]);
  });

  it('does not carry forward a finding a human dismissed', () => {
    const assigned = assignIssueIds(
      [],
      { issues: [{ id: 7, file: 'b.js', title: 'Leak', status: 'still_open' }] },
      [{ id: 7, file: 'b.js', title: 'Leak' }]
    );
    assert.equal(assigned.carried_forward, 0);
    assert.deepEqual(assigned.issues, []);
    assert.deepEqual(assigned.resolved, []);
  });
});

describe('dismissLabel / cleanDismissReason', () => {
  for (const [reply, label] of [
    ['false positive, the gateway validates this', 'False positive'],
    ["won't fix before the v2 rewrite", "Won't fix"],
    ['this is by design', 'By design'],
    ['works as intended', 'By design'],
    ['not a bug, the caller guards it', 'Not a bug'],
    ['not applicable to this service', 'Not applicable'],
    ['ignore this', 'Dismissed'],
  ]) {
    it(`labels “${reply}” as ${label}`, () => {
      assert.equal(dismissLabel(reply), label);
    });
  }

  it('strips the leading issue number and collapses whitespace', () => {
    assert.equal(cleanDismissReason('3.  false positive\n  we validate upstream'), 'false positive we validate upstream');
    assert.equal(cleanDismissReason('#7) by design'), 'by design');
  });

  it('drops html comment markers so inline markup never leaks into the table', () => {
    assert.equal(cleanDismissReason('by design <!-- claude-inline-review -->'), 'by design');
  });
});

describe('collectDismissed', () => {
  it('fills in title, file, and severity from the issue the dismissal points at', () => {
    const dismissed = collectDismissed({
      previous: { issues: [{ id: 3, file: 'api/auth.js', title: 'Auth bypass', severity: 'HIGH' }] },
      dismissals: [{ id: 3, reply: '3. false positive, gateway validates', by: 'octocat' }],
    });
    assert.deepEqual(dismissed, [
      {
        id: 3,
        title: 'Auth bypass',
        file: 'api/auth.js',
        severity: 'HIGH',
        label: 'False positive',
        reason: 'false positive, gateway validates',
        by: 'octocat',
      },
    ]);
  });

  it('carries forward earlier dismissals and keeps them ordered by id', () => {
    const dismissed = collectDismissed({
      previous: {
        dismissed: [{ id: 5, title: 'Old call', file: 'z.js', label: 'By design', reason: 'by design', by: 'ada' }],
      },
      dismissals: [{ id: 2, file: 'a.js', title: 'Newer', reply: 'not a bug' }],
    });
    assert.deepEqual(
      dismissed.map((item) => item.id),
      [2, 5]
    );
    assert.equal(dismissed[1].reason, 'by design');
    assert.equal(dismissed[1].by, 'ada');
  });

  it('keeps a dismissal with no matching issue rather than dropping it', () => {
    const dismissed = collectDismissed({ dismissals: [{ id: 9, reply: '9. false positive' }] });
    assert.deepEqual(dismissed, [
      { id: 9, title: '', file: '', severity: '', label: 'False positive', reason: 'false positive', by: '' },
    ]);
  });

  it('does not duplicate a dismissal that is re-collected with fresh metadata', () => {
    const dismissed = collectDismissed({
      previous: { dismissed: [{ id: 1, title: 'Race', file: 'a.js', reason: 'false positive' }] },
      dismissals: [{ id: 1, file: 'a.js', title: 'Race', reply: 'false positive, single threaded', by: 'lin' }],
    });
    assert.equal(dismissed.length, 1);
    assert.equal(dismissed[0].reason, 'false positive, single threaded');
    assert.equal(dismissed[0].by, 'lin');
  });
});

describe('redactSecrets / escapeHtml', () => {
  it('redacts private keys and GitHub tokens', () => {
    const raw = 'token ghp_abcdefghijklmnopqrstuv and -----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----';
    const redacted = redactSecrets(raw);
    assert.equal(redacted.includes('ghp_'), false);
    assert.match(redacted, /REDACTED TOKEN/);
    assert.match(redacted, /REDACTED PRIVATE KEY/);
  });

  it('escapes HTML in interpolated fields', () => {
    assert.equal(escapeHtml('<details>'), '&lt;details&gt;');
  });
});

describe('upsertPrBody', () => {
  it('appends a marked block and later replaces only that block', () => {
    const first = upsertPrBody('Author wrote this.', 'REVIEW', { start: BODY_START, end: BODY_END });
    assert.match(first, /^Author wrote this\./);
    assert.match(first, /<!-- inspector-g:end -->$/);
    const second = upsertPrBody(first, 'REVIEW 2', { start: BODY_START, end: BODY_END });
    assert.match(second, /REVIEW 2/);
    assert.equal(second.includes('REVIEW\n'), false);
    assert.match(second, /^Author wrote this\./);
  });

  it('keeps the author description on top, separated by a single divider', () => {
    const first = upsertPrBody('Author wrote this.', 'REVIEW', { start: BODY_START, end: BODY_END });
    assert.match(first, /Author wrote this\.\n\n<!-- inspector-g:start -->\n---\n\nREVIEW\n<!-- inspector-g:end -->/);
    const second = upsertPrBody(first, 'REVIEW 2', { start: BODY_START, end: BODY_END });
    assert.equal(second.match(/^---$/gm).length, 1);
  });

  it('drops the legacy author heading when migrating an older body', () => {
    const legacy = `${BODY_START}\nREVIEW\n\n---\n\n## 📝 Author's description\n\n${BODY_END}\n\nAuthor wrote this.`;
    const migrated = upsertPrBody(legacy, 'REVIEW 2', { start: BODY_START, end: BODY_END });
    assert.equal(migrated.includes("Author's description"), false);
    assert.match(migrated, /^Author wrote this\.\n\n<!-- inspector-g:start -->/);
  });

  it('omits the divider when the author wrote nothing', () => {
    const body = upsertPrBody('', 'REVIEW', { start: BODY_START, end: BODY_END });
    assert.equal(body, `${BODY_START}\nREVIEW\n${BODY_END}`);
  });
});

describe('isCheckpointComment', () => {
  it('accepts only bot comments that carry the sticky marker', () => {
    assert.equal(
      isCheckpointComment({ user: { login: 'github-actions[bot]' }, body: `${STICKY_MARKER}\nhi` }),
      true
    );
    assert.equal(
      isCheckpointComment({ user: { login: 'alice' }, body: `${STICKY_MARKER}\nhi` }),
      false
    );
    assert.equal(
      isCheckpointComment({
        user: { login: 'github-actions[bot]' },
        body: '### Inspector G — Automated Code Review',
      }),
      false
    );
  });
});

describe('parseLineRef', () => {
  it('parses a single line', () => {
    assert.deepEqual(parseLineRef('L42'), { line: 42 });
  });

  it('parses a range as start_line + line', () => {
    assert.deepEqual(parseLineRef('L42-L55'), { start_line: 42, start_side: 'RIGHT', line: 55 });
  });

  it('treats equal start/end as a single line', () => {
    assert.deepEqual(parseLineRef('L10-L10'), { line: 10 });
  });

  it('returns null for invalid refs', () => {
    assert.equal(parseLineRef('42'), null);
    assert.equal(parseLineRef(null), null);
  });
});

describe('compactIssues', () => {
  const issues = [
    {
      id: 4,
      severity: 'HIGH',
      category: 'BUG',
      file: 'a.js',
      line_reference: 'L1',
      title: 'Boom',
      status: 'new',
      description: 'x'.repeat(500),
      fix: 'do not include me',
    },
  ];

  it('keeps description, fix, and failure_mode in full form', () => {
    const [compact] = compactIssues(issues, true);
    assert.equal(compact.description.length, 500);
    assert.equal(compact.fix, 'do not include me');
    assert.equal(compact.failure_mode, null);
    assert.equal(compact.id, 4);
  });

  it('omits description and fix in compact form', () => {
    const [compact] = compactIssues(issues, false);
    assert.equal(compact.description, undefined);
    assert.equal(compact.fix, undefined);
  });
});

describe('DISMISS_RE', () => {
  for (const phrase of [
    'false positive',
    "won't fix",
    'won\u2019t fix',
    'will not fix',
    'wontfix',
    'by design',
    'not a bug',
    'dismissed',
    'no fix needed',
    'expected behavior',
    'works as intended',
  ]) {
    it(`matches “${phrase}”`, () => {
      assert.equal(DISMISS_RE.test(`this is a ${phrase}`), true);
    });
  }

  it('does not match unrelated replies', () => {
    assert.equal(DISMISS_RE.test('please explain this finding'), false);
    assert.equal(DISMISS_RE.test('this was not intentional'), false);
  });
});
