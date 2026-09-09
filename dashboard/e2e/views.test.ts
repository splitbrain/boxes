import { afterAll, beforeAll, expect, test } from 'vitest';
import { resolve } from 'node:path';
import { closeBrowser, openPage, shoot } from './browser.ts';
import {
  startStubOrchestrator,
  stubSession,
  stubThread,
  type StubOrchestrator,
} from './stub-orchestrator.ts';

/**
 * The dashboard's own routes, driven in a real browser against the real
 * production bundle served the way the orchestrator serves it.
 */

const DIST = resolve(import.meta.dirname, '../dist');

let stub: StubOrchestrator;

beforeAll(async () => {
  stub = await startStubOrchestrator(DIST, [
    stubSession(),
    stubSession({
      id: 'e5f6a7b8',
      name: 'flaky CI',
      status: 'stopped',
      dockerState: 'exited',
      pendingCount: 2,
      turnActive: false,
      attachedCount: 0,
      // A box left alone for a fortnight, and one small enough to be a
      // checkout and nothing else: the two rough indicators at the other end
      // of their ranges from the box above.
      threads: [stubThread({ lastActiveAt: Date.now() - 14 * 86_400_000 })],
      diskBytes: 4_200_000,
    }),
    stubSession({
      id: '99887766',
      name: 'nightly bench',
      status: 'running',
      dockerState: 'running',
      turnActive: true,
      // What the badge goes by: a prompt being open upstream is not the same
      // as the agent working, and the list says what the agent is doing.
      speaking: true,
      // And one that is not: a box whose agent has stopped with a build
      // still running in it.
      backgroundBusy: true,
      // Which of its conversations that build belongs to is the row's own
      // bullet, and the only place a list says which thread is holding the
      // box awake.
      threads: [
        stubThread({ backgroundBusy: true, lastActiveAt: Date.now() - 12_000 }),
        stubThread({ id: 'th2', ordinal: 2, title: 'flaky retry logic', lastActiveAt: Date.now() - 5 * 3_600_000 }),
      ],
      attachedCount: 1,
      proxyAttached: false,
      diskBytes: 2.4 * 1024 ** 3,
    }),
  ]);
});

afterAll(async () => {
  await closeBrowser();
  await stub.close();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`session list renders in ${scheme}`, async () => {
    const { page, errors, close } = await openPage(stub.url, '/', scheme);
    try {
      await expect.poll(() => page.getByText('refactor auth').isVisible()).toBe(true);
      await expect.poll(() => page.getByText('2 approvals waiting').isVisible()).toBe(true);
      await expect.poll(() => page.getByText('running turn').isVisible()).toBe(true);
      await expect.poll(() => page.getByText('still running').isVisible()).toBe(true);
      // The thread that is running it, said in a dot and readable as words.
      await expect
        .poll(() => page.getByRole('img', { name: 'something still running' }).isVisible())
        .toBe(true);
      // How long since each conversation did anything, and how much disk each
      // box has taken: the two rough indicators, in the units the numbers
      // above land in.
      // Seconds, by shape rather than by value: the clock keeps moving while
      // the page loads, and which second it lands on is not the point.
      await expect.poll(() => page.getByText(/^\d+s$/).isVisible()).toBe(true);
      await expect.poll(() => page.getByText('5h', { exact: true }).isVisible()).toBe(true);
      await expect.poll(() => page.getByText('14d', { exact: true }).isVisible()).toBe(true);
      await expect.poll(() => page.getByText('348 MB').isVisible()).toBe(true);
      await expect.poll(() => page.getByText('4.0 MB').isVisible()).toBe(true);
      await expect.poll(() => page.getByText('2.4 GB').isVisible()).toBe(true);
      await shoot(page, `list-${scheme}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test(`create form renders in ${scheme}`, async () => {
    const { page, errors, close } = await openPage(stub.url, '/new', scheme);
    try {
      await expect.poll(() => page.getByLabel('Name').isVisible()).toBe(true);
      await shoot(page, `create-${scheme}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test(`session info renders in ${scheme}`, async () => {
    const { page, errors, close } = await openPage(stub.url, '/sessions/a1b2c3d4/info', scheme);
    try {
      await expect.poll(() => page.getByText('Details').isVisible()).toBe(true);
      await expect.poll(() => page.getByText('Connect an external ACP client').isVisible()).toBe(true);
      await expect
        .poll(() => page.getByText('348 MB of workspace and home').isVisible())
        .toBe(true);
      await shoot(page, `info-${scheme}`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });
}

test('a deep link into the SPA is served by the index fallback', async () => {
  const { page, errors, close } = await openPage(stub.url, '/sessions/a1b2c3d4/info');
  try {
    await expect.poll(() => page.getByText('Details').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('tapping a card opens that session thread', async () => {
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await page.getByText('refactor auth').click();
    await page.waitForURL('**/sessions/a1b2c3d4');
    expect(new URL(page.url()).pathname).toBe('/sessions/a1b2c3d4');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the info corner opens the ops route instead', async () => {
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await page.getByLabel('Details and controls for refactor auth').click();
    await page.waitForURL('**/sessions/a1b2c3d4/info');
    expect(new URL(page.url()).pathname).toBe('/sessions/a1b2c3d4/info');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a link to a session that is gone says so instead of offering a composer', async () => {
  const { page, errors, close } = await openPage(stub.url, '/sessions/deadbeef');
  try {
    // What a bookmark for a deleted box lands on. Nothing can connect without
    // the session's token, so a composer would be an invitation to type into
    // a void.
    await expect.poll(() => page.getByText('Back to sessions').isVisible()).toBe(true);
    expect(await page.getByRole('textbox', { name: 'Message input' }).isVisible()).toBe(false);
    await expect.poll(() => page.getByText('disconnected').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the session list says which build of each image is running', async () => {
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    // The digest abbreviated the way Docker abbreviates an id, then the build
    // time and the size. The clock is asserted by shape rather than by value:
    // it is rendered in the browser's own timezone, which is the machine's.
    const orchestrator = page.getByText(
      /^orchestrator 1a2b3c4d5e6f · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 420 MB$/,
    );
    await expect.poll(() => orchestrator.isVisible()).toBe(true);
    await expect.poll(() => page.getByText(/^proxy 9f8e7d6c5b4a · .* · 180 MB$/).isVisible())
      .toBe(true);
    // In gigabytes, which is the size a session image is and the reason the
    // line carries one at all.
    await expect.poll(() => page.getByText(/^session 001122334455 · .* · 4.2 GB$/).isVisible())
      .toBe(true);
    // The whole digest is on hover: too long for the line, and the only form
    // worth pasting into a comparison.
    expect(await orchestrator.getAttribute('title')).toBe(
      'sha256:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
    );
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the session list offers to notify this browser', async () => {
  const { page, errors, close } = await openPage(stub.url, '/', 'dark');
  try {
    // A browser that can subscribe is offered the choice rather than
    // subscribed for it: the permission prompt has to come from a click.
    const toggle = page.getByRole('button', { name: 'Notify me' });
    await expect.poll(() => toggle.isVisible()).toBe(true);
    expect(await toggle.getAttribute('aria-pressed')).toBe('false');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
