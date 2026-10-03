import type { WebSocket } from 'ws';
import { parseTerminalControl } from '../../../shared/terminal.ts';
import { log } from '../log.ts';
import { runtime } from '../runtime.ts';
import type { TerminalExec } from '../runtime/types.ts';
import type { BoxManager } from '../boxes.ts';

/**
 * How many bytes one browser's socket may have waiting on it.
 *
 * Past this the pty is paused, which blocks the program writing into it.
 */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/** Columns the pty opens at, until the browser reports its own width. */
const DEFAULT_COLS = 80;

/** Rows the pty opens at, until the browser reports its own height. */
const DEFAULT_ROWS = 24;

/**
 * How often the server pings the browser, in milliseconds.
 *
 * An open terminal keeps its box running, so a dead socket must be found
 * sooner than TCP would find it.
 */
const PING_MS = 30_000;

/** How many pings the browser may leave unanswered before it is dropped. */
const MISSED_PINGS = 2;

/**
 * How long to wait for the browser's size before the pty opens at the
 * default size, in milliseconds. The dashboard sends its size first.
 */
const SIZE_WAIT_MS = 2_000;

/** WebSocket close codes this endpoint uses besides 1000. */
const CLOSE = {
  /** Policy violation, such as a browser that stopped answering pings. */
  policy: 1008,
  /** Internal error, such as a box or pty that could not be reached. */
  unavailable: 1011,
} as const;

/**
 * Attaches one browser to a pty in the box's container.
 *
 * Binary frames carry the pty's bytes in both directions. Text frames carry
 * control messages from the browser, such as the window size. Every browser
 * that opens a terminal on a box gets the same shell.
 *
 * The box is started first, which can take seconds, so input that arrives
 * meanwhile is queued. The socket closing ends the shell, and the shell
 * ending closes the socket.
 */
export function attachTerminal(ws: WebSocket, boxId: string, manager: BoxManager): void {
  const slog = log.box(boxId);
  const release = manager.holdTerminal(boxId);

  /** The pty, once it is open. Null while the box is still being started. */
  let terminal: TerminalExec | null = null;
  /** Bytes the browser sent before the pty was there. */
  const queued: Buffer[] = [];
  /** The width the browser last reported. */
  let cols = DEFAULT_COLS;
  /** The height the browser last reported. */
  let rows = DEFAULT_ROWS;
  /** True once the browser has reported its size. */
  let sized = false;
  /** True once the teardown has run. */
  let closed = false;

  /** Ends the size wait early. */
  let resolveSize: () => void = () => {};
  /** Resolves once the size is known, so the pty opens at the right width. */
  const knownSize = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SIZE_WAIT_MS);
    timer.unref?.();
    resolveSize = () => {
      clearTimeout(timer);
      resolve();
    };
  });

  /** Tears down both ends once, whichever goes first. */
  const close = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    release();
    // Not awaited, so the socket closes without waiting on the box.
    void terminal?.close();
    if (ws.readyState === ws.OPEN) ws.close(code, reason);
  };

  // --- the browser's side -----------------------------------------------

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      // Typing marks the box as used, which holds off the reaper later.
      manager.touchThrottled(boxId);
      if (terminal) terminal.stream.write(data);
      else queued.push(Buffer.from(data));
      return;
    }
    const control = parseTerminalControl(data.toString('utf8'));
    if (!control) {
      slog.warn('dropping an unreadable terminal control frame');
      return;
    }
    cols = control.cols;
    rows = control.rows;
    if (!sized) {
      sized = true;
      resolveSize();
      return;
    }
    void terminal?.resize(cols, rows);
  });

  ws.on('close', () => close(1000, 'closed'));
  ws.on('error', (err: Error) => {
    slog.debug('terminal socket error', { error: err.message });
    close(CLOSE.unavailable, 'socket error');
  });

  // The browser answers pings itself, so a busy page cannot stall the reply.
  let missed = 0;
  ws.on('pong', () => {
    missed = 0;
  });
  const pings = setInterval(() => {
    if (missed >= MISSED_PINGS) {
      slog.info('dropping a terminal whose browser stopped answering');
      // Nobody is there to complete a closing handshake.
      ws.terminate();
      close(CLOSE.policy, 'gone');
      return;
    }
    missed++;
    ws.ping();
  }, PING_MS);
  pings.unref?.();
  ws.on('close', () => clearInterval(pings));

  // --- the box's side ---------------------------------------------------

  void (async () => {
    let target;
    try {
      target = await manager.execTarget(boxId);
    } catch (err) {
      slog.warn('could not reach the box for a terminal', { error: (err as Error).message });
      close(CLOSE.unavailable, (err as Error).message);
      return;
    }
    await knownSize;
    if (closed) return;

    try {
      terminal = await runtime().exec.openTerminalExec(
        target.containerId,
        target.workingDir,
        cols,
        rows,
      );
    } catch (err) {
      slog.warn('could not open a terminal', { error: (err as Error).message });
      close(CLOSE.unavailable, (err as Error).message);
      return;
    }
    // The socket closed while the pty was opening, before close() could end it.
    if (closed) {
      void terminal.close();
      return;
    }

    for (const chunk of queued) terminal.stream.write(chunk);
    queued.length = 0;
    slog.info('terminal attached');

    terminal.stream.on('data', (chunk: Buffer) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(chunk, { binary: true });
      if (ws.bufferedAmount <= MAX_BUFFERED_BYTES) return;
      // Pauses the pty until the browser has caught up.
      terminal?.stream.pause();
      const resume = (): void => {
        if (closed) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          setTimeout(resume, 50).unref?.();
          return;
        }
        terminal?.stream.resume();
      };
      setTimeout(resume, 50).unref?.();
    });

    void terminal.exited.then(() => {
      slog.info('terminal shell ended');
      close(1000, 'shell ended');
    });
  })();
}
