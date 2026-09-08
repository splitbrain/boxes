import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { closeBrowser, openPage, VIEWPORTS } from './browser.ts';
import {
  startStubOrchestrator,
  stubReview,
  stubSession,
  type StubOrchestrator,
} from './stub-orchestrator.ts';

/**
 * The back button, which on a phone is the navigation control.
 *
 * Every one of these presses the browser's own back — `page.goBack()` — or a
 * control the app calls back, and asserts where it lands. Nothing else in the
 * suite did, which is how the two came to disagree: every back arrow was a
 * link, so leaving a view pushed the view it left to, and the device's button
 * then went forward into what had just been left. Dialogs were worse — they
 * were component state, invisible to the one gesture a phone has for
 * dismissing them, so the press tore down the screen behind the dialog
 * instead.
 *
 * The strategy the assertions here are written against is in ARCHITECTURE.md:
 * places push, drill-downs pop, and modal surfaces are entries of their own.
 */

const DIST = resolve(import.meta.dirname, '../dist');
const SESSION = 'a1b2c3d4';

let stub: StubOrchestrator;

beforeAll(async () => {
  stub = await startStubOrchestrator(DIST, [stubSession({ id: SESSION })]);
});

beforeEach(() => {
  // A fresh session and a fresh review per test: one of these deletes the
  // session for real, and another writes a comment that would change the next
  // test's counts.
  stub.state.sessions = [stubSession({ id: SESSION })];
  stub.state.reviews[SESSION] = stubReview();
  stub.reviewCalls.length = 0;
});

afterAll(async () => {
  await closeBrowser();
  await stub?.close();
});

/**
 * Where the browser is in its own stack, as the router records it.
 *
 * The one thing a page can know about entries it is not on, and what makes
 * "this control pushed" and "this control popped" tellable apart: a pop that
 * lands on the right screen by pushing a copy of it looks identical on
 * screen, and only the count gives it away.
 */
function stackIndex(page: Page): Promise<number> {
  return page.evaluate(() => (window.history.state as { idx?: number } | null)?.idx ?? 0);
}

// --- places -----------------------------------------------------------------

test('the thread header pops the thread rather than pushing the list over it', async () => {
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await expect.poll(() => page.getByText('refactor auth').isVisible()).toBe(true);
    expect(await stackIndex(page)).toBe(0);

    await page.getByText('refactor auth').click();
    await page.waitForURL(`**/sessions/${SESSION}`);
    expect(await stackIndex(page)).toBe(1);

    await page.getByLabel('Back to sessions').click();
    await page.waitForURL(`${stub.url}/`);
    // The list it left, not a second copy of it: one entry, not three.
    await expect.poll(() => stackIndex(page)).toBe(0);

    // And the thread is where forward goes, which is only true of a pop.
    await page.goForward();
    await page.waitForURL(`**/sessions/${SESSION}`);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a file is a step on a phone: back to the tree, then to the thread', async () => {
  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION}`);
  try {
    await page.getByLabel("Review this session's code").click();
    await page.waitForURL(`**/sessions/${SESSION}/review`);
    await page.getByRole('button', { name: 'app a git repository' }).click();
    await page.getByRole('button', { name: 'src' }).click();
    await page.getByRole('button', { name: /boot\.ts/ }).click();
    await expect.poll(() => page.getByText('wire the router').isVisible()).toBe(true);

    // Thread, review, file: three entries, and the browser's own button walks
    // back out of them one at a time.
    expect(await stackIndex(page)).toBe(2);

    await page.goBack();
    await expect.poll(() => new URL(page.url()).search).not.toContain('path=');
    await expect.poll(() => page.getByRole('button', { name: 'app a git repository' }).isVisible()).toBe(true);

    await page.goBack();
    await page.waitForURL(`**/sessions/${SESSION}`);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a file is not a step on a pointer, where the tree never left', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}`,
    'dark',
    'desktop',
  );
  try {
    await page.getByLabel("Review this session's code").click();
    await page.waitForURL(`**/sessions/${SESSION}/review`);
    await page.getByRole('button', { name: 'app a git repository' }).click();
    await page.getByRole('button', { name: 'src' }).click();
    await page.getByRole('button', { name: /boot\.ts/ }).click();
    await expect.poll(() => page.getByText('wire the router').isVisible()).toBe(true);
    await page.getByRole('button', { name: /app\.ts/ }).click();
    await expect.poll(() => page.getByText('import { boot }').isVisible()).toBe(true);

    // Two files read, and no entry for either: the tree stayed beside them, so
    // picking one is selecting in a sidebar rather than travelling. Back
    // leaves the review, which is what this arrangement's one back control
    // says it does.
    expect(await stackIndex(page)).toBe(1);
    await page.goBack();
    await page.waitForURL(`**/sessions/${SESSION}`);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('leaving the review leaves none of its files behind to fall into', async () => {
  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION}`);
  try {
    await page.getByLabel("Review this session's code").click();
    await page.waitForURL(`**/sessions/${SESSION}/review`);
    await page.getByRole('button', { name: 'app a git repository' }).click();
    await page.getByRole('button', { name: 'src' }).click();
    await page.getByRole('button', { name: /boot\.ts/ }).click();
    await expect.poll(() => page.getByText('wire the router').isVisible()).toBe(true);
    expect(await stackIndex(page)).toBe(2);

    // A phone turned to landscape with a file open: the header's control is
    // now the one that leaves the review, and the file's entry is still on
    // the stack under it. Leaving is one press either way.
    await page.setViewportSize(VIEWPORTS.desktop);
    await expect.poll(() => page.getByLabel('Back to the thread').isVisible()).toBe(true);
    await page.getByLabel('Back to the thread').click();

    await page.waitForURL(`**/sessions/${SESSION}`);
    await expect.poll(() => stackIndex(page)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a pasted link with nothing beneath it steps up instead of out of the app', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review?path=app%2Fsrc%2Fboot.ts`,
  );
  try {
    await expect.poll(() => page.getByText('wire the router').isVisible()).toBe(true);
    // One entry, and it is the file: there is nothing of the app's below it.
    expect(await stackIndex(page)).toBe(0);

    await page.getByLabel('Back to the file list').click();
    await expect.poll(() => new URL(page.url()).search).not.toContain('path=');
    await expect.poll(() => page.getByRole('button', { name: 'app a git repository' }).isVisible()).toBe(true);
    // Rewritten in place rather than pushed: a step out must not add a step.
    expect(await stackIndex(page)).toBe(0);

    await page.getByLabel('Back to the thread').click();
    await page.waitForURL(`**/sessions/${SESSION}/threads/th1`);
    // Still the one entry. The parent took this one's place, so the browser's
    // own back button still leads out of the app, which is what it is for.
    expect(await stackIndex(page)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// --- modal surfaces ---------------------------------------------------------

test('back closes the hunk sheet and leaves the file where it was', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review?path=app%2Fsrc%2Fboot.ts`,
  );
  try {
    await expect.poll(() => page.getByLabel('Show the change at line 2').isVisible()).toBe(true);
    await page.getByLabel('Show the change at line 2').click();
    await expect.poll(() => page.getByText('Lines 1–4').isVisible()).toBe(true);
    // The sheet is an entry of its own, at the same URL as the file under it.
    await expect.poll(() => stackIndex(page)).toBe(1);

    await page.goBack();

    // Closed, and nothing else moved: the file is still open and still the
    // one in the URL. This used to close the file and leave the sheet up over
    // the tree, showing a hunk of a file that was no longer open.
    await expect.poll(() => page.locator('[data-slot="sheet-content"]').count()).toBe(0);
    await expect.poll(() => page.getByText('wire the router').isVisible()).toBe(true);
    expect(new URL(page.url()).search).toContain('path=app%2Fsrc%2Fboot.ts');
    expect(await stackIndex(page)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('closing a sheet by hand takes its entry back out with it', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review?path=app%2Fsrc%2Fboot.ts`,
  );
  try {
    await page.getByLabel('Show the change at line 2').click();
    await expect.poll(() => page.getByText('Lines 1–4').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect.poll(() => page.locator('[data-slot="sheet-content"]').count()).toBe(0);

    // A spent entry is not left on the stack: the next back press has to be
    // the one that leaves the file, not one that appears to do nothing.
    await expect.poll(() => stackIndex(page)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('back closes the comment composer without closing the file under it', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review?path=app%2Fsrc%2Fboot.ts`,
  );
  try {
    await page.locator('[data-line="2"] code').click();
    await expect.poll(() => page.getByText('Comment on line 2').isVisible()).toBe(true);
    await page.getByRole('textbox', { name: 'Comment on line 2' }).fill('half a thought');
    await expect.poll(() => stackIndex(page)).toBe(1);

    await page.goBack();

    // One press, one thing closed. It used to take the file with it, so what
    // had been typed went and the file had to be found again.
    await expect.poll(() => page.locator('[data-slot="sheet-content"]').count()).toBe(0);
    await expect.poll(() => page.getByText('wire the router').isVisible()).toBe(true);
    // Cancelled, not saved: nothing was written on the way out.
    expect(stub.reviewCalls).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('back cancels a confirmation instead of confirming it', async () => {
  stub.state.reviews[SESSION]!.annotations['app/src/app.ts'] = {
    2: { line: 2, comment: 'to be kept', outdated: false },
  };
  stub.state.reviews[SESSION]!.hasReview = true;

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION}/review`);
  try {
    await expect.poll(() => page.getByLabel('Start a new review').isVisible()).toBe(true);
    await page.getByLabel('Start a new review').click();
    await expect.poll(() => page.getByText('Start a new review?').isVisible()).toBe(true);
    await expect.poll(() => stackIndex(page)).toBe(1);

    await page.goBack();

    // Dismissed, and the review still there. A back press is not an answer to
    // a question, and it must never be read as the destructive one.
    await expect.poll(() => page.locator('[data-slot="dialog-content"]').count()).toBe(0);
    await expect.poll(() => page.getByLabel('Start a new review').isVisible()).toBe(true);
    expect(stub.reviewCalls).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// --- terminal actions -------------------------------------------------------

test('a deleted session is not what the entry left behind leads to', async () => {
  const { page, errors, close } = await openPage(stub.url, '/');
  try {
    await expect.poll(() => page.getByText('refactor auth').isVisible()).toBe(true);
    await page.getByLabel('Details and controls for refactor auth').click();
    await page.waitForURL(`**/sessions/${SESSION}/info`);

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => page.getByText('Delete refactor auth?').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click();

    // The list, in place of the view that acted rather than on top of it.
    await page.waitForURL(`${stub.url}/`);
    await expect.poll(() => page.getByText('No sessions yet').isVisible()).toBe(true);

    // And it stays there. The dialog was still mounted when the navigation
    // happened, and the entry it had pushed was the one replaced — so the
    // marker it would otherwise have taken back out on the way is somebody
    // else's entry now, and popping it would land on the session that was
    // just deleted.
    await new Promise((done) => setTimeout(done, 250));
    expect(new URL(page.url()).pathname).toBe('/');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the handoff prompt is staged once, not replayed by back and forward', async () => {
  stub.state.reviews[SESSION]!.annotations['app/src/app.ts'] = {
    2: { line: 2, comment: 'please fix', outdated: false },
  };
  stub.state.reviews[SESSION]!.hasReview = true;

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION}`);
  try {
    await page.getByLabel("Review this session's code").click();
    // Icon-only at this width, so the title is what names it.
    const handoff = page.getByTitle('Open the thread with a prompt to address these comments');
    await expect.poll(() => handoff.isVisible()).toBe(true);
    await handoff.click();

    // Back to the conversation it was opened from — the entry that was
    // already there, which is the route as it was entered rather than a
    // rebuilt one naming the thread.
    await page.waitForURL(`${stub.url}/sessions/${SESSION}`);
    await expect
      .poll(() => page.getByLabel('Message input').inputValue())
      .toContain('Read REVIEW.md');
    await expect.poll(() => stackIndex(page)).toBe(0);

    // Forward into the review and back out again. The prompt travelled beside
    // the router rather than in the entry's state, which the browser replays:
    // a turn nobody typed used to reappear in the composer here.
    await page.goForward();
    await expect.poll(() => handoff.isVisible()).toBe(true);
    await page.goBack();
    await page.waitForURL(`${stub.url}/sessions/${SESSION}`);
    await expect.poll(() => page.getByLabel('Message input').isVisible()).toBe(true);
    expect(await page.getByLabel('Message input').inputValue()).toBe('');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
