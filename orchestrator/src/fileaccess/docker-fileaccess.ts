import { createReadStream, lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { directorySize } from '../diskusage.ts';
import * as fs from '../review/fs.ts';
import { homePath, nixPath, workspacePath } from '../workspaces.ts';
import type { DirEntry, FileAccess, FileRead, FileRoot, RawFile } from './types.ts';

/**
 * `FileAccess` over this process's own filesystem: a thin async wrapper
 * around review/fs.ts, which already holds the whole symlink-containment
 * invariant and is not touched here.
 *
 * Needs only DATA_DIR, not a box row: the root a box's files live
 * under is derived from its id the same way workspacePathOf/homePathOf in
 * boxes.ts do, and that derivation has nothing to do with whether the
 * box is directory-backed — a caller that needs to know that asks
 * BoxManager.reviewable() first, the same gate review/service.ts always
 * opened with under its old name, workspace().
 */

function rootPath(cfg: Config, boxId: string, root: FileRoot): string {
  if (root === 'workspace') return workspacePath(cfg.DATA_DIR, boxId);
  if (root === 'nix') return nixPath(cfg.DATA_DIR, boxId);
  return homePath(cfg.DATA_DIR, boxId);
}

/** Resolves relPath under a box's root, or throws the refusal review/fs.ts gave. */
function resolve(cfg: Config, boxId: string, root: FileRoot, relPath: string, mustExist: boolean): string {
  const resolved = fs.resolveInRoot(rootPath(cfg, boxId, root), relPath, mustExist);
  if (!resolved.ok) throw new Error(`refused: ${resolved.reason}`);
  return resolved.path;
}

export function dockerFileAccess(cfg: Config): FileAccess {
  return {
    async readFile(boxId, root, relPath, cap): Promise<FileRead> {
      return fs.readTextFile(resolve(cfg, boxId, root, relPath, true), cap);
    },

    async openFile(boxId, root, relPath): Promise<RawFile> {
      const path = resolve(cfg, boxId, root, relPath, true);
      const st = statSync(path);
      if (!st.isFile()) throw new Error('refused: not a file');
      return { size: st.size, stream: createReadStream(path) };
    },

    async writeFileAtomic(boxId, root, relPath, content): Promise<void> {
      fs.writeFileAtomic(resolve(cfg, boxId, root, relPath, false), content);
    },

    async removeFile(boxId, root, relPath): Promise<boolean> {
      // Missing is soft, same as pod-fs-script.ts's own 'remove' mode: nothing
      // to remove is not a refusal, so a resolve failure here reads as
      // "nothing there" for a missing path and rethrows anything else — a
      // real escape attempt is not something to shrug off as false.
      const resolved = fs.resolveInRoot(rootPath(cfg, boxId, root), relPath, true);
      if (!resolved.ok) {
        if (resolved.reason === 'missing') return false;
        throw new Error(`refused: ${resolved.reason}`);
      }
      return fs.removeFile(resolved.path);
    },

    async fileHash(boxId, root, relPath, _cap): Promise<string> {
      // Missing is '' — nothing to hash is not a refusal, and every existing
      // caller already treats it as "no REVIEW.md" — but an escape attempt
      // still throws, on the same terms as every other operation here: a
      // symlink planted at a fixed name like REVIEW.md must not read back as
      // "no review" and quietly get ignored. review/fs.ts's own fileHash caps
      // at its own MAX_REVIEW_BYTES rather than taking one, which is exactly
      // what every existing caller already passes here, so the cap this
      // interface carries for Kubernetes' sake goes unused on Docker.
      const resolved = fs.resolveInRoot(rootPath(cfg, boxId, root), relPath, true);
      if (!resolved.ok) {
        if (resolved.reason === 'missing') return '';
        throw new Error(`refused: ${resolved.reason}`);
      }
      return fs.fileHash(resolved.path);
    },

    async isDirectory(boxId, root, relPath): Promise<boolean> {
      const resolved = fs.resolveInRoot(rootPath(cfg, boxId, root), relPath, true);
      return resolved.ok && fs.isDirectory(resolved.path);
    },

    async listDir(boxId, root, relDir): Promise<DirEntry[]> {
      const real = resolve(cfg, boxId, root, relDir === '' ? '.' : relDir, true);
      return readdirSync(real, { withFileTypes: true }).map((entry) => {
        const st = lstatSync(join(real, entry.name));
        return {
          name: entry.name,
          isDirectory: st.isDirectory(),
          isSymlink: st.isSymbolicLink(),
          size: st.size,
          mode: st.mode,
          mtimeMs: st.mtimeMs,
        };
      });
    },

    async directorySize(boxId, root): Promise<number> {
      return directorySize(rootPath(cfg, boxId, root));
    },
  };
}
