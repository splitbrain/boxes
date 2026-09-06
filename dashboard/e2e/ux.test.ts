import { afterAll, afterEach, expect, test } from 'vitest';
import { resolve } from 'node:path';
import type { SessionUpdate } from '../src/stores/thread/acp-types.ts';
import { closeBrowser, openPage, shoot } from './browser.ts';
import { startStubOrchestrator, stubSession, type StubOrchestrator } from './stub-orchestrator.ts';
import type { GatewayScript } from './stub-gateway.ts';

/**
 * The six complaints that forced the frontend decision, each asserted
 * against the real bundle in a real browser.
 */

const DIST = resolve(import.meta.dirname, '../dist');
const SESSION = stubSession();

let stub: StubOrchestrator;

async function start(script?: Partial<GatewayScript>): Promise<void> {
  stub = await startStubOrchestrator(DIST, [SESSION], script);
}

/** A one-chunk assistant reply. */
function reply(text: string): SessionUpdate[] {
  return [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } as SessionUpdate];
}

afterEach(async () => {
  await stub?.close();
});

afterAll(async () => {
  await closeBrowser();
});

// A prompt is prose, so the composer treats Enter as a line break and
// reserves Ctrl/Cmd+Enter for the send.
test('Enter opens a line in the composer, Ctrl+Enter sends it', async () => {
  await start({ prompts: [{ match: () => true, updates: reply('ok') }] });
  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');

    await input.fill('first line');
    await input.press('Enter');
    await input.pressSequentially('second line');
    await expect.poll(() => input.inputValue()).toBe('first line\nsecond line');
    // The line break stayed in the draft, and nothing was sent by it.
    expect(stub.gateway.prompts).toEqual([]);

    await input.press('Control+Enter');
    await expect.poll(() => stub.gateway.prompts).toEqual(['first line\nsecond line']);
    await expect.poll(() => input.inputValue()).toBe('');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// 2 — ArrowUp recalls previous messages.
test('ArrowUp walks back through what was sent, ArrowDown returns', async () => {
  await start({ prompts: [{ match: () => true, updates: reply('ok') }] });
  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');

    for (const text of ['first prompt', 'second prompt']) {
      await input.fill(text);
      await input.press('Control+Enter');
      await expect.poll(() => input.inputValue()).toBe('');
      // The composer clearing is local and immediate; the message itself
      // reaches the thread only when the gateway echoes it back. Recall walks
      // the thread's own user messages, so this — not the empty composer — is
      // when the history has what the rest of the test asks it for.
      // Longer than the default poll: this one waits on a round trip rather
      // than on a render, and every assertion below depends on it having
      // happened.
      await expect
        .poll(() => page.getByText(text).isVisible(), { timeout: 10_000 })
        .toBe(true);
    }

    await input.press('ArrowUp');
    await expect.poll(() => input.inputValue()).toBe('second prompt');
    await input.press('ArrowUp');
    await expect.poll(() => input.inputValue()).toBe('first prompt');
    await input.press('ArrowDown');
    await expect.poll(() => input.inputValue()).toBe('second prompt');
    await input.press('ArrowDown');
    await expect.poll(() => input.inputValue()).toBe('');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// 3 — the composer keeps focus.
test('the composer is focused on arrival and stays focused after a send', async () => {
  await start({ prompts: [{ match: () => true, updates: reply('done') }] });
  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    const focusedLabel = (): Promise<string | null> =>
      page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);
    await expect.poll(focusedLabel).toBe('Message input');

    const input = page.getByLabel('Message input');
    await input.fill('anything');
    await input.press('Control+Enter');
    await expect.poll(() => page.getByText('done').isVisible()).toBe(true);
    await expect.poll(focusedLabel).toBe('Message input');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a send that fails still leaves the composer focused', async () => {
  // No prompt script and a gateway that answers, but the store reports the
  // failure through the error banner; either way the caret must not be lost.
  await start({ prompts: [] });
  const { page, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('goes nowhere');
    await input.press('Control+Enter');
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null))
      .toBe('Message input');
  } finally {
    await close();
  }
});

// 4 and 5 — !bang runs locally, and its output is visible.
test('a !bang command runs in the container and never reaches the agent', async () => {
  await start({ prompts: [{ match: () => true, updates: reply('should not happen') }] });
  stub.execOutput = (command) => ({ output: `ran: ${command}\nhi\n`, exitCode: 0 });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('!echo hi');
    await input.press('Control+Enter');

    // It went to the exec endpoint, not to the adapter.
    await expect.poll(() => stub.execCalls.length).toBe(1);
    expect(stub.execCalls[0]).toEqual({ sessionId: SESSION.id, command: 'echo hi' });
    expect(stub.gateway.prompts).toEqual([]);

    // The output is printed as code, with nothing to open first.
    await expect.poll(() => page.getByText('ran: echo hi').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('[exit 0]').isVisible()).toBe(true);
    await shoot(page, 'bang-command');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a failing !bang command shows its exit code under the output', async () => {
  await start();
  stub.execOutput = () => ({ output: 'bash: nope: command not found\n', exitCode: 127 });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('!nope');
    await input.press('Control+Enter');

    await expect.poll(() => page.getByText('command not found').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('[exit 127]').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('commands from a previous visit come back after the replay', async () => {
  await start();
  stub.execLog.push({
    id: 7,
    sessionId: SESSION.id,
    command: 'git status',
    output: 'nothing to commit\n',
    exitCode: 0,
    truncated: false,
    timedOut: false,
    startedAt: Date.now() - 60_000,
    finishedAt: Date.now() - 59_000,
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('!git status').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('nothing to commit').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// 5 — streamed tool output from the agent, collapsibly.
test('an agent tool call shows its streamed output collapsibly', async () => {
  await start({
    prompts: [
      {
        match: () => true,
        gapMs: 60,
        updates: [
          {
            sessionUpdate: 'tool_call',
            toolCallId: 'a1',
            title: 'Run the proxy tests',
            kind: 'execute',
            status: 'in_progress',
            rawInput: { command: 'npm test' },
          },
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'a1',
            content: [{ type: 'content', content: { type: 'text', text: 'ok 1 - cidr' } }],
          },
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'a1',
            status: 'completed',
            content: [
              { type: 'content', content: { type: 'text', text: 'ok 1 - cidr\nok 2 - subnet' } },
            ],
          },
        ] as SessionUpdate[],
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('run the tests');
    await input.press('Control+Enter');

    await page.locator('[data-slot="tool-group-trigger"]').first().click();
    await page.locator('[data-slot="tool-fallback-trigger"]').first().click();
    await expect.poll(() => page.getByText('ok 2 - subnet').isVisible()).toBe(true);
    // The args are shown too, which is the other half of "can't see output".
    await expect.poll(() => page.getByText('npm test', { exact: false }).first().isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

/*
 * A working turn is mostly rows: "Reasoning", "1 tool call", "Reasoning"
 * again. Each is a single line, and each used to arrive with the space a
 * paragraph gets under it — the action bar's reserved height, and the gap
 * between messages when the adapter sends them as separate ones. A dozen of
 * them in a row was a screen of whitespace with a few words down the left
 * edge, which is what this measures: a run of rows stays a list, and the
 * prose after it still gets its air.
 *
 * Two turns, because both are real. The first has the adapter name a message
 * id per block, which is what puts every row in a message of its own; the
 * second names none, and everything lands in one message. The rows have to
 * be as tight either way.
 */
test('a run of reasoning and tool rows stays a list, and prose after it still breathes', async () => {
  // One thought and one tool call, as an adapter that names its messages
  // sends them and as one that does not. The turn's own letter keeps the
  // tool call ids apart: a re-announced id is an update to the call already
  // in the thread, not a second one.
  const row = (turn: string, n: number, split: boolean): SessionUpdate[] =>
    [
      {
        sessionUpdate: 'agent_thought_chunk',
        ...(split ? { messageId: `${turn}${n}` } : {}),
        content: { type: 'text', text: `Thinking about step ${n}.` },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: `${turn}-call-${n}`,
        title: `Step ${n}`,
        kind: 'read',
        status: 'completed',
        rawInput: { path: `file-${n}.ts` },
      },
    ] as SessionUpdate[];

  const turn = (letter: string, split: boolean): SessionUpdate[] => [
    ...row(letter, 1, split),
    ...row(letter, 2, split),
    ...row(letter, 3, split),
    ...reply('and that is the answer'),
  ];

  await start({
    prompts: [
      { match: (text) => text.includes('split'), updates: turn('a', true) },
      { match: () => true, updates: turn('b', false) },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    for (const [prompt, name] of [
      ['split into messages', 'quiet-rows-split'],
      ['all one message', 'quiet-rows-one-message'],
    ]) {
      const input = page.getByLabel('Message input');
      await input.fill(prompt!);
      await input.press('Control+Enter');
      await expect
        .poll(() => page.getByText('and that is the answer').last().isVisible(), { timeout: 10_000 })
        .toBe(true);
      // At rest, which is not the same moment: reasoning is held open while
      // it streams and collapses when the turn moves on. The wait is on the
      // panels having no height rather than on their state, which flips at
      // the start of the 200ms collapse — a row measured during it is as
      // tall as the text still inside it.
      await expect
        .poll(() =>
          page.evaluate(() =>
            [...document.querySelectorAll('[data-slot="reasoning-content"]')].every(
              (el) => el.getBoundingClientRect().height === 0,
            ),
          ),
        )
        .toBe(true);

      // Every gap between one row and the next in this turn, measured on the
      // triggers themselves so it counts whatever the message, group and
      // margins between them add up to. This turn only: the one before it is
      // still on the page, and the user message between them is not a gap
      // anything here is about.
      const gaps = await page.evaluate(() => {
        const turn = [...document.querySelectorAll('[data-role="user"]')]
          .pop()!
          .getBoundingClientRect().bottom;
        const rows = [
          ...document.querySelectorAll(
            '[data-slot="reasoning-trigger"], [data-slot="tool-group-trigger"]',
          ),
        ]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.top >= turn);
        return rows.slice(1).map((r, i) => Math.round(r.top - rows[i]!.bottom));
      });
      expect(gaps.length).toBeGreaterThanOrEqual(5);
      // A row is 24px tall. Anything over half that between two of them and
      // the run has stopped reading as one thing.
      for (const gap of gaps) expect(gap).toBeLessThanOrEqual(12);

      // The prose the turn ends with is not dragged into the run with them.
      const air = await page.evaluate(() => {
        const rows = [
          ...document.querySelectorAll(
            '[data-slot="reasoning-trigger"], [data-slot="tool-group-trigger"]',
          ),
        ];
        const last = rows[rows.length - 1]!.getBoundingClientRect();
        const prose = [...document.querySelectorAll('.aui-md')]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.top > last.bottom)
          .sort((a, b) => a.top - b.top)[0]!;
        return Math.round(prose.top - last.bottom);
      });
      expect(air).toBeGreaterThanOrEqual(12);
      await shoot(page, name!);
    }

    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

/*
 * The same run, cut in half by the agent saying something.
 *
 * A tool call carries no message id of its own, so it joins whatever message
 * is trailing: the one the agent has just spoken in. That message says
 * something and ends in rows, and it kept the action bar's 30px under the
 * last of them — with the group's 24px under that, a 54px hole in the middle
 * of a run of 24px lines, in the shape a working turn takes most often.
 *
 * Measured as an ordered column of rows and paragraphs, because both
 * readings matter: two rows together are a list whatever messages they came
 * in, and a paragraph on either side of them still has its air.
 */
test('a row run stays a list across a message that speaks, and the prose in it still breathes', async () => {
  // Message ids of the adapter's own choosing, which is what splits a turn
  // into messages. They are not the ids the thread mints for the chunks that
  // arrive without one, and must not collide with them.
  const think = (id: string, text: string): SessionUpdate =>
    ({
      sessionUpdate: 'agent_thought_chunk',
      messageId: id,
      content: { type: 'text', text },
    }) as SessionUpdate;
  const speak = (id: string, text: string): SessionUpdate =>
    ({
      sessionUpdate: 'agent_message_chunk',
      messageId: id,
      content: { type: 'text', text },
    }) as SessionUpdate;
  const call = (n: number): SessionUpdate =>
    ({
      sessionUpdate: 'tool_call',
      toolCallId: `s-call-${n}`,
      title: `Step ${n}`,
      kind: 'read',
      status: 'completed',
      rawInput: { path: `file-${n}.ts` },
    }) as SessionUpdate;

  await start({
    prompts: [
      {
        match: () => true,
        updates: [
          think('s1', 'Thinking about the first step.'),
          call(1),
          // Prose, and then the calls it announced — one message, and the
          // one this test is about.
          speak('s2', 'The first run passed. Checking the stub:'),
          call(2),
          think('s3', 'Which is a race rather than slowness.'),
          call(3),
          speak('s4', 'and that is the answer'),
        ],
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);

    const input = page.getByLabel('Message input');
    await input.fill('work, say something, work again');
    await input.press('Control+Enter');
    await expect
      .poll(() => page.getByText('and that is the answer').isVisible(), { timeout: 10_000 })
      .toBe(true);
    // At rest: a reasoning block is held open while it streams and collapses
    // over 200ms when the turn moves on, and a row measured during that is
    // as tall as the text still inside it.
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.querySelectorAll('[data-slot="reasoning-content"]')].every(
            (el) => el.getBoundingClientRect().height === 0,
          ),
        ),
      )
      .toBe(true);

    // The turn as a column: every row and every paragraph in it, in the
    // order they are read, with the space above each.
    const column = await page.evaluate(() => {
      const turn = [...document.querySelectorAll('[data-role="user"]')]
        .pop()!
        .getBoundingClientRect().bottom;
      const seen = [
        ...document.querySelectorAll(
          '[data-slot="reasoning-trigger"], [data-slot="tool-group-trigger"], .aui-md',
        ),
      ]
        .map((el) => ({
          kind: el.classList.contains('aui-md') ? 'prose' : 'row',
          box: el.getBoundingClientRect(),
        }))
        .filter((item) => item.box.top >= turn)
        .sort((a, b) => a.box.top - b.box.top);
      return seen.slice(1).map((item, i) => ({
        from: seen[i]!.kind,
        to: item.kind,
        gap: Math.round(item.box.top - seen[i]!.box.bottom),
      }));
    });

    // The shape of the turn, so the numbers below are read off the seams
    // they are meant to be: three row-to-row, one where a sentence hands
    // over to the calls it announced, and two where a run ends in prose.
    const seams = (from: string, to: string): number[] =>
      column.filter((step) => step.from === from && step.to === to).map((step) => step.gap);
    expect(column.length).toBe(6);
    expect(seams('row', 'row').length).toBe(3);
    expect(seams('prose', 'row').length).toBe(1);
    expect(seams('row', 'prose').length).toBe(2);

    // A row is 24px tall. Anything over half that between two of them and the
    // run has stopped reading as one thing — including the seam in the
    // middle, where the run carries on out of a message that spoke.
    for (const gap of seams('row', 'row')) expect(gap).toBeLessThanOrEqual(12);
    // A sentence keeps the calls it announced: what separates them is the
    // 6px the trigger carries above its own text, and nothing else.
    for (const gap of seams('prose', 'row')) expect(gap).toBeLessThanOrEqual(12);
    // And the space comes back in full where the run ends and the turn says
    // something, which is the half of this that is not about tightening.
    for (const gap of seams('row', 'prose')) expect(gap).toBeGreaterThanOrEqual(12);

    await shoot(page, 'quiet-rows-interrupted');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// An unfinished tool call is not a question. A call with no result inherits
// its message's requires-action status, which used to render as "Wants to
// run" over Allow and Deny buttons — in auto mode, where nothing is being
// asked, and over a tool whose result cannot come from a browser anyway.
test('a tool call that never reported back is not offered as a decision', async () => {
  await start({
    prompts: [
      {
        match: () => true,
        updates: [
          {
            sessionUpdate: 'tool_call',
            toolCallId: 'a1',
            title: 'Run the proxy tests',
            kind: 'execute',
            status: 'in_progress',
            rawInput: { command: 'npm test' },
          },
          // The turn ends without a result for it, which is what a cancelled
          // or crashed call looks like from here.
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'that is all' },
          },
        ] as SessionUpdate[],
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('run the tests');
    await input.press('Control+Enter');
    await expect
      .poll(() => page.getByText('that is all').isVisible(), { timeout: 10_000 })
      .toBe(true);

    await page.locator('[data-slot="tool-group-trigger"]').first().click();
    await page.locator('[data-slot="tool-fallback-trigger"]').first().click();
    // Opened by hand, and there is nothing to answer inside it.
    await expect.poll(() => page.getByText('npm test', { exact: false }).first().isVisible()).toBe(
      true,
    );
    expect(await page.locator('[data-slot="tool-fallback-approval"]').count()).toBe(0);
    expect(await page.getByText('Wants to run:').count()).toBe(0);
    await expect.poll(() => page.getByText('Unfinished tool:').first().isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// Leaving a thread mid-turn and coming back. The orchestrator is the ACP
// client of record, so the turn is still running; the view is a fresh store
// with nothing in flight, and only the gateway can tell it otherwise.
test('a turn still running is still running after a detour away and back', async () => {
  await start({
    prompts: [{ match: () => true, updates: reply('working on it'), hold: true }],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('take your time');
    await input.press('Control+Enter');

    const stop = page.getByLabel('Stop generating');
    await expect.poll(() => stop.isVisible(), { timeout: 10_000 }).toBe(true);

    // Out to the review and back, which is what tears the store down.
    await page.getByLabel("Review this session's code").click();
    await expect.poll(() => page.getByLabel('Back to the thread').isVisible()).toBe(true);
    await page.getByLabel('Back to the thread').click();

    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    // Still a stop button, not a send button, and still working.
    await expect.poll(() => stop.isVisible(), { timeout: 10_000 }).toBe(true);
    expect(await page.getByLabel('Send message').count()).toBe(0);

    stub.gateway.release();
    await expect
      .poll(() => page.getByLabel('Send message').isVisible(), { timeout: 10_000 })
      .toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// Wide output. A reading column is the right width for prose and the wrong
// width for a table, and neither the table nor the code block could be
// scrolled sideways to see the rest of one.
test('a wide table leaves the reading column, and scrolls when even that is too narrow', async () => {
  const header = `| ${Array.from({ length: 9 }, (_, i) => `column heading ${i}`).join(' | ')} |`;
  const rule = `| ${Array.from({ length: 9 }, () => '---').join(' | ')} |`;
  const row = `| ${Array.from({ length: 9 }, (_, i) => `a fairly long cell ${i}`).join(' | ')} |`;
  await start({
    prompts: [{ match: () => true, updates: reply(`here it is\n\n${header}\n${rule}\n${row}\n`) }],
  });

  const wide = await openPage(stub.url, `/sessions/${SESSION.id}`, 'dark', 'desktop');
  try {
    const input = wide.page.getByLabel('Message input');
    await input.fill('show me the table');
    await input.press('Control+Enter');
    const table = wide.page.locator('.aui-md-table-wrap');
    await expect.poll(() => table.isVisible(), { timeout: 10_000 }).toBe(true);

    // Wider than the column the prose above it is set in, and no wider than
    // the thread: the point is to use the window, not to overflow it.
    const width = (locator: typeof table): Promise<number> =>
      locator.evaluate((el) => el.clientWidth);
    const column = wide.page.locator('[data-slot="aui_assistant-message-content"]').first();
    expect(await width(table)).toBeGreaterThan(await width(column));

    // And the thread itself did not gain a horizontal scrollbar, which is
    // what a bleed measured against the window rather than the scroller does.
    const viewport = wide.page.locator('[data-slot="aui_thread-viewport"]');
    const overflow = await viewport.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await shoot(wide.page, 'wide-table-desktop');
    expect(wide.errors).toEqual([]);
  } finally {
    await wide.close();
  }

  const phone = await openPage(stub.url, `/sessions/${SESSION.id}`, 'dark', 'phone');
  try {
    const input = phone.page.getByLabel('Message input');
    await input.fill('show me the table');
    await input.press('Control+Enter');
    // Two of them, and the wait is for both: this page is a second look at
    // the session the desktop half just used, so the thread replays that
    // exchange and then answers this page's own prompt with another table.
    // Waiting only for the first leaves the second free to arrive between the
    // wait and the measurement, and a locator matching two elements is an
    // error rather than a choice — which is how this read as flaky.
    const tables = phone.page.locator('.aui-md-table-wrap');
    await expect.poll(() => tables.count(), { timeout: 10_000 }).toBe(2);
    const table = tables.last();
    await expect.poll(() => table.isVisible()).toBe(true);

    // Nowhere left to bleed to, so it scrolls instead of being cut off.
    const scrollable = await table.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrollable).toBe(true);
    await shoot(phone.page, 'wide-table-phone');
    expect(phone.errors).toEqual([]);
  } finally {
    await phone.close();
  }
});

// 6 — mode switching.
test('the mode switcher lists the advertised modes and sets one', async () => {
  await start({
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'acceptEdits', name: 'Accept edits' },
        { id: 'bypassPermissions', name: 'Auto' },
      ],
    },
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    // Behind the settings button, with the model and the rest: the header row
    // is a name and four icons now.
    await page.getByLabel('Agent settings').click();
    const modes = page.getByRole('combobox', { name: 'Agent mode' });
    await expect.poll(() => modes.isVisible()).toBe(true);
    // Nothing hardcoded: whatever the adapter advertises is what appears.
    expect(await modes.locator('option').allInnerTexts()).toEqual([
      'Default',
      'Accept edits',
      'Auto',
    ]);
    expect(await modes.inputValue()).toBe('default');

    await modes.selectOption('bypassPermissions');
    await expect.poll(() => modes.inputValue()).toBe('bypassPermissions');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a current_mode_update from the adapter moves the switcher', async () => {
  await start({
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'auto', name: 'Auto' },
      ],
    },
  });

  const { page, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await page.getByLabel('Agent settings').click();
    const modes = page.getByRole('combobox', { name: 'Agent mode' });
    await expect.poll(() => modes.isVisible()).toBe(true);
    stub.gateway.emit({ sessionUpdate: 'current_mode_update', currentModeId: 'auto' });
    await expect.poll(() => modes.inputValue()).toBe('auto');
  } finally {
    await close();
  }
});

// Model selection.
test('the model selector lists the advertised models and sets one', async () => {
  await start({
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'opus',
        options: [
          { value: 'opus', name: 'Opus' },
          { value: 'sonnet', name: 'Sonnet' },
          { value: 'haiku', name: 'Haiku' },
        ],
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await page.getByLabel('Agent settings').click();
    const models = page.getByRole('combobox', { name: 'Model' });
    await expect.poll(() => models.isVisible()).toBe(true);
    // Nothing hardcoded: whatever the adapter advertises is what appears.
    expect(await models.locator('option').allInnerTexts()).toEqual(['Opus', 'Sonnet', 'Haiku']);
    expect(await models.inputValue()).toBe('opus');

    await models.selectOption('haiku');
    await expect.poll(() => models.inputValue()).toBe('haiku');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// The tab title. Several boxes in several tabs, all called "Boxes", said
// nothing about which one had stopped for a question.
test('the tab says which box and thread it is, and what that thread is doing', async () => {
  await start({ prompts: [{ match: () => true, updates: reply('done'), hold: true }] });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    // The box's name and the conversation's, in the header's own order and
    // with the header's own names for them.
    await expect
      .poll(() => page.title())
      .toBe('\u25cb refactor auth \u00b7 Thread 1');

    const input = page.getByLabel('Message input');
    await input.fill('go');
    await input.press('Control+Enter');
    await expect
      .poll(() => page.title(), { timeout: 10_000 })
      .toBe('\u27f3 refactor auth \u00b7 Thread 1');

    stub.gateway.release();
    await expect
      .poll(() => page.title(), { timeout: 10_000 })
      .toBe('\u25cb refactor auth \u00b7 Thread 1');

    // And leaving the thread puts the plain app title back.
    await page.getByLabel('Back to sessions').click();
    await expect.poll(() => page.title()).toBe('Boxes');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a thread waiting on a decision says so in its tab', async () => {
  await start({
    permissions: [
      {
        match: () => true,
        toolCall: { toolCallId: 'p1', title: 'Write to src/main.ts', kind: 'edit' },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
        after: () => [],
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('edit the file');
    await input.press('Control+Enter');
    await expect
      .poll(() => page.title(), { timeout: 10_000 })
      .toBe('\u26a0 refactor auth \u00b7 Thread 1');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a thread asked which way to go says that instead', async () => {
  await start({
    permissions: [
      {
        match: () => true,
        toolCall: { toolCallId: 'p1', title: 'Leave plan mode', kind: 'switch_mode' },
        // Three ways to say yes, each a different thing to do next: a
        // question, not a gate.
        options: [
          { optionId: 'auto', name: 'Yes, and use auto mode', kind: 'allow_always' },
          { optionId: 'acceptEdits', name: 'Yes, and auto-accept edits', kind: 'allow_always' },
          { optionId: 'default', name: 'Yes, and approve each edit', kind: 'allow_once' },
          { optionId: 'plan', name: 'No, keep planning', kind: 'reject_once' },
        ],
        after: () => [],
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('ready to build it');
    await input.press('Control+Enter');
    await expect
      .poll(() => page.title(), { timeout: 10_000 })
      .toBe('? refactor auth \u00b7 Thread 1');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// Effort, and everything else the adapter offers beyond the model. These had
// no control at all, so the effort level could not be set.
test("the adapter's other settings are reachable, and setting one is sent", async () => {
  await start({
    // This adapter says what mode it is in twice — as the protocol's modes,
    // and again as a config option. Only one of them may reach the overlay.
    modes: {
      currentModeId: 'auto',
      availableModes: [
        { id: 'auto', name: 'Auto' },
        { id: 'plan', name: 'Plan' },
      ],
    },
    configOptions: [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'auto',
        options: [
          { value: 'auto', name: 'Auto' },
          { value: 'plan', name: 'Plan' },
        ],
      },
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'opus',
        options: [
          { value: 'opus', name: 'Opus' },
          { value: 'sonnet', name: 'Sonnet' },
        ],
      },
      {
        id: 'effort',
        name: 'Effort',
        description: 'Available effort levels for this model',
        category: 'thought_level',
        type: 'select',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    const settings = page.getByLabel('Agent settings');
    await expect.poll(() => settings.isVisible()).toBe(true);
    // Closed, the header is a name and its icons: no select is in the row.
    expect(await page.getByRole('combobox').count()).toBe(0);
    await settings.click();

    const effort = page.getByRole('combobox', { name: 'Effort' });
    await expect.poll(() => effort.isVisible()).toBe(true);
    expect(await effort.locator('option').allInnerTexts()).toEqual(['Default', 'Low', 'High']);

    await shoot(page, 'agent-settings', 'viewport');

    await effort.selectOption('high');
    await expect.poll(() => effort.inputValue()).toBe('high');
    // The adapter heard about it, which is the half a select cannot show.
    await expect
      .poll(() => stub.gateway.script.configOptions.find((o) => o.id === 'effort')?.currentValue)
      .toBe('high');

    // The mode is offered once, as the protocol's modes rather than as the
    // config option that says the same thing. Exactly "Mode", because a
    // substring match also finds "Model".
    expect(await page.getByRole('combobox', { name: 'Mode', exact: true }).count()).toBe(0);
    expect(await page.getByRole('combobox', { name: 'Agent mode' }).count()).toBe(1);
    // And the model is in here now rather than in the header row.
    expect(await page.getByRole('combobox', { name: 'Model' }).count()).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// The missing-token warning.
test('a deployment with no Claude token is warned about in the list and the thread', async () => {
  await start();
  stub.state.claudeTokenConfigured = false;
  const warning = /No Claude token is set/;

  const list = await openPage(stub.url, '/');
  try {
    await expect.poll(() => list.page.getByText(warning).isVisible()).toBe(true);
  } finally {
    await list.close();
  }

  const thread = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => thread.page.getByText(warning).isVisible()).toBe(true);
    expect(thread.errors).toEqual([]);
  } finally {
    await thread.close();
  }
});

test('a deployment that holds a Claude token is not warned about', async () => {
  await start();
  const { page, close } = await openPage(stub.url, '/');
  try {
    await expect.poll(() => page.getByText('refactor auth').isVisible()).toBe(true);
    expect(await page.getByText(/No Claude token is set/).count()).toBe(0);
  } finally {
    await close();
  }
});

// Permissions.
test('a permission request renders its options and the choice answers the agent', async () => {
  await start({
    permissions: [
      {
        match: () => true,
        toolCall: { toolCallId: 'p1', title: 'Write to src/main.ts', kind: 'edit' },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
        after: (optionId) => [
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `chose ${optionId}` },
          } as SessionUpdate,
        ],
      },
    ],
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    const input = page.getByLabel('Message input');
    await input.fill('edit the file');
    await input.press('Control+Enter');

    // The question opens itself: a prompt nobody can see blocks the turn.
    const approval = page.locator('[data-slot="tool-fallback-approval"]');
    await expect.poll(() => approval.isVisible(), { timeout: 10_000 }).toBe(true);
    // And the call it is about has not run yet, whatever the collapsed header
    // of a finished one says.
    await expect.poll(() => page.getByText('Wants to run:').isVisible()).toBe(true);
    expect(await approval.getByRole('button').allInnerTexts()).toEqual([
      'Allow once',
      'Always allow',
      'Reject',
    ]);
    await shoot(page, 'permission-request');

    await approval.getByRole('button', { name: 'Always allow' }).click();
    await expect.poll(() => page.getByText('chose always').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('a permission request queued while nobody watched is delivered on attach', async () => {
  await start({
    queuedPermission: {
      match: () => true,
      toolCall: { toolCallId: 'q1', title: 'Delete build/', kind: 'delete' },
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
      after: (optionId) => [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `queued answer: ${optionId}` },
        } as SessionUpdate,
      ],
    },
  });

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    const approval = page.locator('[data-slot="tool-fallback-approval"]');
    await expect.poll(() => approval.isVisible(), { timeout: 10_000 }).toBe(true);
    await approval.getByRole('button', { name: 'Reject' }).click();
    await expect.poll(() => page.getByText('queued answer: no').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

// A slash command is completed in the composer, not run from the list: the
// agent runs it, and it often takes arguments the user still has to type.
test('typing a slash lists the adapter commands and completes the one picked', async () => {
  await start();

  const { page, errors, close } = await openPage(stub.url, `/sessions/${SESSION.id}`);
  try {
    await expect.poll(() => page.getByText('connected').isVisible()).toBe(true);
    stub.gateway.emit({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'review', description: 'Review the working tree' },
        { name: 'release', description: 'Cut a release' },
        { name: 'compact', description: 'Compact the thread' },
      ],
    } as SessionUpdate);

    const input = page.getByLabel('Message input');
    await input.press('/');
    const options = page.getByRole('option');
    await expect.poll(() => options.count()).toBe(3);

    // Typing narrows the list, and Enter completes rather than opening a line.
    await input.pressSequentially('rel');
    await expect.poll(() => options.count()).toBe(1);
    await input.press('Enter');
    await expect.poll(() => input.inputValue()).toBe('/release ');
    expect(stub.gateway.prompts).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
