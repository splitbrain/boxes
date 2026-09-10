import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '../log.ts';

/**
 * The one place review spawns a git process.
 *
 * This file exists so that a single, reviewable thing decides how git is
 * invoked over an agent-controlled tree, because the tree is hostile by
 * assumption: repo-local configuration can execute commands on exactly the
 * operations review runs. `core.fsmonitor` runs a hook on `status`; external
 * diff drivers, `textconv` and clean/smudge filters run on `diff`. A workspace
 * where the agent wrote `.git/config` would otherwise get code execution in the
 * orchestrator — the process holding the Docker socket.
 *
 * So every git process gets its argv prefix and its environment from one
 * builder here, and a test asserts `hardeningFlags()`.
 *
 * Everything run through here is local. No invocation fetches, pushes, or
 * resolves a remote, and `GIT_TERMINAL_PROMPT=0` means one that somehow tried
 * would fail rather than block.
 */

/**
 * An empty directory to point HOME at, so no global or per-user git
 * configuration is read. Created once per process, lazily, because a test that
 * never runs git should not leave a directory behind.
 */
let emptyHome: string | null = null;

function homeForGit(): string {
  if (emptyHome === null) emptyHome = mkdtempSync(join(tmpdir(), 'boxes-git-home-'));
  return emptyHome;
}

/**
 * The flags every git invocation carries, ahead of the subcommand.
 *
 * - `safe.directory` — the workspace is owned by the session uid (see
 *   SESSION_UID) and git refuses to operate on a repository owned by someone
 *   else. Scoped to the one root rather than `*`.
 * - `core.fsmonitor=false` — the one config value that turns `status` into a
 *   command execution. Overridden here rather than trusted to be absent.
 * - `core.hooksPath` — pointed at the empty home, so no hook in the repository
 *   can be found by anything that would look for one.
 * - `protocol.*.allow=never` — nothing here talks to a remote, and this makes
 *   an invocation that tried fail instead.
 * - `core.quotepath=false` — not hardening: it keeps non-ASCII paths unquoted
 *   so they match the paths the file tree reports.
 */
export function hardeningFlags(root: string): string[] {
  return [
    '-c',
    `safe.directory=${root}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    `core.hooksPath=${homeForGit()}`,
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'protocol.file.allow=never',
    '-c',
    'core.quotepath=false',
  ];
}

/**
 * The environment every git invocation runs with: this process's own, minus
 * everything that would make git read configuration, prompt, or take a lock it
 * does not need.
 *
 * The proxy variables are dropped too, because nothing here goes to the
 * network.
 */
export function hardenedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'GIT_CONFIG',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_EXTERNAL_DIFF',
    'GIT_SSH',
    'GIT_SSH_COMMAND',
    'GIT_ASKPASS',
    'SSH_ASKPASS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
  ]) {
    delete env[name];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    // No global config: HOME is an empty directory this process made.
    HOME: homeForGit(),
    XDG_CONFIG_HOME: homeForGit(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    // Nothing here is interactive, and a pager would never be read.
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    LC_ALL: 'C',
  };
}

/** Diff flags that keep a repository's own config from running a program. */
export const DIFF_SAFETY_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color'] as const;

/** How long a single git invocation may take before it is killed. */
const TIMEOUT_MS = 20_000;

/** How much output a single git invocation may produce. */
const MAX_OUTPUT = 16 * 1024 * 1024;

/** What a git invocation produced. */
export interface GitResult {
  /** True when git exited 0. */
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Null when git was killed before reporting one. */
  code: number | null;
}

/**
 * Runs one git subcommand in a workspace and returns its output.
 *
 * `args` is the subcommand and its own arguments; the hardening prefix and the
 * environment are added here and cannot be passed in. A non-zero exit is a
 * result rather than a throw, because most callers have a meaningful answer for
 * it: "this is not a repository", "this revision is unknown", "there is no
 * diff".
 */
export async function git(root: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...hardeningFlags(root), ...args],
      {
        cwd: root,
        env: hardenedEnv(),
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT,
        // Paths and file content are bytes, and everything review shows is
        // text, so they are decoded here.
        encoding: 'utf8',
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
          if (typeof code !== 'number') {
            log.warn('git invocation failed', { args: args[0], error: err.message });
          }
          resolve({
            ok: false,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            code: typeof code === 'number' ? code : null,
          });
          return;
        }
        resolve({ ok: true, stdout, stderr, code: 0 });
      },
    );
  });
}

/** The output of a git invocation, or '' when it failed. */
export async function gitOut(root: string, args: string[]): Promise<string> {
  const result = await git(root, args);
  return result.ok ? result.stdout : '';
}

/** Whether a directory is the top of a git work tree, and where that top is. */
export async function topLevel(root: string): Promise<string | null> {
  const result = await git(root, ['rev-parse', '--show-toplevel']);
  if (!result.ok) return null;
  const path = result.stdout.trim();
  return path === '' ? null : path;
}

/** The commit HEAD names, or '' outside a repository or before the first commit. */
export async function headCommit(root: string): Promise<string> {
  const result = await git(root, ['rev-parse', 'HEAD']);
  return result.ok ? result.stdout.trim() : '';
}
