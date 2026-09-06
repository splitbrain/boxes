import assert from 'node:assert/strict';
import { test } from 'vitest';
import { BackgroundProbe, backgroundWorkRunning, startsBackgroundWork } from './background.ts';
import type { ContainerProcess } from '../docker.ts';

/**
 * What the reaper is told about work a session left running.
 *
 * The fixtures are process tables, because that is what the box is asked for
 * now. The shape is the session image's own: docker-init, the entrypoint,
 * the adapter Boxes spawned, an agent process per conversation under it, and
 * under those the shells the agent's tool calls run in.
 */

const ADAPTER = 'claude-agent-acp';

/** A process table, written parent-first. */
function table(...rows: Array<[number, number, string]>): ContainerProcess[] {
  return rows.map(([pid, ppid, command]) => ({ pid, ppid, command }));
}

/** The container with the adapter up and no conversation in it yet. */
const EMPTY = table(
  [1, 0, '/sbin/docker-init -- /usr/local/bin/entrypoint.sh'],
  [8, 1, 'sleep infinity'],
  [19, 1, 'node /usr/local/bin/claude-agent-acp'],
);

/** The same, with one agent process under the adapter. */
const IDLE = table(...EMPTY.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]), [
  29271,
  19,
  '.../claude-agent-sdk-linux-x64/claude --output-format stream-json --session-id=d6d8',
]);

/** A shell under the agent, which is a tool call of some kind running. */
const SHELL: [number, number, string] = [
  32472,
  29271,
  "/bin/bash -c source /home/agent/.claude/shell-snapshots/snapshot.sh && eval 'npm run build'",
];

test('a box with no conversation in it has nothing running', () => {
  assert.equal(backgroundWorkRunning(EMPTY, ADAPTER), false);
});

test('an agent sitting there with no tool call running is not work', () => {
  assert.equal(backgroundWorkRunning(IDLE, ADAPTER), false);
});

test('a shell under the agent is work', () => {
  const procs = table(
    ...IDLE.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]),
    SHELL,
  );
  assert.equal(backgroundWorkRunning(procs, ADAPTER), true);
});

test('what the shell itself spawned keeps the answer true', () => {
  // The reading is about the shell being alive, not about what is under it —
  // but a live grandchild is a live shell, and both say the same thing.
  const procs = table(
    ...IDLE.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]),
    SHELL,
    [33736, 32472, 'node /workspace/node_modules/.bin/vitest run'],
  );
  assert.equal(backgroundWorkRunning(procs, ADAPTER), true);
});

test('work on one conversation is work in the box, whichever one it is', () => {
  const procs = table(
    ...IDLE.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]),
    [29098, 19, '.../claude --output-format stream-json --session-id=2d10'],
    [40000, 29098, '/bin/bash -c ... eval ...'],
  );
  assert.equal(backgroundWorkRunning(procs, ADAPTER), true);
});

test('the entrypoint the box was started with is not work', () => {
  // `sleep infinity` is PID 8 under docker-init and outlives everything. A
  // rule that counted any live process would never let a box stop.
  assert.equal(backgroundWorkRunning(EMPTY, ADAPTER), false);
});

test('a container that is not running what this expects is left alone', () => {
  // No adapter means the shape cannot be read, and a shape that cannot be
  // read is not evidence of an empty box. Stopping later is recoverable;
  // stopping a box with a two-hour build in it is not.
  const procs = table([1, 0, '/sbin/docker-init'], [8, 1, 'sleep infinity']);
  assert.equal(backgroundWorkRunning(procs, ADAPTER), true);
  assert.equal(backgroundWorkRunning([], ADAPTER), true);
});

test('a process that is its own parent does not hang the walk', () => {
  const procs = table(...EMPTY.map((p) => [p.pid, p.ppid, p.command] as [number, number, string]), [
    77,
    77,
    'something odd',
  ]);
  assert.equal(backgroundWorkRunning(procs, ADAPTER), false);
});

// --- the probe -------------------------------------------------------------

/** A probe over a table the test can swap, with a clock it can move. */
function probe(initial: ContainerProcess[]): {
  p: BackgroundProbe;
  set: (procs: ContainerProcess[]) => void;
  fail: (yes: boolean) => void;
  pass: (ms: number) => void;
  reads: () => number;
  trouble: () => Array<string | null>;
  settle: () => Promise<void>;
} {
  let procs = initial;
  let failing = false;
  let reads = 0;
  let now = 1_000_000;
  const trouble: Array<string | null> = [];
  const p = new BackgroundProbe(
    () => {
      reads += 1;
      return failing ? Promise.reject(new Error('no daemon')) : Promise.resolve(procs);
    },
    ADAPTER,
    5_000,
    () => now,
    (error) => trouble.push(error?.message ?? null),
  );
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
    settle: () => p.refresh(),
  };
}

const WORKING = table(
  ...IDLE.map((x) => [x.pid, x.ppid, x.command] as [number, number, string]),
  SHELL,
);

test('the first reading is not waited for, and lands behind the reader', async () => {
  const { p, settle } = probe(WORKING);
  // Nothing has been read yet, and an unstarted box has nothing in it.
  assert.equal(p.active, false);
  await settle();
  assert.equal(p.active, true);
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
