/**
 * The one error that carries an HTTP status.
 *
 * Every layer that can refuse a request throws this: the session lifecycle,
 * the review surface, the agent store.
 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
