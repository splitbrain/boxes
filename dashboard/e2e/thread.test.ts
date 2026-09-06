import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { resolve } from 'node:path';
import type { SessionUpdate } from '../src/stores/thread/acp-types.ts';
import type { Page } from 'playwright';
import { closeBrowser, openPage, shoot } from './browser.ts';
import { startStubOrchestrator, stubSession, type StubOrchestrator } from './stub-orchestrator.ts';
import type { GatewayScript } from './stub-gateway.ts';

/**
 * The live thread against a stub gateway speaking the agent side of ACP.
 *
 * Everything asserted here is protocol behaviour, not a private arrangement:
 * the stub answers session/new, session/load, session/prompt and
 * session/cancel the way the real gateway does.
 */

const DIST = resolve(import.meta.dirname, '../dist');
const SESSION = stubSession();

/**
 * Turns a wheel a notch at a time, the way a hand arrives: a frame's worth of
 * pixels per event, with a moment between them. One event carrying the whole
 * distance is a jump, and nothing that reads a scroller should believe it.
 */
async function wheel(page: Page, dy: number, notches: number): Promise<void> {
  for (let i = 0; i < notches; i += 1) {
    await page.mouse.wheel(0, dy);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

/** A streamed assistant reply, in the chunks an adapter would send it. */
function reply(...texts: string[]): SessionUpdate[] {
  return texts.map(
    (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) as SessionUpdate,
  );
}

/**
 * A turn spent working: a thought and a tool call at a time, which is what
 * most of a long one is made of. A paragraph of thinking rather than a line,
 * so a handful of steps is a screenful and the turn reaches the end of the
 * room its anchor keeps without having to run for a minute first.
 */
function working(steps: number): SessionUpdate[] {
  return Array.from({ length: steps }, (_, i) => [
    {
      sessionUpdate: 'agent_thought_chunk',
      content: {
        type: 'text',
        text: [
          `Thinking about step ${i + 1}, and what it needs.`,
          'The file has to be read before anything is said about it,',
          'and what it says decides which one is read next.',
        ].join(' '),
      },
    },
    {
      sessionUpdate: 'tool_call',
      toolCallId: `call-${i + 1}`,
      title: `Step ${i + 1}: read file-${i + 1}.ts`,
      kind: 'read',
      status: 'completed',
      rawInput: { path: `file-${i + 1}.ts` },
    },
  ]).flat() as SessionUpdate[];
}

/**
 * How far past the bottom of the viewport the newest thing a turn has written
 * sits. Negative is on screen.
 *
 * Not the scroller's own distance from its end: a turn holds empty space
 * under its answer for as long as the answer is shorter than the screen — the
 * room the anchor needs to keep the prompt at the top — and a screenful of
 * that below the fold hides nothing. What can be read is the question.
 */
function overhang(page: Page): Promise<number> {
  return page.evaluate(() => {
    const viewport = document.querySelector('[data-slot="aui_thread-viewport"]')!;
    const written = document.querySelectorAll('[data-slot="aui_assistant-message-content"]');
    const last = written[written.length - 1];
    if (!last) return 0;
    return Math.round(last.getBoundingClientRect().bottom - viewport.getBoundingClientRect().bottom);
  });
}

/**
 * A real PNG, small enough to sit in the source: two bands and a diagonal, so
 * a screenshot of this test shows an image rather than a plausible rectangle.
 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAMgAAAB4CAIAAAA48Cq8AAAB4UlEQVR42u3WwUkDARRF0SklpaVcS7GGrBRcGzIDF316ws02hJnD4x+Pbz63+5t0uePx9OMBKYGFl0JYbKmChZfOwfr8sqUE1llbeOlVWHgphMWWKlh4KYR1gZdHqVdhmS5VsPBSCIstVbDwUgjLUa8QlulSBQsvhbDYUgULL4WwHPUKYZkuVbDwUgiLLR3pr+MF1m/h5ZWAZbr007DwAostDcLCCyxHvTZhmS6w8NIgLLbAwkuDsBz1YJkuDcLCCyy2NAgLL7Ac9dqEZbrAwguszf/NFlh4gfUPeHnlYJkusPDSH4bFFlh4geWoF1imCyy8wGJLYOEFlqMeLNMlsPACiy2w8MLrdVjv95u+OmXL43oeWNdt4QUWXmCxBRZeeIHlqAfLdIGFF15gsQUWXmDhxRZYpgssvMASW2DhBZajHiyZLrDwAostsIQXWI56sEwXWMILLLbAwmuNF1iOerDY2uEFFl5gsbVjCyy8wMJrxxZYpgssvHZ4gcUWWHjt8ALLUQ+WdqYLLLzA0o4tsPACSztHPVimCyzt8AKLrcQWWHglvMDCK7EFFlsJL7DwSniBxVZiCyy8El5g4ZXYAouthBdYSniBpcQWWEp4gaXkqAdLyXSBpYQXWEpsgaWE1wex055aMLbECwAAAABJRU5ErkJggg==';

let stub: StubOrchestrator;

/** Starts a stub with the given gateway behaviour. */
async function start(script?: Partial<GatewayScript>): Promise<void> {
  stub = await startStubOrchestrator(DIST, [SESSION], script);
}

beforeEach(() => {
  stub = undefined as unknown as StubOrchestrator;
});

afterEach(async () => {
  await stub?.close();
});

afterAll(async () => {
  await closeBrowser();
});

test('a prompt streams back and renders as it arrives', async () => {
  await start({
    prompts: [
      {
        match: (t) => t.includes('summarise'),
        gapMs: 120,
        updates: reply('The proxy ', '**vets** every ', 'resolved address.'),
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    const input = page.getByLabel('Message input');
    await input.fill('summarise the proxy');
    await input.press('Control+Enter');

    // The first chunk shows before the last has been sent, which is what
    // progressive rendering means.
    await expect.poll(() => page.getByText('The proxy').isVisible()).toBe(true);
    expect(stub.gateway.prompts).toEqual(['summarise the proxy']);

    await expect
      .poll(() => page.getByText('resolved address.', { exact: false }).isVisible())
      .toBe(true);
    // Markdown, not literal asterisks.
    expect(await page.locator('strong', { hasText: 'vets' }).count()).toBe(1);

    // The prompt itself is in the thread too.
    await expect.poll(() => page.getByText('summarise the proxy').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an attached image is uploaded, named in the prompt, and shown from the workspace', async () => {
  await start({ prompts: [{ match: () => true, updates: reply('The margin is wrong.') }] });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // The picker is opened by a button that builds its own input, so the file
    // arrives through the chooser rather than through a locator.
    const chooser = page.waitForEvent('filechooser');
    await page.getByLabel('Add Attachment').click();
    await (
      await chooser
    ).setFiles({ name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });

    const input = page.getByLabel('Message input');
    await input.fill('what is wrong here?');
    await input.press('Control+Enter');

    // Uploaded into the session's workspace, before the prompt that names it.
    await expect.poll(() => stub.attachmentUploads.length).toBe(1);
    expect(stub.attachmentUploads[0]!.name).toBe('shot.png');
    expect(stub.attachmentUploads[0]!.sessionId).toBe(SESSION.id);

    // The note saying where it was saved, then what was typed. No bytes: the
    // picture is in the workspace, and the prompt carries the path to it.
    await expect.poll(() => stub.gateway.promptBlocks.length).toBe(1);
    const blocks = stub.gateway.promptBlocks[0]!;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'text']);
    expect(blocks[0]!.text).toContain('.boxes/attachments/shot.png');
    expect(blocks[0]!.text).toContain('image/png');
    expect(blocks[1]!.text).toBe('what is wrong here?');

    // What the thread shows is the picture — fetched back from the session's
    // workspace — and not the note that went with it.
    const picture = page.locator('[data-slot="aui_user-message-image"] img').first();
    await expect.poll(() => picture.count()).toBe(1);
    expect(await picture.getAttribute('src')).toBe(
      `/api/sessions/${SESSION.id}/attachments/shot.png`,
    );
    // Loaded, rather than merely pointed at something.
    await expect
      .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    expect(await page.getByText('<attachments>').count()).toBe(0);
    await shoot(page, 'thread-attached-image');

    // And again from the transcript rather than from the echo: a reconnect
    // replays what was said, and the note about the attachment is plain text
    // that survives that trip, so the thread reads the same both ways.
    await page.reload();
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    await expect.poll(() => page.locator('[data-slot="aui_user-message-image"]').count()).toBe(1);
    expect(await page.getByText('<attachments>').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an attached SVG is shown as the drawing it is', async () => {
  await start({ prompts: [{ match: () => true, updates: reply('A box and an arrow.') }] });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    const chooser = page.waitForEvent('filechooser');
    await page.getByLabel('Add Attachment').click();
    await (
      await chooser
    ).setFiles({
      name: 'diagram.svg',
      mimeType: 'image/svg+xml',
      // With a script in it, which is the case the served type is about: an
      // <img> runs nothing, and the response's CSP covers opening it directly.
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40">' +
          '<script>window.parent.alert(1)</script><rect width="80" height="40" fill="teal"/></svg>',
      ),
    });

    const input = page.getByLabel('Message input');
    await input.fill('what does this show?');
    await input.press('Control+Enter');

    await expect.poll(() => stub.gateway.promptBlocks.length).toBe(1);
    expect(stub.gateway.promptBlocks[0]![0]!.text).toContain('image/svg+xml');

    const picture = page.locator('[data-slot="aui_user-message-image"] img').first();
    await expect.poll(() => picture.count()).toBe(1);
    await expect
      .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(80);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an attached file that is not an image travels as a path, and reads as a chip', async () => {
  await start({ prompts: [{ match: () => true, updates: reply('It is a receipt.') }] });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    const chooser = page.waitForEvent('filechooser');
    await page.getByLabel('Add Attachment').click();
    await (
      await chooser
    ).setFiles({
      name: 'report.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 not really'),
    });

    const input = page.getByLabel('Message input');
    await input.fill('what does this say?');
    await input.press('Control+Enter');

    await expect.poll(() => stub.gateway.promptBlocks.length).toBe(1);
    const blocks = stub.gateway.promptBlocks[0]!;
    // A PDF is read from the workspace by the agent's own tools, and shows
    // here as a chip: the browser has nothing it could render.
    expect(blocks.map((b) => b.type)).toEqual(['text', 'text']);
    expect(blocks[0]!.text).toContain('.boxes/attachments/report.pdf');
    expect(blocks[0]!.text).toContain('application/pdf');

    // The chip stands in for the block of instructions that carried it, and
    // opens the file: served as application/pdf, so a tab shows it rather
    // than saving it.
    await expect.poll(() => page.getByText('report.pdf').isVisible()).toBe(true);
    const link = page.locator('[data-slot="aui_user-message-file"] a').first();
    const href = await link.getAttribute('href');
    expect(href).toBe(`/api/sessions/${SESSION.id}/attachments/report.pdf`);
    expect(await link.getAttribute('target')).toBe('_blank');
    expect(await link.getAttribute('rel')).toContain('noopener');

    const served = await page.request.get(`${stub.url}${href}`);
    expect(served.headers()['content-type']).toBe('application/pdf');
    expect(await page.getByText('<attachments>').count()).toBe(0);
    await shoot(page, 'thread-attached-file');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a turn with nothing to show yet shows the spinner, and stops once it has', async () => {
  await start({
    // Long enough that the spinner can be read without racing the answer:
    // a detached element has no computed style, and the assertions below
    // would then be measuring the message that replaced it.
    prompts: [{ match: () => true, gapMs: 2500, updates: reply('Eventually.') }],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('think about it');
    await input.press('Control+Enter');

    // The gap before the first chunk is the whole point of this indicator: it
    // is often the only thing on the screen, and it has to be visibly moving
    // rather than a page that has stopped repainting.
    const spinner = page.getByRole('img', { name: 'Assistant is working' });
    await expect.poll(() => spinner.isVisible()).toBe(true);
    await expect.poll(() => spinner.locator('rect').count()).toBe(9);
    await expect
      .poll(() =>
        spinner
          .locator('rect')
          .first()
          .evaluate((el) => getComputedStyle(el).animationName),
      )
      .toBe('spinner-block');

    // And it is gone as soon as there is something to read instead.
    await expect
      .poll(() => page.getByText('Eventually.').isVisible(), { timeout: 10_000 })
      .toBe(true);
    await expect.poll(() => spinner.count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('reloading mid-conversation replays the whole thread', async () => {
  await start({
    prompts: [{ match: () => true, updates: reply('First answer.') }],
  });

  const first = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => first.page.getByText('connected').isVisible()).toBe(true);
    const input = first.page.getByLabel('Message input');
    await input.fill('question one');
    await input.press('Control+Enter');
    await expect.poll(() => first.page.getByText('First answer.').isVisible()).toBe(true);
  } finally {
    await first.close();
  }

  // A fresh browser gets the same thread back, because session/load replays
  // it as notifications.
  const second = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => second.page.getByText('First answer.').isVisible()).toBe(true);
    await expect.poll(() => second.page.getByText('question one').isVisible()).toBe(true);
    // Replayed once, not twice.
    expect(await second.page.getByText('First answer.').count()).toBe(1);
    expect(second.errors).toEqual([]);
  } finally {
    await second.close();
  }
});

test('a second tab sees updates live', async () => {
  await start({
    prompts: [{ match: () => true, updates: reply('Shared answer.') }],
  });

  const a = await openPage(stub.url, `/sessions/${SESSION.id}`);
  const b = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => a.page.getByText('connected').isVisible()).toBe(true);
    await expect.poll(() => b.page.getByText('connected').isVisible()).toBe(true);
    await expect.poll(() => stub.gateway.attached()).toBe(2);

    const input = a.page.getByLabel('Message input');
    await input.fill('ask once');
    await input.press('Control+Enter');

    // The gateway broadcasts every update to every attached browser.
    await expect.poll(() => a.page.getByText('Shared answer.').isVisible()).toBe(true);
    await expect.poll(() => b.page.getByText('Shared answer.').isVisible()).toBe(true);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  } finally {
    await a.close();
    await b.close();
  }
});

test('cancelling stops the run state', async () => {
  await start({
    prompts: [
      { match: () => true, updates: reply('Working on it…'), hold: true },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('take your time');
    await input.press('Control+Enter');

    // While the turn runs the composer offers a stop instead of a send.
    const cancel = page.getByLabel('Stop generating');
    await expect.poll(() => cancel.isVisible()).toBe(true);

    await cancel.click();
    await expect.poll(() => cancel.isVisible()).toBe(false);
    await expect.poll(() => page.getByLabel('Send message').isVisible()).toBe(true);

    stub.gateway.release();
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a turn held open for background work still hands the composer back', async () => {
  // The shape the adapter actually produces: the agent answers, spawns
  // something that runs on, and the prompt stays open until it settles. The
  // thread is waiting for its reader for the whole of that.
  await start({
    prompts: [
      {
        match: () => true,
        updates: reply('Started the build. I will report back.'),
        hold: true,
        background: [
          { toolCallId: 'toolu_1', tool: 'Bash', title: 'npm run build', startedAt: Date.now() },
        ],
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('build it');
    await input.press('Control+Enter');

    await expect.poll(() => page.getByText('I will report back').isVisible()).toBe(true);

    // The composer is yours again, though the prompt upstream is still open.
    await expect
      .poll(() => page.getByLabel('Send message').isVisible(), { timeout: 10_000 })
      .toBe(true);
    expect(await page.getByLabel('Stop generating').count()).toBe(0);

    // And what is still going on says so, above the composer, where the
    // transcript cannot say it.
    const bar = page.locator('[data-slot="boxes_background-bar"]');
    await expect.poll(() => bar.isVisible()).toBe(true);
    await expect.poll(() => page.getByText('1 task running in the background').isVisible()).toBe(true);

    // Including for a browser that arrives afterwards and has only the
    // replay to go on — the tasks reach it with the thread state.
    await page.reload();
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    await expect.poll(() => bar.isVisible()).toBe(true);
    await bar.getByText('1 task running in the background').click();
    await expect.poll(() => page.getByText('npm run build').isVisible()).toBe(true);

    // And when the task reports itself over, the bar goes with it.
    stub.gateway.finishTasks();
    await expect.poll(() => bar.isVisible()).toBe(false);

    stub.gateway.release();
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a thread that has not been read yet shows a placeholder, then all of it at once', async () => {
  // Long enough to scroll, so where the reading starts is a real question.
  const said = Array.from({ length: 12 }, (_, i) => `exchange number ${i}`);
  await start({ holdLoad: true });
  for (const text of said) {
    stub.gateway.emit({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: `asking about ${text}` },
    } as SessionUpdate);
    stub.gateway.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `answering about ${text}` },
    } as SessionUpdate);
  }

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    // The browser has asked for its history and the stub is sitting on the
    // answer. Waited for rather than assumed: releasing frees the loads that
    // are parked, so releasing before one arrives frees nothing and holds
    // this browser for good.
    await expect.poll(() => stub.gateway.loadsHeld()).toBe(1);

    // Which is the box still starting as far as this browser can tell: no
    // history has arrived and none of it is on screen.
    await expect.poll(() => page.locator('[data-slot="thread-loading"]').isVisible()).toBe(true);

    // Nothing to type into and nothing that claims the thread is empty. The
    // greeting was the worse of the two: it says there is nothing here to
    // read, on arrival at a conversation, moments before being replaced.
    expect(await page.getByLabel('Message input').count()).toBe(0);
    expect(await page.getByText('How can I help you today?').count()).toBe(0);

    stub.gateway.releaseLoad();

    // The placeholder goes when the conversation arrives, and what arrives is
    // the whole of it: the first exchange and the last are on screen in the
    // same breath, not one render apart.
    await expect.poll(() => page.locator('[data-slot="thread-loading"]').count()).toBe(0);
    expect(await page.getByText('asking about exchange number 0').count()).toBe(1);
    expect(await page.getByText('answering about exchange number 11').count()).toBe(1);
    // And now there is somewhere to type.
    await expect.poll(() => page.getByLabel('Message input').isVisible()).toBe(true);

    // Opened at the end of the conversation, which is where a thread is read
    // from — not at whichever message the last render happened to leave.
    const viewport = page.locator('[data-slot="aui_thread-viewport"]');
    await expect
      .poll(() =>
        viewport.evaluate((el) =>
          Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
        ),
      )
      .toBeLessThanOrEqual(4);

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('the header steps aside while reading down, and returns on the way back up', async () => {
  // Long enough to scroll: the header can only give way to a conversation
  // that has somewhere to go.
  const paragraphs = Array.from({ length: 40 }, (_, i) => `paragraph number ${i} of the answer`);
  // A chunk at a time, so the thread spends a second following its own output
  // down the viewport — which is the other way the header used to move
  // without being asked.
  await start({
    prompts: [{ match: () => true, gapMs: 30, updates: reply(...paragraphs.map((p) => `${p}\n\n`)) }],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    const viewport = page.locator('[data-slot="aui_thread-viewport"]');
    const top = (): Promise<number> => viewport.evaluate((el) => el.scrollTop);
    /**
     * Whether the header is where a thumb reaches for it.
     *
     * Asked of the screen rather than of the element: the row is put away by
     * a parent that collapses to nothing around it, so the header keeps a box
     * of its own the whole time and `isVisible` would never say otherwise.
     */
    const inReach = (): Promise<boolean> =>
      page.evaluate(() => !!document.elementFromPoint(20, 10)?.closest('header'));

    const input = page.getByLabel('Message input');
    await input.fill('tell me at length');
    await input.press('Control+Enter');

    // The turn's own scrolling moves nothing: the viewport is against its
    // bottom for the whole of one, and none of that is a reader's decision
    // about chrome.
    await expect.poll(() => page.getByLabel('Stop generating').count()).toBe(1);
    for (let i = 0; i < 3; i += 1) {
      expect(await inReach()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Counted rather than seen: an assistant message below the fold is
    // render-skipped (globals.css), so it has no box to be visible in.
    await expect.poll(() => page.getByText('paragraph number 39').count()).toBe(1);
    await expect.poll(() => page.getByLabel('Stop generating').count()).toBe(0);

    // Reading from the top: the header is there to begin with.
    await viewport.hover();
    await page.mouse.wheel(0, -4000);
    await expect.poll(top).toBe(0);
    expect(await inReach()).toBe(true);

    // Down through the answer, and it gives way. A notch at a time, because
    // one 600-pixel event is a jump — which the header is right to ignore, and
    // which no hand produces.
    await wheel(page, 100, 8);
    await expect.poll(inReach).toBe(false);

    // Back up — by a flick, not all the way to the top, which is the whole
    // point: the header used to be recoverable only from the very top.
    await wheel(page, -100, 2);
    await expect.poll(inReach).toBe(true);
    expect(await top()).toBeGreaterThan(100);

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

/*
 * A turn that works for a while — a run of reasoning and tool calls, then an
 * answer — is where the reading position used to be lost.
 *
 * A turn anchors its prompt to the top of the viewport, and the empty space
 * under an answer that has not been written yet is real space, shrunk as the
 * answer grows. One screenful in there is none left to give, and everything
 * the turn went on to write was written below the fold and left there until
 * it ended. Tool calls and reasoning are what a long turn writes, so it was
 * their rows that were never seen.
 *
 * The warm-up exchange is not decoration: only a turn with something before
 * it anchors, so this was well behaved on the first turn of a conversation
 * and wrong on every one after it.
 */
test('a working turn is followed past the fold, with its prompt still anchored', async () => {
  await start({
    prompts: [
      { match: (text) => text.includes('warm up'), updates: reply('warmed up') },
      {
        match: () => true,
        gapMs: 120,
        updates: [...working(20), ...reply('and that is the answer')],
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    const input = page.getByLabel('Message input');
    await input.fill('warm up');
    await input.press('Control+Enter');
    await expect.poll(() => page.getByText('warmed up').isVisible()).toBe(true);

    await input.fill('do a lot of work');
    await input.press('Control+Enter');

    // The prompt is taken to the top of the viewport, which is the anchor's
    // job and still the anchor doing it.
    const viewport = page.locator('[data-slot="aui_thread-viewport"]');
    const promptTop = async (): Promise<number> => {
      const prompt = (await page.getByText('do a lot of work').boundingBox())!;
      const box = (await viewport.boundingBox())!;
      return Math.round(prompt.y - box.y);
    };
    await expect.poll(promptTop).toBeLessThan(96);

    // And from there to the end of the turn, everything it writes is on
    // screen as it writes it. Sampled in the page rather than over the wire:
    // what happens between two round trips is the whole question, and a turn
    // that fell a screen behind and caught up at the end would answer it
    // wrong.
    await page.evaluate(() => {
      const viewport = document.querySelector('[data-slot="aui_thread-viewport"]')!;
      const w = window as unknown as { __overhang: number };
      w.__overhang = -1;
      setInterval(() => {
        const written = document.querySelectorAll('[data-slot="aui_assistant-message-content"]');
        const last = written[written.length - 1];
        if (!last) return;
        const past =
          last.getBoundingClientRect().bottom - viewport.getBoundingClientRect().bottom;
        w.__overhang = Math.max(w.__overhang, past);
      }, 25);
    });

    await expect
      .poll(() => page.getByText('and that is the answer').isVisible(), { timeout: 20_000 })
      .toBe(true);

    // Nothing ever reached the bottom edge of the viewport, which is where the
    // composer sits and where reading stops.
    const worst = await page.evaluate(
      () => (window as unknown as { __overhang: number }).__overhang,
    );
    expect(worst).toBeLessThan(0);

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a reader who leaves the bottom during a turn is left there, and rejoins at it', async () => {
  await start({
    prompts: [
      { match: (text) => text.includes('warm up'), updates: reply('warmed up') },
      // Long enough to still be working when the reader has finished reading
      // whatever they went back for, and slow enough that going back to the
      // bottom by hand is something a hand can do.
      {
        match: () => true,
        gapMs: 200,
        updates: [...working(40), ...reply('and that is the answer')],
        hold: true,
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    const input = page.getByLabel('Message input');
    await input.fill('warm up');
    await input.press('Control+Enter');
    await expect.poll(() => page.getByText('warmed up').isVisible()).toBe(true);

    await input.fill('do a lot of work');
    await input.press('Control+Enter');

    const viewport = page.locator('[data-slot="aui_thread-viewport"]');
    const top = (): Promise<number> => viewport.evaluate((el) => Math.round(el.scrollTop));
    /**
     * Whether the thread is moving with its own output — asked of the
     * scroller, which is the only place the answer is a fact rather than an
     * intention.
     */
    const moving = async (): Promise<boolean> => {
      const before = await top();
      await new Promise((resolve) => setTimeout(resolve, 400));
      return (await top()) > before;
    };

    // The anchor has had its moment by now: the prompt is at the top of the
    // viewport and the answer is growing into the room kept under it, so the
    // position is not moving and `moving` is false.
    await new Promise((resolve) => setTimeout(resolve, 600));
    // And then the turn outgrows that room, which is where there is anything
    // to follow — and to walk away from.
    await expect.poll(moving, { timeout: 20_000 }).toBe(true);

    // Back up to read something, while the turn goes on writing.
    await viewport.hover();
    await wheel(page, -100, 5);
    const left = await top();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await page.getByLabel('Stop generating').count()).toBe(1);
    // Still where the reader left it: the turn wrote on underneath and none of
    // it moved the page. A couple of dozen pixels is the browser holding
    // anchored content still as a block above collapses, not the thread
    // deciding where to be.
    expect(Math.abs((await top()) - left)).toBeLessThanOrEqual(24);
    expect(await overhang(page)).toBeGreaterThan(0);

    // Back down, a flick at a time until the scroller is against its end,
    // because the turn is still writing while the reader travels.
    await expect
      .poll(
        async () => {
          await wheel(page, 400, 2);
          return viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop <= 8);
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    // And arriving there is rejoining the turn, rather than a position that
    // has to be held by hand from now on: what it writes next is on screen
    // too.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await page.getByLabel('Stop generating').count()).toBe(1);
    expect(await overhang(page)).toBeLessThan(0);

    expect(errors).toEqual([]);
  } finally {
    // The turn is over when this test says so, and it has to say so: a held
    // prompt outlives the page that asked for it.
    stub.gateway.release();
    await close();
  }
});

test('the thread sits inside the dashboard chrome rather than over it', async () => {
  await start({
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'auto', name: 'Auto' },
      ],
    },
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // The header is the dashboard's, and the thread must not cover it: the
    // back link, the mode switcher and the info link all have to be
    // clickable, not painted over by a floating panel.
    const header = (await page.locator('header').boundingBox())!;
    const thread = (await page.locator('.aui-thread-root').boundingBox())!;
    expect(header.height).toBeGreaterThan(0);
    expect(thread.y).toBeGreaterThanOrEqual(header.y + header.height);
    await expect.poll(() => page.getByLabel('Back to sessions').isVisible()).toBe(true);
    await expect.poll(() => page.getByLabel('Session details and controls').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an update the dashboard does not know about does not break the thread', async () => {
  await start({
    prompts: [
      {
        match: () => true,
        updates: [
          { sessionUpdate: 'usage_update', tokens: 42 } as unknown as SessionUpdate,
          ...reply('Still fine.'),
        ],
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('anything');
    await input.press('Control+Enter');
    await expect.poll(() => page.getByText('Still fine.').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('an image renders wherever it arrives — a tool result, or what the agent said', async () => {
  await start();

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // How a screenshot actually arrives: the agent reads the file back, and
    // the adapter carries the image inline as the tool's result.
    stub.gateway.emit({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-shot',
      title: 'Read .playwright-cli/page.png',
      kind: 'read',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: PNG } }],
    } as SessionUpdate);
    // And the other way one can arrive: in the message itself.
    stub.gateway.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Here is the page:' },
    } as SessionUpdate);
    stub.gateway.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', mimeType: 'image/png', data: PNG },
    } as SessionUpdate);

    // Both of them, as loaded images rather than as parts that merely exist:
    // a broken src renders an <img> too.
    const images = page.locator(`img[src="data:image/png;base64,${PNG}"]`);
    await expect.poll(() => images.count()).toBe(2);
    await expect
      .poll(() =>
        images.evaluateAll((nodes) =>
          nodes.every((n) => (n as HTMLImageElement).naturalWidth === 200),
        ),
      )
      .toBe(true);

    // The prose it was said with is still prose, on its own line.
    await expect.poll(() => page.getByText('Here is the page:').isVisible()).toBe(true);
    await shoot(page, 'thread-images');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a background task reporting in is a row of its own, not the user talking', async () => {
  await start();

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    // What the harness sends when a task started in the background has
    // something to say: a message in the user's own role, carrying XML
    // addressed to the model. A monitor's event first, then a subagent's
    // answer — the two shapes, and the two ways they read.
    stub.gateway.emit({
      sessionUpdate: 'user_message_chunk',
      messageId: 'note-1',
      content: {
        type: 'text',
        text: [
          '<task-notification>',
          '<task-id>bnztwmmw5</task-id>',
          '<summary>Monitor event: "Atlas Obscura crawl progress"</summary>',
          '<event>2200/30321 ok=2193 bad=7 0.9/s eta 528m</event>',
          '</task-notification>',
        ].join('\n'),
      },
    } as SessionUpdate);
    stub.gateway.emit({
      sessionUpdate: 'user_message_chunk',
      messageId: 'note-2',
      content: {
        type: 'text',
        text: [
          '<task-notification>',
          '<task-id>agent-a1b</task-id>',
          '<status>completed</status>',
          '<summary>Agent "Check the crawler logs" finished</summary>',
          '<result>The 429s are all from one host, and the backoff is holding.</result>',
          '<usage><subagent_tokens>48200</subagent_tokens><tool_uses>6</tool_uses>',
          '<duration_ms>184000</duration_ms></usage>',
          '</task-notification>',
        ].join('\n'),
      },
    } as SessionUpdate);
    stub.gateway.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'The crawl is being rate limited; the backoff is holding.' },
    } as SessionUpdate);

    // Two rows, neither of them a message on the user's side of the thread.
    const rows = page.locator('[data-role="task-notification"]');
    await expect.poll(() => rows.count()).toBe(2);
    expect(await page.locator('[data-role="user"]').count()).toBe(0);
    expect(await page.getByText('<task-notification>').count()).toBe(0);
    expect(await page.getByText('<task-id>').count()).toBe(0);

    // A monitor exists to report its event, so the event is what is shown.
    await expect.poll(() => page.getByText('Monitor event:', { exact: false }).isVisible()).toBe(true);
    await expect.poll(() => page.getByText('2200/30321', { exact: false }).isVisible()).toBe(true);

    // A finished task has been summarised by its own row, and what is under
    // it is its whole answer — folded, and opened by a click.
    const answer = page.getByText('The 429s are all from one host', { exact: false });
    expect(await answer.isVisible()).toBe(false);
    await expect.poll(() => page.getByText('48.2k tokens · 6 tool calls · 3m 4s').isVisible()).toBe(true);
    await page.getByText('Agent "Check the crawler logs" finished').click();
    await expect.poll(() => answer.isVisible()).toBe(true);
    await shoot(page, 'task-notification');

    // And the same on a reconnect: the block is text, so it comes back
    // through the transcript exactly as it arrived, and is read the same way.
    await page.reload();
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    await expect.poll(() => rows.count()).toBe(2);
    expect(await page.getByText('<task-notification>').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
