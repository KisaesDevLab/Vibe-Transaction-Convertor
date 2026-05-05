export type ErrorCode =
  | 'VALIDATION'
  | 'AUTH'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMIT'
  | 'INTERNAL';

export class AppError extends Error {
  override readonly name: string;
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(opts: {
    name?: string;
    status: number;
    code: ErrorCode;
    message: string;
    details?: unknown;
    cause?: unknown;
  }) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = opts.name ?? 'AppError';
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.name,
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ name: 'ValidationError', status: 400, code: 'VALIDATION', message, details });
  }
}

export class AuthError extends AppError {
  constructor(message = 'Authentication required') {
    super({ name: 'AuthError', status: 401, code: 'AUTH', message });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super({ name: 'ForbiddenError', status: 403, code: 'FORBIDDEN', message });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super({ name: 'NotFoundError', status: 404, code: 'NOT_FOUND', message });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ name: 'ConflictError', status: 409, code: 'CONFLICT', message, details });
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests') {
    super({ name: 'RateLimitError', status: 429, code: 'RATE_LIMIT', message });
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal server error', cause?: unknown) {
    super({ name: 'InternalError', status: 500, code: 'INTERNAL', message, cause });
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
