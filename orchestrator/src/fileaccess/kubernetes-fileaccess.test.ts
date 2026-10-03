import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it } from 'vitest';
import { loadConfig, type Config } from '../config.ts';
import { setKubernetesForTests } from '../kubernetes.ts';
import { kubernetesFileAccess } from './kubernetes-fileaccess.ts';

/**
 * The wrapper around pod-fs-script.ts: does it call the right command, and
 * does it turn the script's exit codes and JSON back into what `FileAccess`
 * promises? The script's own containment behaviour is pod-fs-script.test.ts's
 * job, run for real against a real filesystem — this file fakes the exec
 * transport only.
 */

function cfg(): Config {
  return loadConfig({ RUNTIME: 'kubernetes' });
}

interface Call {
  command: string[];
  stdin: PassThrough | null;
}

/** Installs a fake exec that answers one call with a fixed stdout/stderr/exit code. */
function fakeExec(
  answer: (call: Call) => { stdout?: string | Buffer; stderr?: string; code?: number },
): Call[] {
  const calls: Call[] = [];
  setKubernetesForTests({
    core: {},
    exec: {
      exec: async (
        _namespace: string,
        _podName: string,
        _containerName: string,
        command: string[],
        stdout: NodeJS.WritableStream | null,
        stderr: NodeJS.WritableStream | null,
        stdin: PassThrough | null,
        _tty: boolean,
        statusCallback?: (status: { status?: string; details?: { causes?: Array<{ reason?: string; message?: string }> } }) => void,
      ) => {
        calls.push({ command, stdin });
        const { stdout: out = '', stderr: err = '', code = 0 } = answer({ command, stdin });
        const listeners = new Map<string, Array<() => void>>();
        setTimeout(() => {
          if (out) (stdout as NodeJS.WritableStream).write(out);
          if (err) (stderr as NodeJS.WritableStream).write(err);
          statusCallback?.(
            code === 0
              ? { status: 'Success' }
              : { status: 'Failure', details: { causes: [{ reason: 'ExitCode', message: String(code) }] } },
          );
          (stdout as NodeJS.WritableStream & { end: () => void })?.end();
          (stderr as NodeJS.WritableStream & { end: () => void })?.end();
          for (const cb of listeners.get('close') ?? []) cb();
        });
        return {
          on: (event: string, cb: () => void) => {
            const arr = listeners.get(event) ?? [];
            arr.push(cb);
            listeners.set(event, arr);
          },
        };
      },
    },
  } as never);
  return calls;
}

afterEach(() => {
  setKubernetesForTests(null);
});

describe('readFile', () => {
  it('reads content and metadata on success', async () => {
    fakeExec(() => ({ stdout: 'hello', stderr: JSON.stringify({ size: 5, truncated: false }), code: 0 }));
    const fa = kubernetesFileAccess(cfg());
    const read = await fa.readFile('s1', 'workspace', 'a.txt', 1000);
    assert.deepEqual(read, { content: 'hello', truncated: false, binary: false, size: 5 });
  });

  it('detects a NUL byte as binary, with no content', async () => {
    fakeExec(() => ({
      stdout: Buffer.from([0x41, 0x00, 0x42]).toString('binary'),
      stderr: JSON.stringify({ size: 3, truncated: false }),
      code: 0,
    }));
    const fa = kubernetesFileAccess(cfg());
    const read = await fa.readFile('s1', 'workspace', 'a.bin', 1000);
    assert.equal(read.binary, true);
    assert.equal(read.content, '');
  });

  it('throws a readable error for each refusal code', async () => {
    for (const [code, text] of [
      [3, 'missing'],
      [4, 'outside'],
      [5, 'symlink'],
    ] as const) {
      fakeExec(() => ({ code }));
      const fa = kubernetesFileAccess(cfg());
      await assert.rejects(() => fa.readFile('s1', 'workspace', 'a.txt', 1000), new RegExp(text));
    }
  });

  it('refuses a client-supplied path before ever calling exec', async () => {
    const calls = fakeExec(() => ({ code: 0, stdout: '', stderr: '{"size":0,"truncated":false}' }));
    const fa = kubernetesFileAccess(cfg());
    await assert.rejects(() => fa.readFile('s1', 'workspace', '../etc/passwd', 1000));
    assert.equal(calls.length, 0);
  });

  it('runs against the workspace or home mount path, and the given cap', async () => {
    const calls = fakeExec(() => ({ code: 0, stdout: '', stderr: '{"size":0,"truncated":false}' }));
    const fa = kubernetesFileAccess(cfg());
    await fa.readFile('s1', 'home', 'a.txt', 42);
    assert.deepEqual(calls.at(0)!.command.slice(4), ['read', '/home/agent', 'a.txt', '42']);
  });
});

describe('writeFileAtomic', () => {
  it('sends the content on stdin, not as an argument', async () => {
    let seenStdin = '';
    fakeExec((call) => {
      call.stdin?.on('data', (c) => (seenStdin += c.toString('utf8')));
      return { code: 0 };
    });
    const fa = kubernetesFileAccess(cfg());
    await fa.writeFileAtomic('s1', 'workspace', 'REVIEW.md', '# hello\n');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(seenStdin, '# hello\n');
  });

  it('throws on a refusal', async () => {
    fakeExec(() => ({ code: 5 }));
    const fa = kubernetesFileAccess(cfg());
    await assert.rejects(() => fa.writeFileAtomic('s1', 'workspace', 'REVIEW.md', 'x'), /symlink/);
  });
});

describe('fileHash', () => {
  it('is empty for a missing file rather than a thrown error', async () => {
    fakeExec(() => ({ code: 3 }));
    const fa = kubernetesFileAccess(cfg());
    assert.equal(await fa.fileHash('s1', 'workspace', 'a.txt', 1000), '');
  });

  it('answers with the hash on success', async () => {
    fakeExec(() => ({ code: 0, stdout: 'a'.repeat(32) }));
    const fa = kubernetesFileAccess(cfg());
    assert.equal(await fa.fileHash('s1', 'workspace', 'a.txt', 1000), 'a'.repeat(32));
  });
});

describe('removeFile', () => {
  it('reports the script boolean literally', async () => {
    fakeExec(() => ({ code: 0, stdout: 'true' }));
    assert.equal(await kubernetesFileAccess(cfg()).removeFile('s1', 'workspace', 'a.txt'), true);
    fakeExec(() => ({ code: 0, stdout: 'false' }));
    assert.equal(await kubernetesFileAccess(cfg()).removeFile('s1', 'workspace', 'a.txt'), false);
  });
});

describe('isDirectory', () => {
  it('answers from the stat JSON, and false for any refusal', async () => {
    fakeExec(() => ({ code: 0, stdout: JSON.stringify({ isDirectory: true }) }));
    assert.equal(await kubernetesFileAccess(cfg()).isDirectory('s1', 'workspace', 'sub'), true);
    fakeExec(() => ({ code: 3 }));
    assert.equal(await kubernetesFileAccess(cfg()).isDirectory('s1', 'workspace', 'nosuch'), false);
  });
});

describe('listDir', () => {
  it('parses the entry array, and accepts an empty relDir for the root', async () => {
    const entries = [{ name: 'a.txt', isDirectory: false, isSymlink: false, size: 1, mode: 0o644, mtimeMs: 0 }];
    const calls = fakeExec(() => ({ code: 0, stdout: JSON.stringify(entries) }));
    const result = await kubernetesFileAccess(cfg()).listDir('s1', 'workspace', '');
    assert.deepEqual(result, entries);
    assert.deepEqual(calls.at(0)!.command.slice(4), ['listdir', '/workspace', '']);
  });
});

describe('directorySize', () => {
  it('parses the byte count', async () => {
    fakeExec(() => ({ code: 0, stdout: '12345' }));
    assert.equal(await kubernetesFileAccess(cfg()).directorySize('s1', 'home'), 12345);
  });
});
