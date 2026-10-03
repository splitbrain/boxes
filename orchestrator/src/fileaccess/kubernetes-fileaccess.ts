import { Readable } from 'node:stream';
import type { Config } from '../config.ts';
import { HOME_DIR, NIX_DIR, WORKSPACE_DIR } from '../docker.ts';
import { execInPod, execInPodBinary, execWithStdin, podName } from '../kubernetes.ts';
import { validRelativePath } from '../review/fs.ts';
import { POD_FS_SCRIPT } from './pod-fs-script.ts';
import type { DirEntry, FileAccess, FileRead, FileRoot, RawFile } from './types.ts';

/**
 * `FileAccess` over a box pod's own filesystem, run through
 * `pod-fs-script.ts` — one exec call per operation, each doing its own
 * resolve-then-act rather than trusting a path resolved by an earlier call,
 * because nothing here can hold a pod-side path open the way a host one
 * stays valid between two calls on this process's own filesystem.
 *
 * Every relPath is checked with `validRelativePath` before it ever reaches an
 * exec call, the same gate `review/fs.ts`'s own `resolveInRoot` opens with —
 * a path that fails it is a caller error (the review and attachment routes
 * already refuse one before calling anything here), not a pod's to see.
 */

function rootDir(root: FileRoot): string {
  if (root === 'workspace') return WORKSPACE_DIR;
  if (root === 'nix') return NIX_DIR;
  return HOME_DIR;
}

function checkPath(relPath: string): void {
  if (!validRelativePath(relPath)) {
    throw new Error(`not a valid relative path: ${relPath}`);
  }
}

/** Maps the script's refusal exit codes onto an Error; anything else is unexpected. */
function refusalError(code: number | null, stderr: string): Error {
  const reason = code === 3 ? 'missing' : code === 4 ? 'outside the root' : code === 5 ? 'a symlink' : null;
  return reason
    ? new Error(`refused: ${reason}`)
    : new Error(`pod file operation exited ${code ?? 'unknown'}: ${stderr.trim()}`);
}

export function kubernetesFileAccess(cfg: Config): FileAccess {
  function podCmd(args: string[]): string[] {
    return ['node', '-e', POD_FS_SCRIPT, '--', ...args];
  }

  async function run(boxId: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return execInPod(podName(boxId), podCmd(args), cfg, { maxOutput: MAX_STDOUT_BYTES });
  }

  /** For `read`/`hash`, whose stdout is a file's own bytes rather than text this process ever decodes. */
  async function runBinary(
    boxId: string,
    args: string[],
  ): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
    return execInPodBinary(podName(boxId), podCmd(args), cfg, { maxOutput: MAX_STDOUT_BYTES });
  }

  return {
    async readFile(boxId, root, relPath, cap): Promise<FileRead> {
      checkPath(relPath);
      const { stdout, stderr, code } = await runBinary(boxId, ['read', rootDir(root), relPath, String(cap)]);
      if (code !== 0) throw refusalError(code, stderr);
      const meta = JSON.parse(stderr) as { size: number; truncated: boolean };
      const binary = stdout.includes(0);
      return {
        content: binary ? '' : stdout.toString('utf8'),
        truncated: meta.truncated,
        binary,
        size: meta.size,
      };
    },

    async openFile(boxId, root, relPath): Promise<RawFile> {
      checkPath(relPath);
      if (await this.isDirectory(boxId, root, relPath)) throw new Error('refused: not a file');
      // One exec carries the whole file, so the cap is the exec's own: a file
      // past it is refused rather than served cut short.
      const { stdout, stderr, code } = await runBinary(boxId, [
        'read',
        rootDir(root),
        relPath,
        String(MAX_STDOUT_BYTES),
      ]);
      if (code !== 0) throw refusalError(code, stderr);
      const meta = JSON.parse(stderr) as { size: number; truncated: boolean };
      if (meta.truncated) throw new Error('refused: too large');
      return { size: stdout.byteLength, stream: Readable.from([stdout]) };
    },

    async writeFileAtomic(boxId, root, relPath, content): Promise<void> {
      checkPath(relPath);
      const { stderr, code } = await execWithStdin(
        podName(boxId),
        podCmd(['write', rootDir(root), relPath]),
        cfg,
        Buffer.from(content, 'utf8'),
      );
      if (code !== 0) throw refusalError(code, stderr);
    },

    async removeFile(boxId, root, relPath): Promise<boolean> {
      checkPath(relPath);
      const { stdout, stderr, code } = await run(boxId, ['remove', rootDir(root), relPath]);
      if (code !== 0) throw refusalError(code, stderr);
      return stdout === 'true';
    },

    async fileHash(boxId, root, relPath, cap): Promise<string> {
      checkPath(relPath);
      const { stdout, stderr, code } = await run(boxId, ['hash', rootDir(root), relPath, String(cap)]);
      if (code === 3) return '';
      if (code !== 0) throw refusalError(code, stderr);
      return stdout;
    },

    async isDirectory(boxId, root, relPath): Promise<boolean> {
      checkPath(relPath);
      const { stdout, code } = await run(boxId, ['stat', rootDir(root), relPath]);
      if (code !== 0) return false;
      return (JSON.parse(stdout) as { isDirectory: boolean }).isDirectory;
    },

    async listDir(boxId, root, relDir): Promise<DirEntry[]> {
      checkPath(relDir === '' ? '.' : relDir);
      const { stdout, stderr, code } = await run(boxId, ['listdir', rootDir(root), relDir]);
      if (code !== 0) throw refusalError(code, stderr);
      return JSON.parse(stdout) as DirEntry[];
    },

    async directorySize(boxId, root): Promise<number> {
      const { stdout, stderr, code } = await run(boxId, ['dirsize', rootDir(root), '']);
      if (code !== 0) throw refusalError(code, stderr);
      return Number(stdout);
    },
  };
}

/** A file endpoint caps its reads well under this; the margin is for the JSON metadata line on stderr, not stdout. */
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
