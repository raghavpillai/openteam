import { expect, test } from 'bun:test';
import { BrowserUseSession } from '../../src/browser/use';

test('navigation capture recovery refreshes masks once without retrying element captures or unrelated failures', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    for (const message of ['Frame was detached', 'Frame is currently attempting a navigation', 'Execution context was destroyed, most likely because of a navigation']) {
      let calls = 0;
      const page = {
        frames: () => [{locator: () => `mask-${calls}`}],
        screenshot: async (options: any) => {
          expect(options.mask).toEqual([`mask-${calls}`]);
          if (++calls === 1) throw new Error(message);
          return Buffer.from('masked new document');
        },
      };
      expect(await (BrowserUseSession.prototype as any).captureScreenshot.call({}, page, false, 1000))
        .toEqual(Buffer.from('masked new document'));
      expect(calls).toBe(2);
      calls = 0;
      await expect((BrowserUseSession.prototype as any).captureScreenshot.call({}, page, false, 1000, undefined, page))
        .rejects.toThrow(message);
      expect(calls).toBe(1);
    }
    for (const message of ['Frame is currently attempting a navigation', 'Permission denied']) {
      let calls = 0;
      const page = {frames: () => [], screenshot: async () => {calls++; throw new Error(message);}};
      await expect((BrowserUseSession.prototype as any).captureScreenshot.call({}, page, false, 1000))
        .rejects.toThrow(message);
      expect(calls).toBe(message === 'Permission denied' ? 1 : 2);
    }
  } finally {Object.defineProperty(process, 'platform', platform);}
});

// Model a responsive capture with an unresponsive protocol phase. No website,
// product name, expected page contents, or live browser is involved.
test('screenshot protocol timeouts settle without closing the shared browser or returning unmasked frames', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    for (const blocked of ['none', 'session setup', 'render setup', 'capture', 'render cleanup', 'session cleanup']) {
      const calls: string[] = [];
      const run = async (phase: string) => {
        calls.push(phase);
        if (phase === blocked) return new Promise<void>(() => {});
      };
      const session = {
        on: () => {},
        send: (method: string) => run(method === 'Page.startScreencast' ? 'render setup' : 'render cleanup'),
        detach: () => run('session cleanup'),
      };
      const owner = { context: { newCDPSession: async () => { await run('session setup'); return session; } } };
      const page = {
        frames: () => [{ locator: (selector: string) => { expect(selector).toBe('[data-openteam-private="true"]'); return 'private-mask'; } }],
        screenshot: async (options: any) => {
          expect(options.mask).toEqual(['private-mask']);
          await run('capture');
          return Buffer.from('masked capture');
        },
      };
      const started = Date.now();
      const pending = (BrowserUseSession.prototype as any).captureScreenshot.call(owner, page, true, 25);
      if (['session setup', 'render setup', 'capture'].includes(blocked)) {
        await expect(pending).rejects.toThrow(`timed out during ${blocked}`);
      } else {
        expect(await pending).toEqual(Buffer.from('masked capture'));
      }
      expect(Date.now() - started).toBeLessThan(1000);
      if (blocked !== 'session setup') expect(calls).toContain('session cleanup');
    }
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('a browser session created after the screenshot deadline is detached', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    let resolve!: (session: unknown) => void;
    let detached = 0;
    const owner = { context: { newCDPSession: () => new Promise(value => { resolve = value; }) } };
    await expect((BrowserUseSession.prototype as any).captureScreenshot.call(owner, { frames: () => [] }, false, 25))
      .rejects.toThrow('timed out during session setup');
    resolve({ detach: async () => { detached++; } });
    await Promise.resolve();
    expect(detached).toBe(1);
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('cancelling an in-flight screenshot releases its protocol session', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    let detached = 0;
    const controller = new AbortController();
    const session = { on: () => {}, send: async () => {}, detach: async () => { detached++; } };
    const owner = { context: { newCDPSession: async () => session } };
    const page = { frames: () => [{ locator: () => ({}) }], screenshot: () => {
      controller.abort(new Error('User cancelled capture'));
      return new Promise(() => {});
    } };
    await expect((BrowserUseSession.prototype as any).captureScreenshot.call(owner, page, false, 10_000, controller.signal))
      .rejects.toThrow('User cancelled capture');
    expect(detached).toBe(1);
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('screenshot setup and capture share one deadline instead of renewing the budget per phase', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    let captured = false;
    let detached = false;
    const delay = () => new Promise(resolve => setTimeout(resolve, 70));
    const session = {
      on: () => {},
      send: async (method: string) => { if (method === 'Page.startScreencast') await delay(); },
      detach: async () => { detached = true; },
    };
    const owner = { context: { newCDPSession: async () => { await delay(); return session; } } };
    const page = { frames: () => [], screenshot: async () => { captured = true; return Buffer.from('capture'); } };
    await expect((BrowserUseSession.prototype as any).captureScreenshot.call(owner, page, false, 100))
      .rejects.toThrow('timed out during render setup');
    expect(captured).toBe(false);
    expect(detached).toBe(true);
  } finally { Object.defineProperty(process, 'platform', platform); }
});
