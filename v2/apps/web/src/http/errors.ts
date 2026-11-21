export class HttpError extends Error {
  override readonly name = 'HttpError';
  readonly statusCode: number;
  readonly userMessage: string;

  constructor(statusCode: number, userMessage: string) {
    super(userMessage);
    this.statusCode = statusCode;
    this.userMessage = userMessage;
  }
}

export function unauthorized(message = 'Sign in required'): HttpError {
  return new HttpError(401, message);
}

export function forbidden(message = 'You do not have access to that'): HttpError {
  return new HttpError(403, message);
}

export function notFound(message = 'Not found'): HttpError {
  return new HttpError(404, message);
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}
