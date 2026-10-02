import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ browserBin: '/opt/chromium/chrome' }));
vi.mock('../lib/config.js', () => ({ getConfig: () => cfg }));

const browser = await import('../lib/browser.js');

describe('keyDefinition', () => {
  it('gives Enter the carriage return Chromium needs to submit a form', () => {
    expect(browser.keyDefinition('Enter')).toEqual({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
  });

  it('maps a letter or digit to its key code, and types it', () => {
    expect(browser.keyDefinition('a')).toEqual({ key: 'a', code: 'KeyA', keyCode: 65, text: 'a' });
    expect(browser.keyDefinition('7')).toEqual({ key: '7', code: 'Digit7', keyCode: 55, text: '7' });
  });

  it('types any other single character without a key code', () => {
    expect(browser.keyDefinition('ñ')).toEqual({ key: 'ñ', code: '', keyCode: 0, text: 'ñ' });
  });

  it('refuses a key it does not know, with a 400', () => {
    expect(() => browser.keyDefinition('F13')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => browser.keyDefinition('ab')).toThrow(/Unknown key/);
  });
});

describe('checkUrl', () => {
  it('takes http, https and about:blank', () => {
    expect(browser.checkUrl('http://localhost:8100/login')).toBe('http://localhost:8100/login');
    expect(browser.checkUrl('https://example.com')).toBe('https://example.com/');
    expect(browser.checkUrl('about:blank')).toBe('about:blank');
  });

  it('refuses the server’s own files, the browser’s own pages and scripts', () => {
    for (const url of [
      'file:///etc/passwd',
      'chrome://settings',
      'javascript:alert(1)',
      'data:text/html,x',
      'example.com',
    ]) {
      expect(() => browser.checkUrl(url)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
});

describe('a session with no browser running', () => {
  it('reports it as not running, with no endpoint for a turn to mount', () => {
    expect(browser.browserRunning('none')).toBe(false);
    expect(browser.browserEndpoint('none')).toBeNull();
    expect(browser.browserState('none')).toEqual({ running: false, tabs: [], active: null });
  });

  it('refuses a watch, a screenshot and input with a 409', async () => {
    expect(() => browser.watchBrowser('none', () => {})).toThrow(expect.objectContaining({ status: 409 }));
    await expect(browser.browserScreenshot('none')).rejects.toMatchObject({ status: 409 });
    await expect(browser.browserInput('none', { type: 'reload' })).rejects.toMatchObject({ status: 409 });
  });

  it('stops and forgets quietly', () => {
    expect(() => browser.stopBrowser('none')).not.toThrow();
    expect(() => browser.forgetBrowser('none')).not.toThrow();
  });
});

describe('findBrowserBin', () => {
  it('takes BROWSER_BIN as it is when set', () => {
    expect(browser.findBrowserBin()).toBe('/opt/chromium/chrome');
  });

  describe('without BROWSER_BIN', () => {
    const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
    let root;
    // A home and a PATH of the test's own, and a fresh copy of the module,
    // since the answer is cached for the life of the process.
    const fresh = async ({ builds = [], onPath = [] } = {}) => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'find-browser-'));
      for (const [build, sub] of builds) {
        const dir = path.join(root, 'home', '.cache', 'ms-playwright', build, sub);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'chrome'), '');
      }
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin, { recursive: true });
      for (const name of onPath) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
      process.env.HOME = path.join(root, 'home');
      // Only `which` from the system, so a browser installed on this machine
      // cannot answer for the one the test set up.
      const sys = path.join(root, 'sys');
      fs.mkdirSync(sys);
      fs.symlinkSync(
        execFileSync('sh', ['-c', 'command -v which'], { encoding: 'utf8' }).trim(),
        path.join(sys, 'which'),
      );
      process.env.PATH = `${bin}:${sys}`;
      vi.resetModules();
      return import('../lib/browser.js');
    };
    beforeEach(() => {
      cfg.browserBin = '';
    });
    afterEach(() => {
      cfg.browserBin = '/opt/chromium/chrome';
      Object.assign(process.env, saved);
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('takes the newest Chromium Playwright downloaded', async () => {
      const mod = await fresh({
        builds: [
          ['chromium-999', 'chrome-linux'],
          ['chromium-1243', 'chrome-linux-arm64'],
          ['chromium_headless_shell-2000', 'chrome-linux'],
        ],
        onPath: ['chromium'],
      });
      expect(mod.findBrowserBin()).toBe(
        path.join(root, 'home', '.cache', 'ms-playwright', 'chromium-1243', 'chrome-linux-arm64', 'chrome'),
      );
    });

    it('falls back to a Chromium on PATH', async () => {
      const mod = await fresh({ onPath: ['chromium-browser'] });
      expect(mod.findBrowserBin()).toBe(path.join(root, 'bin', 'chromium-browser'));
    });

    it('finds none, and a start says what to install', async () => {
      const mod = await fresh();
      expect(mod.findBrowserBin()).toBeNull();
      await expect(mod.startBrowser('nobin')).rejects.toMatchObject({
        status: 503,
        message: expect.stringMatching(/npx playwright install chromium/),
      });
    });
  });
});

describe('where a session’s files go', () => {
  it('keeps the profile and the agent’s output under the temp dir, named for the session', () => {
    expect(browser.profileDir('abc123')).toMatch(/briareus-browser[/\\]abc123$/);
    expect(browser.browserOutputDir('abc123')).toBe(`${browser.profileDir('abc123')}-output`);
  });

  it('cannot be walked out of with the session id', () => {
    expect(browser.profileDir('../../etc')).toMatch(/briareus-browser[/\\]______etc$/);
  });
});
