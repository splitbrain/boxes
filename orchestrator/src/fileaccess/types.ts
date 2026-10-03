import type { Readable } from 'node:stream';

/** Which of a box's writable mounts a file operation is against. */
export type FileRoot = 'workspace' | 'home' | 'nix';

/** One entry of a directory listing, whatever backs it. */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mode: number;
  mtimeMs: number;
}

/** A file that was read, and what had to be left out — the shape review/fs.ts's readTextFile already answers in. */
export interface FileRead {
  content: string;
  truncated: boolean;
  binary: boolean;
  size: number;
}

/** A file's whole bytes, for serving it as-is rather than as text. */
export interface RawFile {
  size: number;
  stream: Readable;
}

/**
 * Contained reads and writes under a box's workspace or home, whichever
 * backend the box runs on.
 *
 * Every method takes a box id and a workspace-relative path rather than a
 * resolved filesystem path, because a Kubernetes box has no path this
 * process can hold onto between calls — each call re-validates containment
 * on its own. `relPath` must already have passed `validRelativePath` (in
 * review/fs.ts); an implementation only has to keep a path that shape
 * contained, not reject the shapes that function already refuses.
 */
export interface FileAccess {
  readFile(boxId: string, root: FileRoot, relPath: string, cap: number): Promise<FileRead>;
  /** A regular file's bytes; anything else is refused. */
  openFile(boxId: string, root: FileRoot, relPath: string): Promise<RawFile>;
  writeFileAtomic(boxId: string, root: FileRoot, relPath: string, content: string): Promise<void>;
  removeFile(boxId: string, root: FileRoot, relPath: string): Promise<boolean>;
  fileHash(boxId: string, root: FileRoot, relPath: string, cap: number): Promise<string>;
  isDirectory(boxId: string, root: FileRoot, relPath: string): Promise<boolean>;
  listDir(boxId: string, root: FileRoot, relDir: string): Promise<DirEntry[]>;
  directorySize(boxId: string, root: FileRoot): Promise<number>;
}
