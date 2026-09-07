import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resolve } from 'node:path';
import { closeBrowser, openPage, shoot } from './browser.ts';
import {
  startStubOrchestrator,
  stubReview,
  stubSession,
  type StubOrchestrator,
} from './stub-orchestrator.ts';

/**
 * The review pages in a real browser, against the real production bundle and
 * a stub orchestrator that keeps real review state.
 *
 * The path the tests walk is the one the feature exists for: browse the tree,
 * open a file, comment on a line, and hand the review to the agent. Both
 * viewports, because the phone and the pointer arrangements are different
 * enough that one passing says little about the other.
 *
 * The fixture is a workspace, not a repository: two projects side by side and
 * a loose directory beside them. That is the shape the review is designed
 * around, so it is the one the browser walks.
 */

const DIST = resolve(import.meta.dirname, '../dist');
const SESSION = 'a1b2c3d4';

let stub: StubOrchestrator;

beforeAll(async () => {
  stub = await startStubOrchestrator(DIST, [stubSession({ id: SESSION })]);
});

beforeEach(() => {
  // A fresh review per test: comments are written for real, and a leftover
  // one would make the next test's counts wrong.
  stub.state.reviews[SESSION] = stubReview();
  stub.reviewCalls.length = 0;
});

afterAll(async () => {
  await closeBrowser();
  await stub.close();
});

// --- browsing ---------------------------------------------------------------

test('the tree is the whole screen on a phone, and a file replaces it', async () => {
  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION}/review`);
  try {
    // The workspace's own top level: two repositories and a directory that is
    // in neither. Every one of them is browsable, which is the whole change.
    await expect.poll(() => page.getByRole('button', { name: 'app a git repository' }).isVisible()).toBe(true);
    await expect.poll(() => page.getByRole('button', { name: 'lib a git repository' }).isVisible()).toBe(true);
    await expect.poll(() => page.getByRole('button', { name: /^notes/ }).isVisible()).toBe(true);
    // A repository root says it is one, so the boundaries are visible while
    // scrolling across them.
    expect(await page.getByLabel('a git repository').count()).toBe(2);

    // Directories start closed unless they are a single-child chain from the
    // top, which this fixture's three top-level entries are not.
    await page.getByRole('button', { name: 'app a git repository' }).click();
    await page.getByRole('button', { name: 'src' }).click();
    await expect.poll(() => page.getByRole('button', { name: /app\.ts/ }).isVisible()).toBe(true);
    // Status marks travel with the tree, in one response with it, and they
    // come from whichever repository owns the path.
    await expect.poll(() => page.getByLabel('modified').isVisible()).toBe(true);

    await page.getByRole('button', { name: /app\.ts/ }).click();

    // The file is in the URL, so it is linkable and the back button works.
    await expect.poll(() => new URL(page.url()).search).toContain('path=app%2Fsrc%2Fapp.ts');
    await expect.poll(() => page.getByText('import { boot }').isVisible()).toBe(true);
    await shoot(page, 'review-file-phone');

    // Back is one step of the stack — file → file list — and it is the
    // header's own button, the same control every other view goes back with.
    await page.getByLabel('Back to the file list').click();
    await expect.poll(() => new URL(page.url()).search).not.toContain('path=');
    await expect.poll(() => page.getByRole('button', { name: 'app a git repository' }).isVisible()).toBe(true);

    // And from the list, the next step out is the thread.
    await expect.poll(() => page.getByLabel('Back to the thread').isVisible()).toBe(true);

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the tree is a column beside the pane on a desktop', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review?path=app%2Fsrc%2Fboot.ts`,
    'dark',
    'desktop',
  );
  try {
    await expect.poll(() => page.getByText('wire the router').isVisible()).toBe(true);
    // Both at once, which is the whole difference from the phone arrangement.
    await expect.poll(() => page.getByRole('button', { name: 'app a git repository' }).isVisible()).toBe(true);
    await page.getByRole('button', { name: 'app a git repository' }).click();
    await page.getByRole('button', { name: 'src' }).click();
    await expect.poll(() => page.getByRole('button', { name: /boot\.ts/ }).isVisible()).toBe(true);
    // The header says which repository the open file belongs to, in place of
    // a root the review no longer has.
    await expect.poll(() => page.getByText(/· app/).isVisible()).toBe(true);
    // The list and the file are one view here, so there is no step between
    // the review and the thread: back leaves, with a file open or without.
    expect(await page.getByLabel('Back to the file list').count()).toBe(0);
    await expect.poll(() => page.getByLabel('Back to the thread').isVisible()).toBe(true);
    await shoot(page, 'review-file-desktop');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a pasted link opens straight to its file', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review?path=app%2FREADME.md`,
  );
  try {
    await expect.poll(() => page.getByText('A project the agent cloned.').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the code is highlighted, and a line is addressable', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review?path=app%2Fsrc%2Fapp.ts`,
    'dark',
    'desktop',
  );
  try {
    await expect.poll(() => page.locator('[data-line="1"]').isVisible()).toBe(true);
    // Every line is its own element, which is what makes tapping one possible.
    expect(await page.locator('[data-line]').count()).toBe(3);
    // Tokens arrive after the grammar has loaded, so this is polled.
    await expect
      .poll(() => page.locator('[data-line="1"] code span').count(), { timeout: 15_000 })
      .toBeGreaterThan(1);
    // Coloured by a custom property, so light and dark need no re-tokenize.
    const colour = await page
      .locator('[data-line="1"] code span')
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(colour).not.toBe('');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a gutter marker opens the hunk, deleted lines included', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review?path=app%2Fsrc%2Fboot.ts`,
  );
  try {
    await expect.poll(() => page.getByText('lines deleted here').isVisible()).toBe(true);
    await page.getByText('lines deleted here').click();

    // The hunk is the only place the removed lines exist, so this is where
    // hover-on-a-tooltip had to go.
    await expect.poll(() => page.getByText('Lines 1–4').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('console.log("boot")').isVisible()).toBe(true);
    await shoot(page, 'review-hunk-phone', 'viewport');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the gutter opens the hunk, and the code opens the comment', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review?path=app%2Fsrc%2Fboot.ts`,
  );
  try {
    // The row is split: the gutter is the change, the code is the comment. A
    // deletion marker is not the only way in, which is what it was reduced to
    // when the gutter was spent on commenting.
    await expect.poll(() => page.getByLabel('Show the change at line 2').isVisible()).toBe(true);
    await page.getByLabel('Show the change at line 2').click();
    await expect.poll(() => page.getByText('Lines 1–4').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('console.log("boot")').isVisible()).toBe(true);
    await page.keyboard.press('Escape');

    // And the code half of the same line still starts a comment.
    await expect.poll(() => page.locator('[data-slot="sheet-content"]').count()).toBe(0);
    await page.locator('[data-line="2"] code').click();
    await expect.poll(() => page.getByText('Comment on line 2').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a line with no hunk behind it has no gutter button', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review?path=app%2Fsrc%2Fapp.ts`,
  );
  try {
    // An unchanged file has nothing to show, so its gutter is not a target
    // that lights up under the thumb and then does nothing.
    await expect.poll(() => page.locator('[data-line="1"] code').isVisible()).toBe(true);
    expect(await page.getByLabel('Show the change at line 1').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a file the change deleted is listed, and says it is gone', async () => {
  // Listed by its status alone: it is on no disk and in no ls-files, which is
  // exactly why it used to fall out of the tree the moment it mattered.
  stub.state.reviews[SESSION]!.statuses['app/src/old.ts'] = 'deleted';
  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review?path=app%2Fsrc%2Fold.ts`,
    'dark',
    'desktop',
  );
  try {
    await expect
      .poll(() => page.getByText('This file was deleted, so there is nothing left to read.').isVisible())
      .toBe(true);
    // And it is in the tree, under the directory it was in.
    await page.getByRole('button', { name: 'app a git repository' }).click();
    await page.getByRole('button', { name: 'src' }).click();
    await expect.poll(() => page.getByRole('button', { name: /old\.ts/ }).isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('prev/next steps through the changes', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review?path=app%2Fsrc%2Fboot.ts`,
    'dark',
    'desktop',
  );
  try {
    // Two changed lines in the fixture and one block deleted between them,
    // which is three places to step through: a deletion has no line of its
    // own, so it counts at the line its marker sits under.
    await expect.poll(() => page.getByLabel('3 changes').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Next change' }).click();
    // Comments start at zero, and their buttons are disabled until there are
    // some — a step button that does nothing is worse than one that is off.
    expect(await page.getByRole('button', { name: 'Next comment' }).isDisabled()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// --- commenting -------------------------------------------------------------

test('commenting a line on a phone writes it through the API', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review?path=app%2Fsrc%2Fboot.ts`,
  );
  try {
    // The code half of the row, which is the comment target: it is not
    // labelled, because a button names itself from its contents and the
    // contents here are the line of code.
    await expect.poll(() => page.locator('[data-line="2"] code').isVisible()).toBe(true);
    await page.locator('[data-line="2"] code').click();

    // On touch the composer is a bottom sheet, so the keyboard has somewhere
    // to be that is not on top of it.
    await expect.poll(() => page.getByText('Comment on line 2').isVisible()).toBe(true);
    await shoot(page, 'review-composer-phone', 'viewport');

    await page.getByRole('textbox', { name: 'Comment on line 2' }).fill('this TODO needs an owner');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();

    // Written where the agent will read it, which is the point of the feature.
    await expect.poll(() => stub.reviewCalls.length).toBe(1);
    expect(stub.reviewCalls[0]).toMatchObject({
      method: 'PUT',
      sessionId: SESSION,
      body: { path: 'app/src/boot.ts', line: 2, comment: 'this TODO needs an owner' },
    });
    expect(stub.state.reviews[SESSION]!.annotations['app/src/boot.ts']?.[2]?.comment).toBe(
      'this TODO needs an owner',
    );

    // And shown inline under its line, on this size as on the other.
    await expect.poll(() => page.getByText('this TODO needs an owner').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('commenting a line on a desktop uses the inline composer', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review?path=app%2Fsrc%2Fapp.ts`,
    'dark',
    'desktop',
  );
  try {
    await expect.poll(() => page.locator('[data-line="3"] code').isVisible()).toBe(true);
    await page.locator('[data-line="3"] code').click();

    // Inline, so nothing was put in a sheet.
    await expect
      .poll(() => page.getByRole('textbox', { name: 'Comment on line 3' }).isVisible())
      .toBe(true);
    expect(await page.locator('[data-slot="sheet-content"]').count()).toBe(0);

    await page.getByRole('textbox', { name: 'Comment on line 3' }).fill('call this in main');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();

    await expect.poll(() => stub.reviewCalls.length).toBe(1);
    await expect.poll(() => page.getByText('call this in main').isVisible()).toBe(true);
    // The tree's badge follows without a tree refetch.
    await expect.poll(() => page.getByLabel('1 comment').first().isVisible()).toBe(true);
    await shoot(page, 'review-comment-desktop');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a comment can be edited and deleted', async () => {
  stub.state.reviews[SESSION]!.annotations['app/src/app.ts'] = {
    2: { line: 2, comment: 'first thoughts', outdated: false },
  };
  stub.state.reviews[SESSION]!.hasReview = true;

  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review?path=app%2Fsrc%2Fapp.ts`,
    'dark',
    'desktop',
  );
  try {
    await expect.poll(() => page.getByText('first thoughts').isVisible()).toBe(true);

    await page.getByRole('button', { name: 'Edit the comment on line 2' }).click();
    const field = page.getByRole('textbox', { name: 'Comment on line 2' });
    await expect.poll(() => field.isVisible()).toBe(true);
    // Editing starts from what is there, rather than from an empty box.
    expect(await field.inputValue()).toBe('first thoughts');
    await field.fill('second thoughts');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.getByText('second thoughts').isVisible()).toBe(true);

    await page.getByRole('button', { name: 'Delete the comment on line 2' }).click();
    // Asked about first: the bin sits beside the pencil and a comment is
    // typed prose with no undo.
    await expect
      .poll(() => page.getByText('Delete the comment on line 2?').isVisible())
      .toBe(true);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => page.getByText('second thoughts').isVisible()).toBe(false);
    expect(stub.state.reviews[SESSION]!.annotations['app/src/app.ts']).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an outdated comment says the code moved', async () => {
  stub.state.reviews[SESSION]!.annotations['app/src/app.ts'] = {
    1: { line: 1, comment: 'about the old import', outdated: true },
  };
  stub.state.reviews[SESSION]!.hasReview = true;

  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review?path=app%2Fsrc%2Fapp.ts`,
    'dark',
    'desktop',
  );
  try {
    await expect.poll(() => page.getByText('about the old import').isVisible()).toBe(true);
    // In words rather than a symbol: what "outdated" means is not guessable.
    expect(
      await page.getByText('The code this was written about has changed').isVisible(),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('handing the review to the agent stages a prompt, unsent', async () => {
  stub.state.reviews[SESSION]!.annotations['app/src/app.ts'] = {
    2: { line: 2, comment: 'please fix', outdated: false },
  };
  stub.state.reviews[SESSION]!.hasReview = true;

  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review`,
    'dark',
    'desktop',
  );
  try {
    await expect.poll(() => page.getByRole('button', { name: /Hand to agent/ }).isVisible()).toBe(
      true,
    );
    await page.getByRole('button', { name: /Hand to agent/ }).click();

    // Lands in the thread, with the prompt sitting in the composer and no
    // turn started: what to do with a review is the reviewer's call.
    await expect.poll(() => page.url()).toContain(`/sessions/${SESSION}/threads/th1`);
    await expect
      .poll(() => page.getByText('Read REVIEW.md and address the comments in it.').isVisible())
      .toBe(true);
    // One line, and the same one however many repositories the workspace
    // holds: there is exactly one REVIEW.md, at the top of the workspace.
    await shoot(page, 'review-handoff-desktop');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a new review clears every comment, behind a confirmation', async () => {
  stub.state.reviews[SESSION]!.annotations['app/src/app.ts'] = {
    2: { line: 2, comment: 'to be discarded', outdated: false },
  };
  stub.state.reviews[SESSION]!.hasReview = true;

  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review?path=app%2Fsrc%2Fapp.ts`,
    'dark',
    'desktop',
  );
  try {
    await expect.poll(() => page.getByText('to be discarded').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Start a new review' }).click();

    await expect.poll(() => page.getByText('Start a new review?').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Delete the review' }).click();

    await expect.poll(() => page.getByText('to be discarded').isVisible()).toBe(false);
    expect(stub.state.reviews[SESSION]!.hasReview).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// --- the base revision ------------------------------------------------------

test('the base picker sets a revision and says which one is active', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review`,
    'dark',
    'desktop',
  );
  try {
    // Without one, the status line says what the diff is actually against.
    await expect.poll(() => page.getByText(/vs working tree/).isVisible()).toBe(true);

    await page.getByRole('button', { name: /HEAD/ }).click();
    await page.getByRole('textbox', { name: 'Base revision' }).fill('main');
    await page.getByRole('button', { name: 'Compare' }).click();

    // The status line carries it, because it decides what every colour in the
    // tree and every marker in the gutter means.
    await expect.poll(() => page.getByText(/vs main/).isVisible()).toBe(true);
    expect(stub.reviewCalls.at(-1)).toMatchObject({ method: 'PUT base', body: { rev: 'main' } });

    // And the picker says where it landed in each repository, because one
    // expression resolves separately in every one of them.
    await page.getByRole('button', { name: /main/ }).click();
    await expect.poll(() => page.getByText('00000000').isVisible()).toBe(true);
    await shoot(page, 'review-base-desktop');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a revision that names nothing in one repository is reported, not refused', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review`,
    'dark',
    'desktop',
  );
  try {
    await page.getByRole('button', { name: /HEAD/ }).click();
    await page.getByRole('textbox', { name: 'Base revision' }).fill('only-app');
    await page.getByRole('button', { name: 'Compare' }).click();

    // Resolved in one repository and not in the other: an ordinary shape, not
    // a failed request. The header counts it and the picker names the one
    // that fell back to its own working tree.
    await expect.poll(() => page.getByText(/vs only-app \(1 of 2\)/).isVisible()).toBe(true);
    await page.getByRole('button', { name: /only-app/ }).click();
    await expect.poll(() => page.getByText('working tree').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a revision that is not one anywhere is reported, not swallowed', async () => {
  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review`,
    'dark',
    'desktop',
  );
  try {
    await page.getByRole('button', { name: /HEAD/ }).click();
    await page.getByRole('textbox', { name: 'Base revision' }).fill('nope');
    await page.getByRole('button', { name: 'Compare' }).click();

    await expect.poll(() => page.getByRole('alert').isVisible()).toBe(true);
    await expect.poll(() => page.getByText(/unknown revision: nope/).isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// --- degraded shapes --------------------------------------------------------

test('a workspace with no repository still browses and comments', async () => {
  stub.state.reviews[SESSION] = stubReview({
    repos: [],
    statuses: {},
    diffs: {},
    files: { 'notes.txt': 'just some notes\nnothing tracked\n' },
  });

  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review?path=notes.txt`,
    'dark',
    'desktop',
  );
  try {
    await expect.poll(() => page.getByText('just some notes').isVisible()).toBe(true);
    // The git features are off and say so, rather than being absent silently.
    await expect.poll(() => page.getByText(/no git/).isVisible()).toBe(true);
    // No base to pick when there is no repository to pick one in.
    expect(await page.getByRole('button', { name: /HEAD/ }).isVisible()).toBe(false);
    // Commenting still works, which is the point of degrading rather than
    // refusing.
    await page.locator('[data-line="1"] code').click();
    await page.getByRole('textbox', { name: 'Comment on line 1' }).fill('still reviewable');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect.poll(() => stub.reviewCalls.length).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a session whose workspace cannot be read says what to do', async () => {
  stub.state.reviews[SESSION] = stubReview({
    fail: {
      status: 409,
      error:
        'This session stores its workspace in a volume the orchestrator cannot read. ' +
        'Start the session once to migrate it, then review it.',
    },
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION}/review`);
  try {
    // A legacy session, before its next start migrates it. The message has to
    // name the fix, since nothing about the view suggests one.
    await expect.poll(() => page.getByRole('alert').isVisible()).toBe(true);
    await expect.poll(() => page.getByText(/Start the session once to migrate it/).isVisible()).toBe(true);
    await shoot(page, 'review-legacy-phone');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an empty workspace says so rather than showing nothing', async () => {
  stub.state.reviews[SESSION] = stubReview({ files: {}, statuses: {}, diffs: {}, repos: [] });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION}/review`);
  try {
    await expect.poll(() => page.getByText(/This workspace is empty/).isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// --- reading position -------------------------------------------------------

test('each file remembers how far it was read, and a new one starts at the top', async () => {
  // Long enough to scroll, which the small fixture files are not.
  stub.state.reviews[SESSION] = stubReview({
    files: {
      'long.ts': Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join('\n'),
      'short.ts': 'const one = 1;\n',
    },
    repos: [{ path: '', name: 'workspace', head: 'a'.repeat(40), baseCommit: '' }],
    statuses: {},
    diffs: {},
  });

  const { page, errors, close } = await openPage(
    stub.url,
    `/sessions/${SESSION}/review`,
    'dark',
    'desktop',
  );
  try {
    const pane = page.locator('[data-slot="review-code-pane"]');
    const offset = (): Promise<number> => pane.evaluate((el) => el.scrollTop);

    await page.getByRole('button', { name: /long\.ts/ }).click();
    await expect.poll(() => pane.isVisible()).toBe(true);
    await pane.evaluate((el) => {
      el.scrollTop = 1200;
    });
    await expect.poll(offset).toBe(1200);

    // One pane serves every file, so without help the next one opens
    // wherever this one was left.
    await page.getByRole('button', { name: /short\.ts/ }).click();
    await expect.poll(() => page.getByText('const one = 1;').isVisible()).toBe(true);
    await expect.poll(offset).toBe(0);

    // And coming back picks up where the reading stopped.
    await page.getByRole('button', { name: /long\.ts/ }).click();
    await expect.poll(offset).toBe(1200);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the review header gives way to reading the file, and returns', async () => {
  // Long enough to scroll, which the small fixture files are not.
  stub.state.reviews[SESSION] = stubReview({
    files: {
      'long.ts': Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join('\n'),
    },
    repos: [{ path: '', name: 'workspace', head: 'a'.repeat(40), baseCommit: '' }],
    statuses: {},
    diffs: {},
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION}/review`);
  try {
    const pane = page.locator('[data-slot="review-code-pane"]');
    const shelf = page.locator('[data-slot="shelf"]');
    const away = (): Promise<boolean> => shelf.evaluate((el) => el.hasAttribute('data-away'));
    /** Whether the header is where a thumb reaches for it. */
    const inReach = (): Promise<boolean> =>
      page.evaluate(() => !!document.elementFromPoint(20, 10)?.closest('header'));

    /**
     * Reads down the pane, a frame's worth of pixels at a time.
     *
     * Driven by the position rather than by a wheel. A notch is not a scroll:
     * it starts one, which the browser animates out over however many frames
     * the machine can spare, so a wheeled test is really asking how busy the
     * box is — and answering differently on a loaded one. A step per frame is
     * what the listener sees either way, and it sees the same one everywhere.
     *
     * What run of steps adds up to which decision is settled in
     * `src/lib/scroll-away.test.ts`, against no browser at all. What is left
     * for here is that it is this pane being listened to, and that the header
     * really does collapse out of reach when it goes.
     */
    const read = (dy: number, steps: number): Promise<void> =>
      pane.evaluate(
        (el, [by, count]) =>
          new Promise<void>((done) => {
            let left = count;
            const step = (): void => {
              if (left-- <= 0) return done();
              el.scrollTop += by;
              requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          }),
        [dy, steps] as [number, number],
      );

    await page.getByRole('button', { name: /long\.ts/ }).click();
    await expect.poll(() => pane.isVisible()).toBe(true);
    expect(await away()).toBe(false);

    await read(100, 4);
    await expect.poll(away).toBe(true);
    // And nothing in it is reachable while it is away — `inert`, and a parent
    // collapsed to nothing. Below md the only way to the file tree is the
    // button in this header, so switching files from here takes a flick up
    // first, the same flick as in a thread.
    expect(await inReach()).toBe(false);

    await read(-100, 2);
    await expect.poll(away).toBe(false);
    expect(await inReach()).toBe(true);

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// --- the entry points -------------------------------------------------------

test('the review is reachable from the session card and the thread header', async () => {
  const list = await openPage(stub.url, '/', 'dark', 'desktop');
  try {
    await expect.poll(() => list.page.getByRole('link', { name: 'Review' }).isVisible()).toBe(true);
    await list.page.getByRole('link', { name: 'Review' }).click();
    await expect.poll(() => list.page.url()).toContain(`/sessions/${SESSION}/review`);
    expect(list.errors).toEqual([]);
  } finally {
    await list.close();
  }

  const thread = await openPage(stub.url, `/sessions/${SESSION}`, 'dark', 'desktop');
  try {
    const link = thread.page.getByRole('link', { name: "Review this session's code" });
    await expect.poll(() => link.isVisible()).toBe(true);
    await link.click();
    await expect.poll(() => thread.page.url()).toContain(`/sessions/${SESSION}/review`);
    expect(thread.errors).toEqual([]);
  } finally {
    await thread.close();
  }
});
