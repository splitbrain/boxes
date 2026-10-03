import { log } from '../log.ts';
import { runtime } from '../runtime.ts';

/** A box's container and the workspace inside it: where review runs git. */
export interface GitBox {
  /** The running container git is executed in. */
  containerId: string;
  /** The workspace root, as the container names it. */
  workspaceDir: string;
}

/**
 * The container and the directory one git invocation runs in.
 *
 * It is all a caller says about where git runs. {@link git} builds the command
 * line and the environment itself.
 */
export interface GitTarget {
  /** The running container git is executed in. */
  containerId: string;
  /** The directory git runs in, as the container names it. */
  dir: string;
}

/**
 * The flags every git invocation carries, ahead of the subcommand.
 *
 * `core.quotepath=false` makes git write non-ASCII paths unquoted, as the
 * parsers and the file tree expect.
 */
function gitFlags(): string[] {
  return ['-c', 'core.quotepath=false'];
}

/**
 * The variables every git invocation adds to the container's own environment.
 *
 * Every invocation only reads. `GIT_OPTIONAL_LOCKS=0` stops git from refreshing
 * the index, which takes a lock the agent's own git would wait for.
 * `GIT_LITERAL_PATHSPECS=1` makes a pathspec a literal path, so a name holding
 * `*`, `?` or `[` matches only itself. `GIT_TERMINAL_PROMPT=0` makes git fail
 * rather than wait at a credential prompt. `LC_ALL=C` fixes the language of
 * git's output.
 */
export function gitEnv(): Record<string, string> {
  return {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

/**
 * Diff flags the diff parser needs. They keep external diff drivers, textconv
 * filters and colour out of the output, so the parser reads git's plain
 * unified diff of the file's bytes.
 */
export const DIFF_PARSE_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color'] as const;

/**
 * The whole command line one invocation runs: git, the flags every invocation
 * carries, and the subcommand with its own arguments.
 *
 * Every `diff` gets {@link DIFF_PARSE_FLAGS} right after the subcommand.
 */
export function gitArgv(args: string[]): string[] {
  const sub = args[0] === 'diff' ? ['diff', ...DIFF_PARSE_FLAGS, ...args.slice(1)] : args;
  return ['git', ...gitFlags(), ...sub];
}

/** How long a single git invocation may take before it is killed. */
const TIMEOUT_MS = 20_000;

/** The most bytes kept of each output stream of one git invocation. */
const MAX_OUTPUT = 16 * 1024 * 1024;

/** What a git invocation produced. */
export interface GitResult {
  /** True when git exited 0. */
  ok: boolean;
  /** What git wrote to standard output. */
  stdout: string;
  /** What git wrote to standard error. */
  stderr: string;
  /** The exit code, or null when there is none, as when git was killed. */
  code: number | null;
}

/**
 * A function that runs one git command line and reports what it produced.
 * Tests replace the default runner with one that needs no Docker.
 */
export type GitRunner = (
  target: GitTarget,
  argv: string[],
  env: Record<string, string>,
) => Promise<GitResult>;

/**
 * The runner review ships with: one exec in the box container, as the agent
 * user.
 *
 * A repository's configuration can make git run commands, for example a clean
 * filter on `diff` or an fsmonitor hook on `status`. In the box, such a command
 * can do only what the agent could do anyway. In this process, it would run
 * next to the Docker socket.
 */
const inBoxContainer: GitRunner = async (target, argv, env) => {
  const result = await runtime().exec.execInContainer(target.containerId, argv, {
    workingDir: target.dir,
    env,
    timeoutMs: TIMEOUT_MS,
    maxOutput: MAX_OUTPUT,
  });
  return {
    ok: result.code === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
  };
};

/** The runner {@link git} uses. Only tests replace it. */
let runner: GitRunner = inBoxContainer;

/** Replaces the runner that starts git. Null puts the shipped one back. */
export function setGitRunnerForTests(next: GitRunner | null): void {
  runner = next ?? inBoxContainer;
}

/**
 * Runs one git subcommand in a target directory and returns its output.
 *
 * `args` is the subcommand and its own arguments. A non-zero exit comes back
 * as a result, not as an exception, because callers read it as an answer, such
 * as "not a repository". A box that cannot be reached also gives a failed
 * result, so the review loses git but still responds.
 */
export async function git(target: GitTarget, args: string[]): Promise<GitResult> {
  try {
    return await runner(target, gitArgv(args), gitEnv());
  } catch (err) {
    log.warn('git invocation failed', { args: args[0], error: (err as Error).message });
    return { ok: false, stdout: '', stderr: '', code: null };
  }
}

/** The output of a git invocation, or '' when it failed. */
export async function gitOut(target: GitTarget, args: string[]): Promise<string> {
  const result = await git(target, args);
  return result.ok ? result.stdout : '';
}

/**
 * Whether the target directory is the top of a git work tree.
 *
 * `--show-prefix` prints where the directory sits inside the work tree, which
 * is empty only at the top. This needs no path comparison, so a symlink in the
 * path cannot hide a repository.
 */
export async function isTopLevel(target: GitTarget): Promise<boolean> {
  const result = await git(target, ['rev-parse', '--show-prefix']);
  return result.ok && result.stdout.trim() === '';
}

/** The commit HEAD names, or '' outside a repository or before the first commit. */
export async function headCommit(target: GitTarget): Promise<string> {
  const result = await git(target, ['rev-parse', 'HEAD']);
  return result.ok ? result.stdout.trim() : '';
}
