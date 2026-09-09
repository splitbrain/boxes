import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { resolve } from 'node:path';
import type { SessionUpdate } from '../src/stores/thread/acp-types.ts';
import { closeBrowser, openPage } from './browser.ts';
import { startStubOrchestrator, stubSession, type StubOrchestrator } from './stub-orchestrator.ts';

/**
 * Several conversations on one session, and two of them watched at once.
 *
 * A session shares its container and both volumes across its threads, so the
 * difference between them is the transcript and nothing else. What is asserted
 * here is that difference: a fresh thread starts empty, a fork starts from
 * what the source had, going back to a thread brings its own transcript back,
 * and two tabs on two threads each keep to their own.
 */

const DIST = resolve(import.meta.dirname, '../dist');
const ID = 'a1b2c3d4';

/** A streamed assistant reply, in the chunks an adapter would send it. */
function reply(...texts: string[]): SessionUpdate[] {
  return texts.map(
    (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) as SessionUpdate,
  );
}

let stub: StubOrchestrator;

beforeEach(async () => {
  stub = await startStubOrchestrator(DIST, [stubSession()], {
    prompts: [{ match: () => true, updates: reply('First answer.') }],
  });
});

afterEach(async () => {
  await stub?.close();
});

afterAll(async () => {
  await closeBrowser();
});

/** Opens the session, asks one question, and waits for the answer. */
async function askOnce(page: import('playwright').Page): Promise<void> {
  await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
  const input = page.getByLabel('Message input');
  await input.fill('question one');
  await input.press('Control+Enter');
  await expect.poll(() => page.getByText('First answer.').isVisible()).toBe(true);
}

test('a new thread starts empty on the same session', async () => {
  const { page, errors, close } = await openPage(stub.url, `/sessions/${ID}`);
  try {
    await askOnce(page);

    await page.getByLabel('Back to sessions').click();
    await page.getByRole('button', { name: 'New thread' }).click();
    // Opening a thread is a navigation to that thread's own route.
    await page.waitForURL(`**/sessions/${ID}/threads/th2`);
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
  const { page, errors, close } = await openPage(stub.url, `/sessions/${ID}`);
  try {
    await askOnce(page);

    await page.getByLabel('Back to sessions').click();
    await page.getByRole('button', { name: 'Fork' }).click();
    await page.waitForURL(`**/sessions/${ID}/threads/th2`);
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // A branch of the first conversation, not a copy of the session: the
    // replay comes back on a thread of its own.
    await expect.poll(() => page.getByText('Thread 2').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('First answer.').isVisible()).toBe(true);
    expect(await page.getByText('First answer.').count()).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('switching back to the first thread returns its transcript', async () => {
  const { page, errors, close } = await openPage(stub.url, `/sessions/${ID}`);
  try {
    await askOnce(page);

    await page.getByLabel('Back to sessions').click();
    await page.getByRole('button', { name: 'New thread' }).click();
    await page.waitForURL(`**/sessions/${ID}/threads/th2`);
    await expect.poll(() => page.getByText('Thread 2').isVisible()).toBe(true);
    expect(await page.getByText('First answer.').count()).toBe(0);

    await page.getByLabel('Back to sessions').click();
    await page.getByRole('link', { name: 'Thread 1' }).click();
    await page.waitForURL(`**/sessions/${ID}/threads/th1`);
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // The first thread was left where it was, and comes back whole.
    await expect.poll(() => page.getByText('First answer.').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('question one').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the thread names itself even when the session has only one', async () => {
  const { page, errors, close } = await openPage(stub.url, `/sessions/${ID}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    // Two tabs on one session are otherwise indistinguishable, which is the
    // whole point of putting the thread in the URL.
    await expect.poll(() => page.getByText('Thread 1').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a fork from inside the thread leaves it where it is and offers a new tab', async () => {
  const { page, errors, close } = await openPage(stub.url, `/sessions/${ID}/threads/th1`);
  try {
    await askOnce(page);

    await page.getByLabel('Fork this thread').click();

    // The link is revealed rather than followed: a window.open after the
    // await is what popup blockers exist to stop.
    const link = page.getByRole('link', { name: 'Open it in a new tab' });
    await expect.poll(() => link.isVisible()).toBe(true);
    expect(await link.getAttribute('href')).toBe(`/sessions/${ID}/threads/th2`);
    expect(await link.getAttribute('target')).toBe('_blank');

    // This thread stayed exactly where it was: same route, same transcript,
    // same connection. Nothing was switched out from under it.
    expect(page.url()).toContain(`/sessions/${ID}/threads/th1`);
    await expect.poll(() => page.getByText('First answer.').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('two tabs on two threads each keep to their own conversation', async () => {
  await stub.close();
  // A prompt that never finishes, which is the thread you fork *because* it
  // is busy.
  stub = await startStubOrchestrator(DIST, [stubSession()], {
    prompts: [
      { match: (t) => t === 'the long job', updates: reply('Working on it.'), hold: true },
      { match: () => true, updates: reply('A quick answer.') },
    ],
  });

  const working = await openPage(stub.url, `/sessions/${ID}/threads/th1`);
  try {
    await expect.poll(() => working.page.getByText('connected').isVisible()).toBe(true);
    const first = working.page.getByLabel('Message input');
    await first.fill('the long job');
    await first.press('Control+Enter');
    await expect.poll(() => working.page.getByText('Working on it.').isVisible()).toBe(true);

    // Fork it and open the fork in its own tab, which is the motion the whole
    // change exists for.
    await working.page.getByLabel('Fork this thread').click();
    await expect.poll(() =>
      working.page.getByRole('link', { name: 'Open it in a new tab' }).isVisible(),
    ).toBe(true);

    const exploring = await openPage(stub.url, `/sessions/${ID}/threads/th2`);
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

      // And none of that reached the thread that is still working: its
      // transcript is untouched by the other tab.
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
  stub = await startStubOrchestrator(DIST, [stubSession({ canFork: false })]);

  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await expect.poll(() => page.getByRole('button', { name: 'New thread' }).isVisible()).toBe(
      true,
    );
    expect(await page.getByRole('button', { name: 'Fork' }).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a bang command is run against the thread it was typed in', async () => {
  stub.execOutput = (command) => ({ output: `ran: ${command}\n`, exitCode: 0 });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${ID}/threads/th1`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('!echo hi');
    await input.press('Control+Enter');

    // The thread is part of the endpoint, so the run is logged where it was
    // typed and no other conversation of this box replays it.
    await expect.poll(() => stub.execCalls.length).toBe(1);
    expect(stub.execCalls[0]).toEqual({ sessionId: ID, threadId: 'th1', command: 'echo hi' });
    await expect.poll(() => page.getByText('ran: echo hi').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
