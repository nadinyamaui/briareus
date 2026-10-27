import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  let server, base, job, project, updateProject, note, owners, dir;
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
    updateProject = vi.fn(async (id, input) => {
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
        updateProject,
        ownerMayEdit: (j) => j.ownerId == null || !!owners[j.ownerId],
        note,
      }),
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/agent/project-env`;
  });

  afterEach(async () => {
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
    expect(updateProject).toHaveBeenCalledWith(7, { envTemplate: 'DB_DATABASE=main\nAPP_DEBUG=true\n' });
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

  it('leaves the main checkout of a local session and an opted-out checkout alone', async () => {
    job.local = true;
    expect((await request('POST', { set: { A: '1' } })).body.checkout).toBe('not applicable');
    job.local = false;
    fs.writeFileSync(path.join(dir, '.env'), 'X=1\n');
    expect((await request('POST', { set: { B: '2' }, applyToCheckout: false })).body.checkout).toBeNull();
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('X=1\n');
    expect(project.envTemplate).toBe('APP_KEY=secret\nDB_DATABASE=main\nA=1\nB=2\n');
  });

  it('serializes concurrent edits so neither is lost', async () => {
    await Promise.all([request('POST', { set: { A: '1' } }), request('POST', { set: { B: '2' } })]);
    expect(project.envTemplate).toMatch(/A=1\n/);
    expect(project.envTemplate).toMatch(/B=2\n/);
  });

  it('rejects invalid edits without saving', async () => {
    const res = await request('POST', { set: { A: 'x\ny' } });
    expect(res.status).toBe(400);
    expect(updateProject).not.toHaveBeenCalled();
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
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('allows a session from before users', async () => {
    job.ownerId = null;
    expect((await request('GET')).status).toBe(200);
  });

  it('refuses an unknown token', async () => {
    expect((await request('GET', undefined, 'nope')).status).toBe(401);
  });
});
