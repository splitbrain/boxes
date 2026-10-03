/**
 * The program that runs inside a box pod for every contained file
 * operation a Kubernetes-backed review or attachment needs.
 *
 * A port of review/fs.ts's `resolveInRoot`, not a re-derivation of it: the
 * symlink-containment invariant it holds — resolve with realpath, require the
 * result at or under the root's own realpath, refuse a final component that
 * is itself a link — is reproduced here verbatim against Node's own `fs`,
 * because that is the one thing this file must get exactly as right as the
 * original. Everything downstream of a successful resolve (read/write/stat/
 * hash/list/remove) is new, since a Docker box never had to reach its files
 * this way.
 *
 * Every argument arrives as its own element of `process.argv`, never as text
 * this program parses out of a joined string, so there is nothing here for a
 * filename or a box id to break out of. Content for a write travels on
 * stdin, never as an argument, so there is no length a shell or an argument
 * vector would cap.
 *
 * Exit codes carry the refusal, the same four `review/fs.ts` uses:
 * 3 missing, 4 outside the root, 5 a symlink. Anything else nonzero is an
 * unexpected error, on stderr. A traversal (`..`) is refused before this ever
 * runs — orchestrator/src/fileaccess/kubernetes-fileaccess.ts calls
 * `validRelativePath` first, the same pure check `resolveInRoot` itself opens
 * with, so this program only ever sees a well-formed relative path.
 */
export const POD_FS_SCRIPT = `
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [mode, root, rel, extra] = process.argv.slice(1);

/** A resolveInRoot refusal, carrying the same exit code review/fs.ts's reasons map to. */
class Refusal extends Error {
  constructor(code) {
    super('refused: ' + code);
    this.code = code;
  }
}

function fail(code) {
  throw new Refusal(code);
}

function contains(rootReal, candidate) {
  return candidate === rootReal || candidate.startsWith(rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep);
}

/** Mirrors review/fs.ts's resolveInRoot exactly; throws a Refusal instead of returning one. */
function resolveInRoot(root, rel, mustExist) {
  let rootReal;
  try { rootReal = fs.realpathSync(root); } catch { fail(3); }
  const candidate = path.resolve(rootReal, rel);
  if (!contains(rootReal, candidate)) fail(4);
  let stats;
  try {
    stats = fs.lstatSync(candidate);
  } catch {
    if (mustExist) fail(3);
    const parent = path.dirname(candidate);
    let parentReal;
    try { parentReal = fs.realpathSync(parent); } catch { fail(3); }
    if (!contains(rootReal, parentReal)) fail(4);
    return candidate;
  }
  if (stats.isSymbolicLink()) fail(5);
  let real;
  try { real = fs.realpathSync(candidate); } catch { fail(3); }
  if (!contains(rootReal, real)) fail(4);
  return real;
}

function entryInfo(full) {
  const st = fs.lstatSync(full);
  return {
    isDirectory: st.isDirectory(),
    isSymlink: st.isSymbolicLink(),
    size: st.size,
    mode: st.mode,
    mtimeMs: st.mtimeMs,
  };
}

try {
switch (mode) {
  case 'read': {
    const cap = Number(extra);
    const real = resolveInRoot(root, rel, true);
    const fd = fs.openSync(real, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const toRead = Math.min(size, cap);
      const buf = Buffer.allocUnsafe(toRead);
      let readBytes = 0;
      while (readBytes < toRead) {
        const got = fs.readSync(fd, buf, readBytes, toRead - readBytes, null);
        if (got === 0) break;
        readBytes += got;
      }
      process.stderr.write(JSON.stringify({ size, truncated: size > cap }));
      process.stdout.write(buf.subarray(0, readBytes));
    } finally {
      fs.closeSync(fd);
    }
    break;
  }
  case 'stat': {
    const real = resolveInRoot(root, rel, true);
    process.stdout.write(JSON.stringify(entryInfo(real)));
    break;
  }
  case 'hash': {
    const cap = Number(extra);
    const real = resolveInRoot(root, rel, true);
    const fd = fs.openSync(real, 'r');
    try {
      const size = Math.min(fs.fstatSync(fd).size, cap);
      const buf = Buffer.allocUnsafe(size);
      let readBytes = 0;
      while (readBytes < size) {
        const got = fs.readSync(fd, buf, readBytes, size - readBytes, null);
        if (got === 0) break;
        readBytes += got;
      }
      process.stdout.write(crypto.createHash('sha256').update(buf.subarray(0, readBytes)).digest('hex').slice(0, 32));
    } finally {
      fs.closeSync(fd);
    }
    break;
  }
  case 'remove': {
    // Missing is soft here — nothing to remove is not a refusal — but an
    // escape attempt still is: reporting "false" for one would read as
    // "there was nothing to remove" when there was something, just not
    // anything this call may touch.
    let real;
    try {
      real = resolveInRoot(root, rel, true);
    } catch (err) {
      if (err instanceof Refusal && err.code === 3) {
        process.stdout.write('false');
        break;
      }
      throw err;
    }
    fs.unlinkSync(real);
    process.stdout.write('true');
    break;
  }
  case 'listdir': {
    const real = resolveInRoot(root, rel, true);
    const entries = fs.readdirSync(real, { withFileTypes: true }).map((e) => ({
      name: e.name,
      ...entryInfo(path.join(real, e.name)),
    }));
    process.stdout.write(JSON.stringify(entries));
    break;
  }
  case 'dirsize': {
    // The root itself, not a client-supplied path under it: this measures a
    // whole workspace or home, so there is nothing to contain against — only
    // the walk has to leave symlinks uncounted and unfollowed, the same rule
    // diskusage.ts's own directorySize keeps.
    let rootReal;
    try {
      rootReal = fs.realpathSync(root);
    } catch {
      process.stdout.write('0');
      break;
    }
    let total = 0;
    const stack = [rootReal];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const child = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          stack.push(child);
        } else if (entry.isFile()) {
          try {
            total += fs.lstatSync(child).size;
          } catch {
            // gone between readdir and stat
          }
        }
      }
    }
    process.stdout.write(String(total));
    break;
  }
  case 'write': {
    const real = resolveInRoot(root, rel, false);
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      const content = Buffer.concat(chunks);
      const dir = path.dirname(real);
      let fileMode = 0o644;
      try {
        fileMode = fs.statSync(real).mode & 0o777;
      } catch {
        // not there yet: the default stands
      }
      // A random suffix rather than a counter: this process has no state
      // across calls the way review/fs.ts's writeFileAtomic does, and
      // O_EXCL|O_NOFOLLOW is what actually refuses a planted link at this
      // name, the random part is only what keeps two writers from colliding.
      const tmp = path.join(dir, '.tmp.' + process.pid + '.' + crypto.randomBytes(8).toString('hex'));
      const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
      try {
        fs.writeSync(fd, content);
        fs.fchmodSync(fd, fileMode);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, real);
    });
    break;
  }
  default:
    fail(2);
}
} catch (err) {
  if (err instanceof Refusal) {
    process.exitCode = err.code;
  } else {
    process.stderr.write(String((err && err.stack) || err));
    process.exitCode = 1;
  }
}
`;
