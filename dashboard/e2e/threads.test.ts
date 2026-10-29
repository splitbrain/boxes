/**
 * Browser tests for several threads on one box.
 *
 * A box's threads share its container, workspace and home. Each thread has a transcript of its own.
 */

import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { closeBrowser, openPage } from './browser.ts';
import { DEFAULT_BOX, startOrchestrator, type TestOrchestrator } from './orchestrator.ts';
import { reply } from './stub-gateway.ts';

/** The box the tests drive. */
const ID = DEFAULT_BOX.id;

/**
 * Reads the `text-decoration-line` that the browser computed for one element.
 *
 * @param target The element.
 * @returns The computed value.
 */
function decoration(target: import('playwright').Locator): Promise<string> {
  return target.evaluate((el) => getComputedStyle(el).textDecorationLine);
}

/** The orchestrator of the running test. */
let stub: TestOrchestrator;

beforeEach(async () => {
  stub = await startOrchestrator([{}], {
    prompts: [{ match: () => true, updates: reply('First answer.') }],
  });
});

afterEach(async () => {
  await stub?.close();
});

afterAll(async () => {
  await closeBrowser();
});

/**
 * Starts a fresh thread from the list, with the dialog's defaults.
 *
 * @param page The page that shows the box list.
 */
async function startThread(page: import('playwright').Page): Promise<void> {
  await page.getByRole('button', { name: 'New thread' }).click();
  await page.getByRole('button', { name: 'Start thread' }).click();
}

/**
 * Waits for the connection, asks one question, and waits for the answer.
 *
 * @param page The page that shows the thread.
 */
async function askOnce(page: import('playwright').Page): Promise<void> {
  await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
  const input = page.getByLabel('Message input');
  await input.fill('question one');
  await input.press('Control+Enter');
  await expect.poll(() => page.getByText('First answer.').isVisible()).toBe(true);
}

test('a new thread starts empty on the same box', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${ID}/threads/${DEFAULT_BOX.threadId}`,
  );
  try {
    await askOnce(page);

    await page.getByLabel('Back to boxes').click();
    await startThread(page);
    // Each thread has its own route.
    await page.waitForURL(`**/boxes/${ID}/threads/th2`);
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // The second thread has a transcript of its own, which is empty.
    await expect.poll(() => page.getByText('Thread 2').isVisible()).toBe(true);
    expect(await page.getByText('First answer.').count()).toBe(0);
    expect(await page.getByText('question one').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a fork carries the source thread messages into the new one', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${ID}/threads/${DEFAULT_BOX.threadId}`,
  );
  try {
    await askOnce(page);

    await page.getByLabel('Fork this thread').click();
    await expect
      .poll(() => page.getByRole('link', { name: 'Open it in a new tab' }).isVisible())
      .toBe(true);
    await page.getByLabel('Back to boxes').click();
    await page.getByRole('link', { name: 'Thread 2' }).click();
    await page.waitForURL(`**/boxes/${ID}/threads/th2`);
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // The fork replays the first thread's messages on a thread of its own.
    await expect.poll(() => page.getByText('Thread 2').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('First answer.').isVisible()).toBe(true);
    expect(await page.getByText('First answer.').count()).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('switching back to the first thread returns its transcript', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${ID}/threads/${DEFAULT_BOX.threadId}`,
  );
  try {
    await askOnce(page);

    await page.getByLabel('Back to boxes').click();
    await startThread(page);
    await page.waitForURL(`**/boxes/${ID}/threads/th2`);
    await expect.poll(() => page.getByText('Thread 2').isVisible()).toBe(true);
    expect(await page.getByText('First answer.').count()).toBe(0);

    await page.getByLabel('Back to boxes').click();
    await page.getByRole('link', { name: 'Thread 1' }).click();
    await page.waitForURL(`**/boxes/${ID}/threads/th1`);
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    await expect.poll(() => page.getByText('First answer.').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('question one').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the thread names itself even when the box has only one', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/boxes/${ID}/threads/${DEFAULT_BOX.threadId}`,
  );
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    // Without the name, two tabs on one box look the same.
    await expect.poll(() => page.getByText('Thread 1').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a fork from inside the thread leaves it where it is and offers a new tab', async () => {
  const { page, errors, close } = await openPage(stub.url, `/boxes/${ID}/threads/th1`);
  try {
    await askOnce(page);

    await page.getByLabel('Fork this thread').click();

    // The link is shown and not followed, because popup blockers stop a
    // window.open after an await.
    const link = page.getByRole('link', { name: 'Open it in a new tab' });
    await expect.poll(() => link.isVisible()).toBe(true);
    expect(await link.getAttribute('href')).toBe(`/boxes/${ID}/threads/th2`);
    expect(await link.getAttribute('target')).toBe('_blank');

    // This thread keeps its route, transcript and connection.
    expect(page.url()).toContain(`/boxes/${ID}/threads/th1`);
    await expect.poll(() => page.getByText('First answer.').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('two tabs on two threads each keep to their own conversation', async () => {
  await stub.close();
  // A prompt that stays open, because a busy thread is the one people fork.
  stub = await startOrchestrator([{}], {
    prompts: [
      { match: (t: string) => t === 'the long job', updates: reply('Working on it.'), hold: true },
      { match: () => true, updates: reply('A quick answer.') },
    ],
  });

  const working = await openPage(stub.url, `/boxes/${ID}/threads/th1`);
  try {
    await expect.poll(() => working.page.getByText('connected').isVisible()).toBe(true);
    const first = working.page.getByLabel('Message input');
    await first.fill('the long job');
    await first.press('Control+Enter');
    await expect.poll(() => working.page.getByText('Working on it.').isVisible()).toBe(true);

    // Fork it and open the fork in its own tab.
    await working.page.getByLabel('Fork this thread').click();
    await expect
      .poll(() => working.page.getByRole('link', { name: 'Open it in a new tab' }).isVisible())
      .toBe(true);

    const exploring = await openPage(stub.url, `/boxes/${ID}/threads/th2`);
    try {
      await expect.poll(() => exploring.page.getByText('connected').isVisible()).toBe(true);
      // Both sockets are up at once, on two threads of one box.
      await expect.poll(() => stub.gateway.attached()).toBe(2);

      // The fork carries what the original had said so far, and its composer
      // is usable while the original's turn is still open.
      await expect.poll(() => exploring.page.getByText('Working on it.').isVisible()).toBe(true);
      const second = exploring.page.getByLabel('Message input');
      await second.fill('what are you doing?');
      await second.press('Control+Enter');
      await expect.poll(() => exploring.page.getByText('A quick answer.').isVisible()).toBe(true);

      // None of that reached the thread that is still working.
      expect(await working.page.getByText('A quick answer.').count()).toBe(0);
      expect(await working.page.getByText('what are you doing?').count()).toBe(0);
      expect(working.errors).toEqual([]);
      expect(exploring.errors).toEqual([]);
    } finally {
      stub.gateway.release();
      await exploring.close();
    }
  } finally {
    await working.close();
  }
});

test('forking is not offered when the adapter does not advertise it', async () => {
  await stub.close();
  stub = await startOrchestrator([{ canFork: false }]);

  const { page, errors, close } = await openPage(stub.url, `/boxes/${ID}/threads/th1`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    expect(await page.getByLabel('Fork this thread').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('marking a thread done crosses it out on the list, and the mark comes off again', async () => {
  const { page, errors, close } = await openPage(stub.url, `/boxes/${ID}/threads/th1`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    await page.getByLabel('Mark this thread done').click();
    // The same button, now saying what it would undo.
    await expect.poll(() => page.getByLabel('Mark this thread not done').isVisible()).toBe(true);

    await page.getByLabel('Back to boxes').click();
    const name = page.getByRole('link', { name: 'Thread 1' }).getByText('Thread 1');
    await expect.poll(() => name.isVisible()).toBe(true);
    await expect.poll(() => decoration(name)).toBe('line-through');

    // The row is still a link into the thread, which still connects.
    await name.click();
    await page.waitForURL(`**/boxes/${ID}/threads/th1`);
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    await page.getByLabel('Mark this thread not done').click();
    await expect.poll(() => page.getByLabel('Mark this thread done').isVisible()).toBe(true);

    await page.getByLabel('Back to boxes').click();
    await expect.poll(() => name.isVisible()).toBe(true);
    await expect.poll(() => decoration(name)).toBe('none');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

/**
 * Holds a touch on the middle of an element for one second, through the Chrome DevTools Protocol.
 *
 * @param page The page with the element.
 * @param target The element.
 */
async function longPress(
  page: import('playwright').Page,
  target: import('playwright').Locator,
): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('The element has no box.');
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(1000);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('a right click or a long press on the list toggles the done mark without opening the thread', async () => {
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    const name = page.getByRole('link', { name: 'Thread 1' }).getByText('Thread 1');
    await expect.poll(() => name.isVisible()).toBe(true);

    await name.click({ button: 'right' });
    await expect.poll(() => decoration(name)).toBe('line-through');
    await name.click({ button: 'right' });
    await expect.poll(() => decoration(name)).toBe('none');

    await longPress(page, name);
    await expect.poll(() => decoration(name)).toBe('line-through');
    expect(new URL(page.url()).pathname).toBe('/');
    await longPress(page, name);
    await expect.poll(() => decoration(name)).toBe('none');
    expect(new URL(page.url()).pathname).toBe('/');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('threads marked done and idle for more than a week fold away under a summary', async () => {
  stub.resetBoxes();
  stub.createBox({
    threads: [
      { title: 'old work', done: true, lastActiveAt: Date.now() - 8 * 86_400_000 },
      { title: 'older work', done: true, lastActiveAt: Date.now() - 9 * 86_400_000 },
      { title: 'recent work', done: true, lastActiveAt: Date.now() - 6 * 86_400_000 },
      { title: 'open work', lastActiveAt: Date.now() - 30 * 86_400_000 },
    ],
  });
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    const summary = page.getByText('2 older done threads');
    await expect.poll(() => summary.isVisible()).toBe(true);
    expect(await page.getByText('recent work').isVisible()).toBe(true);
    expect(await page.getByText('open work').isVisible()).toBe(true);
    expect(await page.getByText('old work').isVisible()).toBe(false);

    await summary.click();
    await expect.poll(() => page.getByText('old work').isVisible()).toBe(true);
    expect(await page.getByText('older work').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the list shows idle threads by last activity, oldest first, and the working threads last', async () => {
  stub.resetBoxes();
  stub.createBox({
    threads: [
      { title: 'first busy', speaking: true, lastActiveAt: Date.now() },
      { title: 'recent idle', lastActiveAt: Date.now() - 60_000 },
      { title: 'second busy', pendingCount: 1, lastActiveAt: Date.now() - 120_000 },
      { title: 'old idle', lastActiveAt: Date.now() - 3_600_000 },
      { title: 'old done', done: true, lastActiveAt: Date.now() - 8 * 86_400_000 },
      { title: 'older done', done: true, lastActiveAt: Date.now() - 9 * 86_400_000 },
    ],
  });
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    const list = page.locator('summary, a[href*="/threads/"] .truncate');
    await expect.poll(() => list.count()).toBe(7);
    expect(await list.allTextContents()).toEqual([
      '2 older done threads',
      'older done',
      'old done',
      'old idle',
      'recent idle',
      'first busy',
      'second busy',
    ]);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a single thread marked done and idle for more than a week stays in the list', async () => {
  stub.resetBoxes();
  stub.createBox({
    threads: [
      { title: 'old work', done: true, lastActiveAt: Date.now() - 8 * 86_400_000 },
      { title: 'open work' },
    ],
  });
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await expect.poll(() => page.getByText('old work').isVisible()).toBe(true);
    expect(await page.getByText(/older done thread/).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
