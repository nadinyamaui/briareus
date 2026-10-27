import fs from 'fs';
import os from 'os';
import path from 'path';
import util from 'util';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnvFile } from '../lib/config.js';
import { editEnvText, projectEnvRoutes } from '../lib/project-env.js';

describe('editEnvText', () => {
  it('replaces in place, appends new keys and keeps comments and order', () => {
    const text = '# app\nAPP_NAME=Old\nexport APP_DEBUG=false\n\n# db\nDB_HOST=127.0.0.1\n';
    expect(editEnvText(text, { set: { APP_DEBUG: 'true', MAIL_HOST: '"smtp.example.com"' } })).toBe(
      '# app\nAPP_NAME=Old\nAPP_DEBUG=true\n\n# db\nDB_HOST=127.0.0.1\nMAIL_HOST="smtp.example.com"\n',
    );
  });

  it('drops later duplicates of a set key and every line of an unset one', () => {
    expect(editEnvText('A=1\nB=2\nA=3\nB=4\nC=5', { set: { A: 'x' }, unset: ['B'] })).toBe('A=x\nC=5\n');
  });

  it('starts an empty template', () => {
    expect(editEnvText('', { set: { A: '1' } })).toBe('A=1\n');
  });

  it('leaves "\\n", not the unconfigured "", when every key is removed', () => {
    expect(editEnvText('OLD=secret\n', { unset: ['OLD'] })).toBe('\n');
  });

  it('treats a multi-line quoted value as one assignment', () => {
    const text = 'MESSAGE="first\nAPP_DEBUG=inside string\nlast"\nAPP_DEBUG=false\n';
    const edited = editEnvText(text, { set: { APP_DEBUG: 'true' } });
    expect(edited).toBe('MESSAGE="first\nAPP_DEBUG=inside string\nlast"\nAPP_DEBUG=true\n');
    expect(util.parseEnv(edited)).toEqual({
      MESSAGE: 'first\nAPP_DEBUG=inside string\nlast',
      APP_DEBUG: 'true',
    });

    const key = "A=1\nPRIVATE_KEY='-----BEGIN KEY-----\nabc\n-----END KEY-----'\nB=2\n";
    expect(editEnvText(key, { unset: ['PRIVATE_KEY'] })).toBe('A=1\nB=2\n');
    expect(editEnvText(key, { set: { PRIVATE_KEY: 'none' } })).toBe('A=1\nPRIVATE_KEY=none\nB=2\n');
    // A value never closed is read as its own line.
    expect(editEnvText('A="open\nB=1\n', { set: { B: '2' } })).toBe('A="open\nB=2\n');
  });

  it('closes a quoted value at its next quote, a backslash before it included, as Node does', () => {
    const text = 'PATH_WIN="C:\\temp\\"\nTOKEN=old\nOTHER="ok"\nTAIL=1\n';
    expect(Object.keys(util.parseEnv(text)).sort()).toEqual(['OTHER', 'PATH_WIN', 'TAIL', 'TOKEN']);
    const removed = editEnvText(text, { unset: ['TOKEN'] });
    expect(removed).toBe('PATH_WIN="C:\\temp\\"\nOTHER="ok"\nTAIL=1\n');
    expect(util.parseEnv(removed)).not.toHaveProperty('TOKEN');
    const replaced = editEnvText(text, { set: { PATH_WIN: 'new' } });
    expect(util.parseEnv(replaced)).toEqual({ PATH_WIN: 'new', TOKEN: 'old', OTHER: 'ok', TAIL: '1' });
  });

  it('reads Node continuations but refuses edits that conflict with the linewise consumer', () => {
    const text = 'A=  \nB=old\nC=end\n';
    expect(util.parseEnv(text)).toEqual({ A: 'B=old', C: 'end' });
    // B=old is A's value, not an assignment of B.
    expect(util.parseEnv(editEnvText(text, { set: { B: 'new' } }))).toEqual({
      A: 'B=old',
      B: 'new',
      C: 'end',
    });
    // The core sees B as an independent assignment, so neither leaving it active after an
    // unset nor deleting it when setting A is safe for both consumers.
    expect(parseEnvFile(text)).toEqual({ A: '', B: 'old', C: 'end' });
    expect(() => editEnvText(text, { unset: ['B'] })).toThrow(/ambiguous/i);
    expect(() => editEnvText(text, { set: { A: 'x' } })).toThrow(/ambiguous/i);
    // An empty key leaves the rest of its line to be read again.
    const bare = '=  D=1\nE=2\n';
    expect(util.parseEnv(bare)).toEqual({ D: '1', E: '2' });
    expect(() => editEnvText(bare, { unset: ['D'] })).toThrow(/ambiguous/i);
    // A blank value at the very end reads as empty, and stays empty with a key appended.
    expect(util.parseEnv(editEnvText('A=1\nZ=  ', { set: { B: '2' } }))).toEqual({ A: '1', Z: '', B: '2' });
  });

  it('refuses a value Node would not read on its own line', () => {
    expect(() => editEnvText('A=1\nB=2\n', { set: { A: '  ' } })).toThrow(/own line/);
    expect(() => editEnvText('A=1\nB="x"\n', { set: { A: '"open' } })).toThrow(/own line/);
    // Its quote would close one an earlier line left open.
    expect(() => editEnvText('A="open\nB=2\n', { set: { C: '"q"' } })).toThrow(/own line/);
    expect(editEnvText('A=1\nB=2\n', { set: { A: '' } })).toBe('A=\nB=2\n');
  });

  it.each([
    ['DB_PASSWORD=  \nDB_DATABASE=app\nDB_HOST=server-a\n', { set: { DB_PASSWORD: 'secret' } }],
    ['export EMPTY=\nTOKEN=old\n', { unset: ['EMPTY'] }],
    ['export\tEMPTY=\nTOKEN=old\n', { unset: ['EMPTY'] }],
    ['MESSAGE="first\nINNER=keep\nlast"\n', { set: { MESSAGE: 'new' } }],
  ])('refuses an edit ambiguous to the existing linewise consumer: %j', (text, edits) => {
    expect(() => editEnvText(text, edits)).toThrow(/ambiguous/i);
  });

  it('refuses bad keys, multi-line values and empty edits', () => {
    expect(() => editEnvText('', { set: { 'A B': '1' } })).toThrow(/not a valid/);
    expect(() => editEnvText('', { set: { A: 'one\nB=two' } })).toThrow(/one line/);
    expect(() => editEnvText('', { set: { A: { nested: 1 } } })).toThrow(/string value/);
    expect(() => editEnvText('', { unset: ['=x'] })).toThrow(/not a valid/);
    expect(() => editEnvText('', { set: { A: '1' }, unset: ['A'] })).toThrow(/both set and unset/);
    expect(() => editEnvText('', {})).toThrow(/Nothing to change/);
  });
});

describe('projectEnvRoutes', () => {
  let server, base, job, project, editProject, saves, holders, note, owners, dir;
  const interactive = () => ({
    id: 'one',
    kind: 'devchat',
    repo: 'owner/repo',
    status: 'running',
    ownerId: 1,
    workDir: dir,
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-env-'));
    job = interactive();
    project = { id: 7, repo: 'owner/repo', enabled: true, envTemplate: 'APP_KEY=secret\nDB_DATABASE=main\n' };
    owners = { 1: true };
    holders = new Set([job]);
    saves = [];
    // Like lib/projects.js: the edit sees the stored row, and saves only if it returns.
    editProject = vi.fn(async (id, change) => {
      const input = await change(project);
      saves.push([id, input]);
      project = { ...project, ...input };
      return project;
    });
    note = vi.fn();
    const app = express();
    app.use(express.json());
    app.use(
      projectEnvRoutes({
        agentSession: (req, res) => {
          if (req.headers.authorization === 'Bearer session-token') return job;
          res.status(401).json({ error: 'Unknown session token' });
          return null;
        },
        getProject: (repo) => (repo === project.repo ? project : null),
        editProject,
        ownerMayEdit: (j) => j.ownerId == null || !!owners[j.ownerId],
        holdsCheckout: (j, d) => holders.has(j) && j.workDir === d,
        note,
      }),
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/agent/project-env`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const request = (method, body, token = 'session-token') =>
    fetch(base, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (res) => ({ status: res.status, body: await res.json(), headers: res.headers }));

  it('reads the template uncached', async () => {
    const res = await request('GET');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ repo: 'owner/repo', env: 'APP_KEY=secret\nDB_DATABASE=main\n' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('saves the template, applies the edit to the checkout and notes key names only', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'APP_KEY=secret\nLOCAL=1\n');
    const res = await request('POST', { set: { APP_DEBUG: 'true' }, unset: ['APP_KEY'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      repo: 'owner/repo',
      checkout: 'updated',
      set: ['APP_DEBUG'],
      unset: ['APP_KEY'],
    });
    expect(saves).toEqual([[7, { envTemplate: 'DB_DATABASE=main\nAPP_DEBUG=true\n' }]]);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('LOCAL=1\nAPP_DEBUG=true\n');
    expect(note).toHaveBeenCalledWith(
      'one',
      "Updated the project's .env template: set APP_DEBUG; removed APP_KEY.",
    );
    expect(JSON.stringify(note.mock.calls)).not.toContain('true');
  });

  it('keeps a session database in the checkout while changing the template', async () => {
    job.sessionDb = 'session_one';
    fs.writeFileSync(path.join(dir, '.env'), 'DB_DATABASE=session_one\n');
    const res = await request('POST', { set: { DB_DATABASE: 'other' } });
    expect(res.body.checkout).toBe('unchanged');
    expect(project.envTemplate).toBe('APP_KEY=secret\nDB_DATABASE=other\n');
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('DB_DATABASE=session_one\n');
  });

  it.each(['write', 'rename'])('preserves the checkout and cleans up after a failed %s', async (stage) => {
    const file = path.join(dir, '.env');
    const original = 'TOKEN=old\nOTHER=keep\n';
    fs.writeFileSync(file, original);
    fs.chmodSync(file, 0o640);
    const value = 'x'.repeat(4096);
    const error = Object.assign(new Error('simulated filesystem failure'), { code: 'EIO' });
    if (stage === 'write') {
      const write = fs.writeFileSync;
      vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((target, contents, options) => {
        write(target, String(contents).slice(0, 1024), options);
        throw error;
      });
    } else
      vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw error;
      });

    const res = await request('POST', { set: { TOKEN: value } });
    expect(res.status).toBe(200);
    expect(res.body.checkout).toBe('not updated: simulated filesystem failure');
    expect(project.envTemplate).toContain(`TOKEN=${value}\n`);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(dir)).toEqual(['.env']);
  });

  it('preserves the checkout file mode when replacing it', async () => {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'TOKEN=old\nOTHER=keep\n');
    fs.chmodSync(file, 0o664);
    const res = await request('POST', { set: { TOKEN: 'new' } });
    expect(res.body.checkout).toBe('updated');
    expect(fs.readFileSync(file, 'utf8')).toBe('TOKEN=new\nOTHER=keep\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o664);
    expect(fs.readdirSync(dir)).toEqual(['.env']);
  });

  it('leaves the main checkout of a local session and an opted-out checkout alone', async () => {
    job.local = true;
    expect((await request('POST', { set: { A: '1' } })).body.checkout).toBe('not applicable');
    job.local = false;
    fs.writeFileSync(path.join(dir, '.env'), 'X=1\n');
    expect((await request('POST', { set: { B: '2' }, applyToCheckout: false })).body.checkout).toBeNull();
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('X=1\n');
    expect(project.envTemplate).toBe('APP_KEY=secret\nDB_DATABASE=main\nA=1\nB=2\n');
  });

  it('derives each edit from the stored row editProject hands it', async () => {
    await request('POST', { set: { A: '1' } });
    await request('POST', { set: { B: '2' } });
    expect(project.envTemplate).toBe('APP_KEY=secret\nDB_DATABASE=main\nA=1\nB=2\n');
  });

  it('rejects invalid edits without saving', async () => {
    const res = await request('POST', { set: { A: 'x\ny' } });
    expect(res.status).toBe(400);
    expect(saves).toEqual([]);
  });

  it.each([
    ['DB_PASSWORD=  \nDB_DATABASE=app\nDB_HOST=server-a\n', { set: { DB_PASSWORD: 'secret' } }],
    ['export EMPTY=\nTOKEN=old\n', { unset: ['EMPTY'] }],
  ])('refuses ambiguous template edits before saving or mirroring: %j', async (text, edits) => {
    project = { ...project, envTemplate: text };
    fs.writeFileSync(path.join(dir, '.env'), text);
    const res = await request('POST', edits);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ambiguous/i);
    expect(saves).toEqual([]);
    expect(project.envTemplate).toBe(text);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe(text);
    expect(note).not.toHaveBeenCalled();
  });

  it('leaves an ambiguous checkout intact when the template edit is safe', async () => {
    const text = 'DB_PASSWORD=  \nDB_DATABASE=app\nDB_HOST=server-a\n';
    fs.writeFileSync(path.join(dir, '.env'), text);
    const res = await request('POST', { set: { DB_PASSWORD: 'secret' } });
    expect(res.status).toBe(200);
    expect(res.body.checkout).toMatch(/^not updated: .*ambiguous/i);
    expect(project.envTemplate).toBe('APP_KEY=secret\nDB_DATABASE=main\nDB_PASSWORD=secret\n');
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe(text);
  });

  it.each([
    ['its owner is demoted', () => (owners[1] = false)],
    ['the project is disabled', () => (project = { ...project, enabled: false })],
    ['the session closes', () => (job.status = 'closed')],
    ['the turn becomes unattended', () => (job.unattendedTurn = true)],
  ])('refuses a queued edit if %s while it waits', async (_label, revoke) => {
    const run = editProject.getMockImplementation();
    editProject.mockImplementationOnce(async (id, change) => {
      revoke();
      return run(id, change);
    });
    const res = await request('POST', { set: { A: '1' } });
    expect(res.status).toBe(403);
    expect(saves).toEqual([]);
  });

  it('leaves a checkout the session handed back during the save', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'NEXT=occupant\n');
    const run = editProject.getMockImplementation();
    editProject.mockImplementationOnce(async (id, change) => {
      const saved = await run(id, change);
      holders.delete(job);
      return saved;
    });
    const res = await request('POST', { set: { A: '1' } });
    expect(res.status).toBe(200);
    expect(res.body.checkout).toBe('not updated: the session no longer holds its checkout');
    expect(project.envTemplate).toMatch(/A=1\n/);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('NEXT=occupant\n');
  });

  it('creates the checkout .env with the first keys, as seeding would', async () => {
    project = { ...project, envTemplate: '' };
    job.sessionDb = 'session_one';
    const res = await request('POST', { set: { NEW: '1' } });
    expect(res.body.checkout).toBe('updated');
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('NEW=1\nDB_DATABASE=session_one\n');
  });

  it('creates the checkout .env, holding the session database, when DB_DATABASE is the first key', async () => {
    project = { ...project, envTemplate: '' };
    job.sessionDb = 'session_one';
    const res = await request('POST', { set: { DB_DATABASE: 'default' } });
    expect(res.body.checkout).toBe('updated');
    expect(project.envTemplate).toBe('DB_DATABASE=default\n');
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('DB_DATABASE=session_one\n');
  });

  it('refuses a queued edit whose project was renamed to another repository while it waited', async () => {
    const run = editProject.getMockImplementation();
    editProject.mockImplementationOnce(async (id, change) => {
      project = { ...project, repo: 'owner/renamed' };
      return run(id, change);
    });
    const res = await request('POST', { set: { A: '1' } });
    expect(res.status).toBe(404);
    expect(saves).toEqual([]);
  });

  it('accepts the stored repository in another letter case', async () => {
    const run = editProject.getMockImplementation();
    editProject.mockImplementationOnce(async (id, change) => {
      project = { ...project, repo: 'Owner/Repo' };
      return run(id, change);
    });
    expect((await request('POST', { set: { A: '1' } })).status).toBe(200);
  });

  it('creates no .env for a removal alone', async () => {
    const res = await request('POST', { unset: ['APP_KEY'] });
    expect(res.body.checkout).toBe('unchanged');
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
  });

  it.each([
    ['a member', () => (job.ownerId = 2)],
    ['a review session', () => (job.reviewBranch = 'feature')],
    ['a worker', () => (job.parentId = 'orchestrator')],
    ['an unattended turn', () => (job.unattendedTurn = true)],
    ['a read-only analyst', () => (job.readOnly = true)],
  ])('refuses %s', async (_label, arrange) => {
    arrange();
    expect((await request('GET')).status).toBe(403);
    expect((await request('POST', { set: { A: '1' } })).status).toBe(403);
    expect(editProject).not.toHaveBeenCalled();
  });

  it('allows a session from before users', async () => {
    job.ownerId = null;
    expect((await request('GET')).status).toBe(200);
  });

  it('refuses an unknown token', async () => {
    expect((await request('GET', undefined, 'nope')).status).toBe(401);
  });
});
