import { describe, expect, it, vi } from 'vitest';

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
