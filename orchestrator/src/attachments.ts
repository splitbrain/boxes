import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { StoredAttachment } from '../../shared/types.ts';
import { chownToAgent } from './workspaces.ts';

/**
 * Files the user attaches to a prompt, stored in the session's own workspace.
 *
 * Everything an attachment could be — a screenshot, a PDF, a CSV, a heap
 * dump — is the same thing here: bytes written into the workspace under a
 * name the agent can type into a `Read` call. Nothing here decides the file's
 * type, and what a client says about what it uploaded is the client's own
 * business.
 *
 * The workspace is a plain directory this process owns, so an upload is a
 * file write rather than a copy into a container, and it works while the
 * session is stopped.
 */

/** Directory attachments live in, relative to the workspace root. */
export const ATTACHMENTS_DIR = '.boxes/attachments';

/**
 * What goes in `.boxes/.gitignore`.
 *
 * Attachments land inside a tree that is very often a git repository the
 * agent is working in, where they would show up as untracked files in every
 * `git status` the user reads and in every commit the agent is careless
 * with. A `*` here ignores the whole directory including this file itself,
 * which keeps the repository's own .gitignore — a file the user owns —
 * untouched.
 */
const GITIGNORE = '*\n';

/**
 * Content types an attachment may be served back as itself.
 *
 * Images, SVG included, and PDFs — the formats a browser shows rather than
 * saves. An SVG can carry script, and these are files the agent can write,
 * served from the same origin as the dashboard, so both ways of opening one
 * are shut: through an `<img>`, which is how the thread shows it, a browser
 * runs nothing in an SVG and fetches nothing it references, and opened as a
 * document it gets `default-src 'none'; sandbox`, which leaves it no script,
 * no origin and no network.
 *
 * Everything not here is a download of unknown type. HTML is the deliberate
 * omission: a page served as one runs as this origin, and there is no way to
 * show it that does not.
 */
const SERVABLE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

/**
 * Types served without the `sandbox` CSP directive.
 *
 * A PDF is not rendered by the page but by the browser's own viewer, and a
 * sandboxed document is one a browser may refuse to hand to a viewer at all
 * — which turns "open it in a tab" back into a download, the one thing
 * serving it as `application/pdf` was for. The rest of the policy stays:
 * `default-src 'none'` still applies, and the viewer is browser-internal
 * rather than something the response can reach.
 */
const UNSANDBOXED = new Set(['application/pdf']);

/** How one stored file is served: as itself, or as a download of bytes. */
export interface ServedType {
  contentType: string;
  /** False for anything not on the list above, which is then never rendered. */
  inline: boolean;
  /** Whether the CSP sandboxes it; see UNSANDBOXED. */
  sandbox: boolean;
}

/** What to serve a stored attachment as, from its name alone. */
export function servedTypeFor(name: string): ServedType {
  const type = SERVABLE_TYPES[extname(name).toLowerCase()];
  if (!type) return { contentType: 'application/octet-stream', inline: false, sandbox: true };
  return { contentType: type, inline: true, sandbox: !UNSANDBOXED.has(type) };
}

/** Longest a stored name may be, extension included. */
const MAX_NAME = 100;

/** How many times a colliding name is suffixed before the upload is refused. */
const MAX_COLLISIONS = 100;

/**
 * A client's filename, reduced to something safe to be both a path component
 * and a line of a prompt.
 *
 * Two different worries, one answer. As a path it must not escape the
 * attachments directory, so separators and traversal have to go; as prompt
 * text it is quoted into the message the model reads, so a newline in it
 * could forge a line of that message and a bracket could break the format
 * the dashboard parses back out. Keeping letters, digits, dot, dash and
 * underscore and replacing every run of anything else with a single
 * underscore settles all of it at once, and leaves a name that survives
 * being typed into a shell.
 *
 * Unicode letters are kept, so `Größe.png` is not reduced to `Gr__e.png`. A
 * leading dot is dropped rather than replaced, so an upload cannot land on
 * `.gitignore` and turn the ignore rule above off.
 */
export function safeAttachmentName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  const cleaned = base
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._]+/, '');
  if (!cleaned) return 'attachment';
  if (cleaned.length <= MAX_NAME) return cleaned;
  // Truncate the stem rather than the name, so the extension — which is what
  // tells the agent and the browser what the file is — always survives.
  const ext = extname(cleaned).slice(0, 16);
  return cleaned.slice(0, MAX_NAME - ext.length) + ext;
}

/** `name`, `name-2`, `name-3`… — the first that is not taken. */
function freePath(dir: string, name: string): { name: string; path: string } {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 1; n <= MAX_COLLISIONS; n++) {
    const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
    const path = join(dir, candidate);
    if (!existsSync(path)) return { name: candidate, path };
  }
  throw new Error(`too many attachments named ${name}`);
}

/**
 * Writes one attachment into a workspace and hands back where it landed.
 *
 * The name is sanitised to a single path component before it is used, so
 * containment here is by construction rather than by a check: there is no
 * path to resolve and compare, because the client never supplies one.
 */
export function storeAttachment(
  workspace: string,
  name: string,
  bytes: Buffer,
): StoredAttachment {
  const boxes = join(workspace, '.boxes');
  const dir = join(workspace, ATTACHMENTS_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    // Both levels, because either may be the one this call created.
    chownToAgent(boxes);
    chownToAgent(dir);
  }

  const ignore = join(boxes, '.gitignore');
  if (!existsSync(ignore)) {
    writeFileSync(ignore, GITIGNORE, { mode: 0o644 });
    chownToAgent(ignore);
  }

  const target = freePath(dir, safeAttachmentName(name));
  writeFileSync(target.path, bytes, { mode: 0o644 });
  // The agent reads these, and in the normal deployment it is a different uid
  // from the one that just wrote them.
  chownToAgent(target.path);

  return {
    name: target.name,
    path: `${ATTACHMENTS_DIR}/${target.name}`,
    size: bytes.byteLength,
  };
}
