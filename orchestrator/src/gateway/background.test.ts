import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  BackgroundProbe,
  anyWorkRunning,
  commandOf,
  processId,
  readBackgroundWork,
  startsBackgroundWork,
  threadOfAgent,
  unexplained,
  workToStop,
} from './background.ts';
import type { ContainerProcess } from '../docker.ts';

/**
 * What a thread, and the reaper, are told about work a session left running.
 *
 * The fixtures are process tables, because that is what the box is asked for,
 * and they are the real thing: the shape below was read out of a session
 * container with a background command in it, down to the wrapper the harness
 * puts around what the agent asked for.
 */

const ADAPTER = 'claude-agent-acp';

/** Two conversations of the same box. */
const ONE = '90732d29-a1aa-4df7-9b78-a726bb859148';
const TWO = 'd6d8f0a1-2b3c-4d5e-8f90-1a2b3c4d5e6f';

/** A process table, written parent-first. */
function table(...rows: Array<[number, number, string, number?]>): ContainerProcess[] {
  return rows.map(([pid, ppid, command, elapsed]) => ({
    pid,
    ppid,
    command,
    elapsedSeconds: elapsed ?? null,
  }));
}

/** An agent process, as the SDK spawns one: the conversation is on the line. */
function agent(pid: number, thread: string, how: 'session-id' | 'resume' = 'session-id'): string {
  return (
    '/usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/node_modules/' +
    '@anthropic-ai/claude-agent-sdk-linux-x64/claude --output-format stream-json --verbose ' +
    `--input-format stream-json --permission-mode default --${how}=${thread} ` +
    `--replay-user-messages`
  ).replace('PID', String(pid));
}

/** A tool call's shell, as the harness wraps one. */
function shell(command: string, token = 'cfec'): string {
  return (
    `/bin/bash -c source /home/agent/.claude/shell-snapshots/snapshot-bash-1788851622550-gb9iep.sh ` +
    `2>/dev/null || true && shopt -u extglob 2>/dev/null || true && ` +
    `{ \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true ` +
    `&& eval '${command}' < /dev/null && pwd -P >| /tmp/claude-${token}-cwd`
  );
}

/** The container with the adapter up and no conversation in it yet. */
const EMPTY = table(
  [1, 0, '/sbin/docker-init -- /usr/local/bin/entrypoint.sh'],
  [7, 1, 'sleep infinity'],
  [22977, 0, 'node /usr/local/bin/claude-agent-acp'],
);

/** The same, with one conversation open and nothing running in it. */
const IDLE = table(
  ...EMPTY.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]),
  [23019, 22977, agent(23019, ONE)],
);

/** And with a background command still going in that conversation. */
const WORKING = table(
  ...IDLE.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]),
  [23490, 23019, shell('sleep 300; echo done'), 154],
  [23492, 23490, 'sleep 300', 154],
);

// --- whose work is it ------------------------------------------------------

test('an empty box has nothing running in it', () => {
  const reading = readBackgroundWork(EMPTY, ADAPTER);
  assert.equal(anyWorkRunning(reading), false);
  assert.equal(reading.byThread.size, 0);
});

test('an agent sitting there with no tool call running is not work', () => {
  assert.equal(anyWorkRunning(readBackgroundWork(IDLE, ADAPTER)), false);
});

test('a shell under the agent is that conversation, and only that one', () => {
  const reading = readBackgroundWork(WORKING, ADAPTER, 1_000_000);
  assert.equal(anyWorkRunning(reading), true);
  assert.deepEqual(
    reading.byThread.get(ONE)?.map((p) => p.command),
    ['sleep 300; echo done'],
  );
  // The other conversation in the same box is told nothing, which is the
  // whole repair: a thread opened a minute ago used to be shown this.
  assert.equal(reading.byThread.get(TWO), undefined);
});

test('what a command spawned is that command, not a second one', () => {
  // `sleep 300` under the shell is the same piece of work as the shell. One
  // entry per tool call, whatever tree hangs off it — and the stop takes the
  // whole tree.
  assert.equal(readBackgroundWork(WORKING, ADAPTER).byThread.get(ONE)?.length, 1);
});

test('two conversations keep their own work apart', () => {
  const procs = table(
    ...WORKING.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]),
    [29098, 22977, agent(29098, TWO)],
    [40000, 29098, shell('npm run build', 'a1b2')],
  );
  const reading = readBackgroundWork(procs, ADAPTER);
  assert.deepEqual(
    reading.byThread.get(ONE)?.map((p) => p.command),
    ['sleep 300; echo done'],
  );
  assert.deepEqual(
    reading.byThread.get(TWO)?.map((p) => p.command),
    ['npm run build'],
  );
});

test('a conversation the adapter loaded again is the same conversation', () => {
  // After a restart the SDK is told to resume rather than to be a new
  // session, so the id arrives under another flag. It is the same thread and
  // the same id the browser is watching.
  const procs = table(
    ...EMPTY.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]),
    [23019, 22977, agent(23019, ONE, 'resume')],
    [23490, 23019, shell('npm test')],
  );
  assert.deepEqual(
    readBackgroundWork(procs, ADAPTER).byThread.get(ONE)?.map((p) => p.command),
    ['npm test'],
  );
});

test('a fork belongs to itself, not to what it was forked from', () => {
  // A forked conversation carries both flags: `--resume` names the thread it
  // took its history from, `--session-id` the one it is. Reading the first
  // would put its work in somebody else's thread.
  const forked = `${agent(23019, TWO)} --resume=${ONE} --fork-session`;
  const procs = table(
    ...EMPTY.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]),
    [23019, 22977, forked],
    [23490, 23019, shell('npm run dev')],
  );
  const reading = readBackgroundWork(procs, ADAPTER);
  assert.equal(reading.byThread.get(ONE), undefined);
  assert.deepEqual(
    reading.byThread.get(TWO)?.map((p) => p.command),
    ['npm run dev'],
  );
});

test('where a conversation resumed from is not a conversation', () => {
  // `--resume-session-at` names a message. Matching it would attribute the
  // work to a thread id that does not exist.
  assert.equal(threadOfAgent('claude --resume-session-at=8f14e45f --session-id=abc'), 'abc');
  assert.equal(threadOfAgent('claude --resume-session-at=8f14e45f'), null);
  assert.equal(threadOfAgent('claude --output-format stream-json'), null);
});

test('an agent that names no conversation still holds the box awake', () => {
  // Work under it is real; only who to show it to is unknown. Answering
  // "idle" here would stop a box with a build in it, which is the mistake
  // that has no repair.
  const procs = table(
    ...EMPTY.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]),
    [23019, 22977, 'claude --output-format stream-json'],
    [23490, 23019, shell('npm run build')],
  );
  const reading = readBackgroundWork(procs, ADAPTER);
  assert.equal(anyWorkRunning(reading), true);
  assert.deepEqual(reading.unnamed, ['npm run build']);
  assert.equal(reading.byThread.size, 0);
  // And it says so out loud, because a box that is busy while every one of
  // its threads is quiet is indistinguishable from a bug when you are looking
  // at the list rather than at the log.
  assert.match(unexplained(reading) ?? '', /names no conversation: npm run build/);
});

test('a launcher between the adapter and the agent is not work either', () => {
  // The agent is found by the id on its line, so a wrapper in between does
  // not make the real agent look like a running tool call — nor does the
  // wrapper itself count as one, since what is under it is an agent.
  const procs = table(
    ...EMPTY.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]),
    [23000, 22977, '/bin/sh /usr/local/bin/claude-wrapper'],
    [23019, 23000, agent(23019, ONE)],
  );
  assert.equal(anyWorkRunning(readBackgroundWork(procs, ADAPTER)), false);
});

test('the entrypoint the box was started with is not work', () => {
  // `sleep infinity` under docker-init outlives everything. A rule that
  // counted any live process would never let a box stop.
  assert.equal(anyWorkRunning(readBackgroundWork(EMPTY, ADAPTER)), false);
});

test('a box with nothing of ours in it is empty, not unreadable', () => {
  // Boxes spawns the adapter as an exec and keeps none there between
  // connections, so a container that is up and has never been opened — or has
  // outlived the orchestrator process that opened it — runs the entrypoint and
  // nothing else. That read as a shape this could not understand, which
  // counted as busy: the card said "still running" and the reaper would not
  // touch the box for as long as it was up.
  const procs = table([1, 0, '/sbin/docker-init'], [7, 1, 'sleep infinity']);
  assert.equal(anyWorkRunning(readBackgroundWork(procs, ADAPTER)), false);
  assert.equal(anyWorkRunning(readBackgroundWork([], ADAPTER)), false);
  assert.equal(readBackgroundWork(procs, ADAPTER).byThread.size, 0);
});

test('an agent that outlived its adapter is still an agent', () => {
  // Which is what makes the empty answer above safe. Work is only ever under
  // one of the two, so a box with neither has none — and a box that has lost
  // its adapter still shows what its conversations were running, under the
  // conversation that was running it.
  const procs = table(
    [1, 0, '/sbin/docker-init'],
    [7, 1, 'sleep infinity'],
    [23019, 1, agent(23019, ONE)],
    [23490, 23019, shell('npm run build')],
  );
  const reading = readBackgroundWork(procs, ADAPTER);
  assert.equal(anyWorkRunning(reading), true);
  assert.deepEqual(
    reading.byThread.get(ONE)?.map((p) => p.command),
    ['npm run build'],
  );
});

test('a process that is its own parent does not hang the walk', () => {
  const procs = table(
    ...EMPTY.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]),
    [77, 77, 'something odd'],
  );
  assert.equal(anyWorkRunning(readBackgroundWork(procs, ADAPTER)), false);
});

test('a stray agent id outside the adapter tree is not this box', () => {
  const procs = table(
    ...EMPTY.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]),
    [500, 1, `some-tool --session-id=${ONE}`],
    [501, 500, 'sleep 60'],
  );
  assert.equal(anyWorkRunning(readBackgroundWork(procs, ADAPTER)), false);
});

// --- what it says is running -----------------------------------------------

test('the words the agent chose come back out of the wrapper', () => {
  assert.equal(commandOf(shell('npm run build')), 'npm run build');
  assert.equal(commandOf(shell(`echo '\\''hi'\\''`)), `echo 'hi'`);
});

test('a process the harness did not wrap is its own name', () => {
  assert.equal(commandOf('  /usr/bin/python3 crawl.py  '), '/usr/bin/python3 crawl.py');
});

test('how long it has been going comes from the reading', () => {
  const [entry] = readBackgroundWork(WORKING, ADAPTER, 1_000_000).byThread.get(ONE)!;
  assert.equal(entry?.startedAt, 1_000_000 - 154_000);
});

test('a host whose ps would not say leaves the age out rather than inventing one', () => {
  const procs = table(
    ...IDLE.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]),
    [23490, 23019, shell('npm test')],
  );
  assert.equal(readBackgroundWork(procs, ADAPTER).byThread.get(ONE)?.[0]?.startedAt, null);
});

test('the id of a process is the same on both sides of a stop', () => {
  // The browser is given it with the list and sends it back to name what to
  // kill, and what resolves it is a second reading taken inside the box —
  // where the pids are different numbers for the same processes.
  const line = shell('npm run build');
  assert.equal(processId(line), processId(line));
  assert.notEqual(processId(line), processId(shell('npm run build', 'ffff')));
  // Two runs of the same command are two different calls, and the harness's
  // per-call cwd file is what makes them different strings.
  assert.notEqual(processId(shell('npm test', 'aaaa')), processId(shell('npm test', 'bbbb')));
});

// --- stopping it -----------------------------------------------------------

test('stopping one entry takes the tree under it', () => {
  const id = processId(shell('sleep 300; echo done'));
  assert.deepEqual(workToStop(WORKING, ADAPTER, ONE, id), [23492, 23490]);
});

test('the leaves are killed before what spawned them', () => {
  // A parent killed first hands its children to init, out of the reading and
  // still running — a box that looks empty with a build in it.
  const procs = table(
    ...IDLE.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]),
    [100, 23019, shell('npm run build')],
    [200, 100, 'node .../npm-cli.js run build'],
    [300, 200, 'node .../vite build'],
  );
  assert.deepEqual(workToStop(procs, ADAPTER, ONE), [300, 200, 100]);
});

test('stopping a thread with no id given stops everything it is running', () => {
  const procs = table(
    ...IDLE.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]),
    [100, 23019, shell('npm run build', 'a1')],
    [200, 23019, shell('npm run watch', 'a2')],
  );
  assert.deepEqual(workToStop(procs, ADAPTER, ONE).sort(), [100, 200]);
});

test("a stop never reaches another conversation's work, or an agent", () => {
  const procs = table(
    ...WORKING.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]),
    [29098, 22977, agent(29098, TWO)],
    [40000, 29098, shell('npm run build', 'a1b2')],
  );
  assert.deepEqual(workToStop(procs, ADAPTER, TWO), [40000]);
  // Naming one thread's process while asking about another matches nothing.
  const other = processId(shell('sleep 300; echo done'));
  assert.deepEqual(workToStop(procs, ADAPTER, TWO, other), []);
  // And no id ever names an agent process, so no stop can kill a conversation.
  assert.deepEqual(workToStop(procs, ADAPTER, ONE, processId(agent(23019, ONE))), []);
});

test('a process that has already gone is nothing to stop', () => {
  assert.deepEqual(workToStop(IDLE, ADAPTER, ONE, processId(shell('npm test'))), []);
});

// --- the probe -------------------------------------------------------------

/** A probe over a table the test can swap, with a clock it can move. */
function probe(initial: ContainerProcess[] | null): {
  p: BackgroundProbe;
  set: (procs: ContainerProcess[] | null) => void;
  fail: (yes: boolean) => void;
  pass: (ms: number) => void;
  reads: () => number;
  trouble: () => Array<string | null>;
  changes: () => string[][];
  unexplained: () => Array<string | null>;
  settle: () => Promise<void>;
} {
  let procs = initial;
  let failing = false;
  let reads = 0;
  let now = 1_000_000;
  const trouble: Array<string | null> = [];
  const changes: string[][] = [];
  const why: Array<string | null> = [];
  const p = new BackgroundProbe({
    list: () => {
      reads += 1;
      return failing ? Promise.reject(new Error('no daemon')) : Promise.resolve(procs);
    },
    adapter: ADAPTER,
    ttlMs: 5_000,
    now: () => now,
    onTrouble: (error) => trouble.push(error?.message ?? null),
    onChange: (threads) => changes.push([...threads]),
    onUnexplained: (reason) => why.push(reason),
  });
  return {
    p,
    set: (next) => {
      procs = next;
    },
    fail: (yes) => {
      failing = yes;
    },
    pass: (ms) => {
      now += ms;
    },
    reads: () => reads,
    trouble: () => trouble,
    changes: () => changes,
    unexplained: () => why,
    settle: () => p.refresh(),
  };
}

test('the first reading is not waited for, and lands behind the reader', async () => {
  const { p, settle } = probe(WORKING);
  // Nothing has been read yet, and an unstarted box has nothing in it.
  assert.equal(p.active, false);
  await settle();
  assert.equal(p.active, true);
  assert.equal(p.work(ONE).length, 1);
});

test('a reading stands until it goes stale', async () => {
  const { p, set, pass, reads, settle } = probe(WORKING);
  await settle();
  assert.equal(p.active, true);
  assert.equal(reads(), 1);

  set(IDLE);
  // Asked again inside the window: the same answer, and the box is not asked.
  assert.equal(p.active, true);
  assert.equal(reads(), 1);

  pass(5_000);
  assert.equal(p.active, true);
  await settle();
  assert.equal(p.active, false);
  assert.equal(reads(), 2);
});

test('a task nobody reported the end of is still gone from the next reading', async () => {
  // The whole point. The old tally needed a `<task-notification>` naming the
  // call, and got one for six of this session's own eight tasks; the two it
  // missed would have held the box for four hours. Killing a shell reports
  // nothing to anyone, and answers correctly here regardless.
  const { p, set, pass, settle } = probe(WORKING);
  await settle();
  assert.equal(p.active, true);

  set(IDLE);
  pass(5_000);
  await settle();
  assert.equal(p.active, false);
  assert.deepEqual(p.work(ONE), []);
});

test('a thread whose work changed is told, and only that thread', async () => {
  // Nothing reports a build finishing, so the reading is the only news there
  // is: the bar above a composer goes away because this said so. Without it
  // the one that appeared stayed for as long as the thread was open.
  const { set, pass, changes, settle } = probe(IDLE);
  await settle();
  assert.deepEqual(changes(), []);

  set(WORKING);
  pass(5_000);
  await settle();
  assert.deepEqual(changes(), [[ONE]]);

  // A reading that says the same thing again says nothing at all.
  pass(5_000);
  await settle();
  assert.deepEqual(changes(), [[ONE]]);

  set(IDLE);
  pass(5_000);
  await settle();
  assert.deepEqual(changes(), [[ONE], [ONE]]);
});

test('one conversation starting something says nothing about another', async () => {
  const { set, pass, changes, settle } = probe(WORKING);
  // The first reading is itself news: a browser attaching to a box that has
  // been running something for an hour learns it from this.
  await settle();
  assert.deepEqual(changes(), [[ONE]]);

  set(
    table(
      ...WORKING.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]),
      [29098, 22977, agent(29098, TWO)],
      [40000, 29098, shell('npm run build', 'a1b2')],
    ),
  );
  pass(5_000);
  await settle();
  assert.deepEqual(changes(), [[ONE], [TWO]]);
});

test('a box that is not there is empty, not unreadable', async () => {
  // The two answers are opposites — one is knowledge, the other is silence —
  // and they arrived here as the same empty table. So every session that had
  // ever been started and was now stopped said "still running" for as long as
  // the orchestrator remembered it, with no thread able to say what.
  const { p, settle, unexplained: why } = probe(null);
  await settle();
  assert.equal(p.active, false);
  assert.deepEqual(why(), []);
});

test('a box that is up with no adapter in it holds nothing awake', async () => {
  // The reaper's own question, and the answer that kept every unopened box
  // running: an entrypoint and nothing else is an idle box.
  const { p, settle, unexplained: why } = probe(
    table([1, 0, '/sbin/docker-init'], [7, 1, 'sleep infinity']),
  );
  await settle();
  assert.equal(p.active, false);
  assert.deepEqual(why(), []);
});

test('a box that stops is empty from that moment, not from the next reading', async () => {
  // Said when the session is stopped rather than waited for: a card carrying
  // "still running" over the moment its box was shut down is the same wrong
  // answer, just for a shorter time.
  const { p, set, settle } = probe(WORKING);
  await settle();
  assert.equal(p.active, true);

  set(null);
  p.clear();
  assert.equal(p.active, false);
  assert.deepEqual(p.work(ONE), []);
});

test('a thread whose box was cleared is told, so its bar goes with it', async () => {
  const { p, changes, settle } = probe(WORKING);
  await settle();
  assert.deepEqual(changes(), [[ONE]]);

  p.clear();
  assert.deepEqual(changes(), [[ONE], [ONE]]);
});

test('the reason a box is busy with nothing to show is said once, and unsaid', async () => {
  const orphaned = table(
    ...EMPTY.map((x) => [x.pid, x.ppid, x.command] as [number, number, string]),
    [23019, 22977, 'claude --output-format stream-json'],
    [23490, 23019, shell('npm run build')],
  );
  const { set, pass, settle, unexplained: why } = probe(orphaned);
  await settle();
  assert.deepEqual(why(), ['work under an agent that names no conversation: npm run build']);

  // Still true a minute later, and still one line.
  for (let i = 0; i < 3; i += 1) {
    pass(5_000);
    await settle();
  }
  assert.equal(why().length, 1);

  set(IDLE);
  pass(5_000);
  await settle();
  assert.deepEqual(why().at(-1), null);
});

test('a box that cannot be asked keeps the answer it had', async () => {
  const { p, fail, pass, settle } = probe(WORKING);
  await settle();
  assert.equal(p.active, true);

  fail(true);
  pass(5_000);
  await settle();
  // Still believed busy: a daemon that did not answer has said nothing about
  // what is in the box.
  assert.equal(p.active, true);
  assert.equal(p.work(ONE).length, 1);

  fail(false);
  pass(5_000);
  await settle();
  assert.equal(p.active, true);
});

test('a box that stops being readable says so, once', async () => {
  // The answer is a guess for as long as this lasts, and the guess holds the
  // reaper off — so a probe that has quietly stopped working is a session
  // that never stops, for a reason nobody can see.
  const { fail, pass, trouble, settle } = probe(WORKING);
  await settle();
  assert.deepEqual(trouble(), []);

  fail(true);
  pass(5_000);
  await settle();
  assert.deepEqual(trouble(), ['no daemon']);

  // Still broken a minute later, and still one line: a poll that reported
  // every failure would bury the one that mattered.
  for (let i = 0; i < 3; i += 1) {
    pass(5_000);
    await settle();
  }
  assert.deepEqual(trouble(), ['no daemon']);

  // And it says when it is reading again, because until then every answer it
  // gave was the last one it was sure of.
  fail(false);
  pass(5_000);
  await settle();
  assert.deepEqual(trouble(), ['no daemon', null]);
});

test('two readers in the same moment are one reading', async () => {
  // `active` starts a refresh when it finds a stale answer, and every reader
  // finds it stale at once — the reaper sweeping while a browser is served.
  const { p, reads } = probe(WORKING);
  await Promise.all([p.refresh(), p.refresh(), p.refresh()]);
  assert.equal(reads(), 1);
});

// --- the call that is not this one -----------------------------------------

test('a tool call that backgrounds something is still recognisable as one', () => {
  // Not for counting any more — activity.ts asks it, because a call that runs
  // in the background is the call whose silence says nothing about the agent.
  assert.equal(startsBackgroundWork({ rawInput: { command: 'npm test' } }), false);
  assert.equal(
    startsBackgroundWork({ rawInput: { command: 'npm test', run_in_background: true } }),
    true,
  );
  assert.equal(startsBackgroundWork({ _meta: { claudeCode: { toolName: 'Monitor' } } }), true);
  assert.equal(startsBackgroundWork({ name: 'Bash' }), false);
});
