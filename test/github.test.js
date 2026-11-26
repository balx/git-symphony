import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepo, areaFromSubject, toCommits, fetchRepo } from '../src/github.js';

test('repository input in any common form', () => {
  for (const s of ['git/git', ' git/git ', 'github.com/git/git', 'https://github.com/git/git', 'https://www.github.com/git/git.git', 'git@github.com:git/git.git', 'https://github.com/git/git/'])
    assert.deepEqual(parseRepo(s), { owner: 'git', repo: 'git' }, s);
  assert.deepEqual(parseRepo('vercel/next.js'), { owner: 'vercel', repo: 'next.js' });
  for (const s of ['', 'git', 'https://gitlab.com/a/b', 'a/b/c']) assert.throws(() => parseRepo(s), /not a GitHub repository/, s);
});

test('area comes from the subject prefix', () => {
  assert.equal(areaFromSubject('builtin/add: fix'), 'builtin');
  assert.equal(areaFromSubject('feat(router): add x'), 'router');
  assert.equal(areaFromSubject('fix!: breaking'), 'fix');
  assert.equal(areaFromSubject('deps: body-parser@2'), 'deps');
  assert.equal(areaFromSubject('Fix the thing: again'), '');
  assert.equal(areaFromSubject('Merge branch x'), '');
});

const node = (i, extra = {}) => ({
  oid: `c${i}`, committedDate: new Date(Date.UTC(2020, 0, 1 + i)).toISOString(), messageHeadline: `m${i}`,
  additions: i, deletions: 1, parents: { totalCount: 1 }, author: { name: 'Ada', user: { login: 'ada' } }, ...extra,
});

test('nodes become commits: oldest first, merges dropped, people grouped by login', () => {
  const commits = toCommits([
    node(3, { author: { name: 'Ada L', user: { login: 'ada' } } }),
    node(2, { parents: { totalCount: 2 } }),
    node(1),
    node(0, { author: { name: 'bob', user: null } }),
  ]);
  assert.deepEqual(commits.map((c) => c.hash), ['c0', 'c1', 'c3']);
  assert.deepEqual(commits.map((c) => c.author), ['bob', 'Ada', 'Ada']); // most used name for the login
  assert.equal(commits[1].size, 2);
  assert.equal(commits[0].time, Date.UTC(2020, 0, 1) / 1000);
});

test('fetchRepo pages history in parallel by offset and follows tag pages', async () => {
  const total = 250, all = Array.from({ length: total }, (_, i) => node(total - 1 - i)); // newest first, like the API
  const seen = [];
  const fake = async (url, { body }) => {
    const { query, variables } = JSON.parse(body);
    const json = (data) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ data }) });
    const tag = (name, date) => ({ name, target: { __typename: 'Commit', committedDate: date } });
    if (query.includes('defaultBranchRef'))
      return json({ repository: { name: 'r', defaultBranchRef: { target: { oid: 'HEAD', history: { totalCount: total, nodes: all.slice(0, 100) } } },
        refs: { pageInfo: { endCursor: 't1', hasNextPage: true }, nodes: [tag('v1.0.0', '2020-02-01T00:00:00Z')] } } });
    if (query.includes('object(oid')) {
      const [head, last] = variables.after.split(' ');
      assert.equal(head, 'HEAD');
      seen.push(+last);
      return json({ repository: { object: { history: { nodes: all.slice(+last + 1, +last + 101) } } } });
    }
    assert.equal(variables.after, 't1');
    return json({ repository: { refs: { pageInfo: { hasNextPage: false }, nodes: [tag('v2.0.0', '2020-05-01T00:00:00Z')] } } });
  };
  const progress = [];
  const repo = await fetchRepo('https://github.com/o/r', 'tok', { fetch: fake, onProgress: (p) => progress.push(p.done) });
  assert.deepEqual(seen.sort((a, b) => a - b), [99, 199]);
  assert.equal(repo.commits.length, total);
  assert.deepEqual(repo.commits.map((c) => c.hash), all.map((n) => n.oid).reverse());
  assert.deepEqual(repo.tags.map((t) => t.name), ['v1.0.0', 'v2.0.0']);
  assert.equal(progress.at(-1), total);
  assert.equal(repo.head, 'HEAD');

  seen.length = 0;
  const again = await fetchRepo('o/r', 'tok', { fetch: fake, cached: repo });
  assert.equal(again, repo); // branch has not moved: no history pages fetched
  assert.equal(seen.length, 0);
});

test('fetchRepo needs a token', async () => {
  await assert.rejects(fetchRepo('o/r', ''), /token/);
});
