import { chownSync, mkdirSync, rmSync } from 'node:fs';
import { join, posix } from 'node:path';
import { log } from './log.ts';

/**
 * What a session is made of on disk: its workspace, and its home.
 *
 * Both are directories under DATA_DIR, bind-mounted into the session
 * container, so the orchestrator reads and writes them as ordinary files,
 * runs git over a workspace with no container running, and measures what a
 * session costs by walking two directories.
 *
 * A home holds thread transcripts, the tool caches an agent installs at
 * runtime, and whatever credential a login inside the box wrote, so `homes/`
 * is 0700, the same as `workspaces/`.
 */

/**
 * Default uid and gid the session container runs as.
 *
 * This is the one number the session image and the orchestrator have to agree
 * on, so it is defined once here: `SESSION_UID`/`SESSION_GID` default to it in
 * config.ts, and `session-image/Dockerfile` builds its `agent` user on it
 * through build args of the same name. Outside the range a login user is
 * normally given.
 *
 * A bind mount — unlike a named volume — is not ownership-initialised by
 * Docker, so every directory and file the orchestrator creates in a workspace
 * has to be given away explicitly, or the agent cannot write to its own
 * workspace. Unless the orchestrator is already running as this uid, in which
 * case there is nothing to give away; see chownToAgent.
 */
export const DEFAULT_SESSION_UID = 1020;
export const DEFAULT_SESSION_GID = 1020;

/**
 * The uid and gid in force, installed once at boot from the parsed config and
 * fixed for the life of the process.
 */
let owner: { uid: number; gid: number } = {
  uid: DEFAULT_SESSION_UID,
  gid: DEFAULT_SESSION_GID,
};

/** Installs the uid and gid session containers run as. Called from buildApp. */
export function setSessionOwner(uid: number, gid: number): void {
  owner = { uid, gid };
}

/** The uid and gid session containers run as. */
export function sessionOwner(): { readonly uid: number; readonly gid: number } {
  return owner;
}

/** Directory under DATA_DIR holding one directory per session workspace. */
export const WORKSPACES_SUBDIR = 'workspaces';

/** Directory under DATA_DIR holding one directory per session home. */
export const HOMES_SUBDIR = 'homes';

/** The parent of every workspace directory. */
export function workspacesRoot(dataDir: string): string {
  return join(dataDir, WORKSPACES_SUBDIR);
}

/** Where a session's files live, as this process sees them. */
export function workspacePath(dataDir: string, sessionId: string): string {
  return join(workspacesRoot(dataDir), sessionId);
}

/**
 * Where a session's files live as the Docker daemon sees them, which is what
 * a bind source has to name.
 *
 * Bind sources are resolved by the daemon, not by the process asking for the
 * mount, so a bind of a path under the orchestrator's own /data cannot use
 * the orchestrator's path for it. POSIX joining is correct on every supported
 * host: on Linux the daemon is the host, and under Docker Desktop it runs in
 * a Linux VM.
 */
export function hostWorkspacePath(hostDataDir: string, sessionId: string): string {
  return posix.join(hostDataDir, WORKSPACES_SUBDIR, sessionId);
}

/** The parent of every home directory. */
export function homesRoot(dataDir: string): string {
  return join(dataDir, HOMES_SUBDIR);
}

/** Where a session's home lives, as this process sees them. */
export function homePath(dataDir: string, sessionId: string): string {
  return join(homesRoot(dataDir), sessionId);
}

/** A session's home as the Docker daemon sees it, for the bind source. */
export function hostHomePath(hostDataDir: string, sessionId: string): string {
  return posix.join(hostDataDir, HOMES_SUBDIR, sessionId);
}

/**
 * Creates the workspaces and homes parents, mode 0700.
 *
 * One session's files must not be readable from another session, and the only
 * thing that reads across all of them is this process. 0700 on the parents
 * says so on the data volume itself, where a stray `docker run -v boxes-data`
 * would otherwise see everything.
 */
export function ensureWorkspacesRoot(dataDir: string): void {
  mkdirSync(workspacesRoot(dataDir), { recursive: true, mode: 0o700 });
  mkdirSync(homesRoot(dataDir), { recursive: true, mode: 0o700 });
}

/**
 * Creates a session's workspace directory and hands it to the agent user.
 * Returns the path as this process sees it.
 */
export function createWorkspace(dataDir: string, sessionId: string): string {
  ensureWorkspacesRoot(dataDir);
  const path = workspacePath(dataDir, sessionId);
  mkdirSync(path, { recursive: true, mode: 0o755 });
  chownToAgent(path);
  return path;
}

/**
 * Creates a session's home directory, empty.
 *
 * Empty is not usable on its own: a bind mount covers whatever the image put
 * in `/home/agent`, and Docker does not seed a bind the way it seeds a named
 * volume. `seedHomeFromImage` copies the image's own home in, and the mode
 * and owner set here stand until it does.
 */
export function createHome(dataDir: string, sessionId: string): string {
  ensureWorkspacesRoot(dataDir);
  const path = homePath(dataDir, sessionId);
  // 0700 rather than the workspace's 0755: a home holds the credentials a
  // login inside the box wrote, and nothing but the agent reads it.
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chownToAgent(path);
  return path;
}

/** Removes a session's workspace directory and everything in it. */
export function removeWorkspace(dataDir: string, sessionId: string): void {
  // recursive removal unlinks symlinks rather than following them, so a link
  // planted in the tree cannot reach out of it.
  rmSync(workspacePath(dataDir, sessionId), { recursive: true, force: true });
}

/** Removes a session's home directory and everything in it. */
export function removeHome(dataDir: string, sessionId: string): void {
  rmSync(homePath(dataDir, sessionId), { recursive: true, force: true });
}

/**
 * Gives a path to the session's agent user, so the agent can edit and delete
 * what the orchestrator wrote, REVIEW.md above all.
 *
 * Only root can give a file away. A deployment running the orchestrator as
 * the session uid itself needs none of this and returns at once, which is
 * what lets it drop root. One running as some other non-root user keeps the
 * files it wrote, which works until a container mounts them, so the failure
 * is logged rather than thrown.
 */
export function chownToAgent(path: string): void {
  if (process.getuid?.() === owner.uid) return;
  try {
    chownSync(path, owner.uid, owner.gid);
  } catch (err) {
    log.warn('could not give a workspace path to the agent user', {
      path,
      uid: owner.uid,
      error: (err as Error).message,
    });
  }
}
