import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { PendingApprovalResponse } from '@shared/schemas/agentActions';
import type { ApiError, ErrorCode } from '@shared/schemas/common';

export type { ErrorCode };

/** Default HTTP status for each error code. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, ContentfulStatusCode>> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
  rate_limited: 429,
  payload_too_large: 413,
  email_not_verified: 403,
  username_required: 403,
  agents_paused: 423,
  internal: 500,
};

/**
 * An expected failure with a stable code. Services throw these; the REST error handler turns them
 * into `{ error: { code, message, details } }` and MCP tools into `isError` results.
 * `message` is shown to users and agents, so keep it human and free of internals.
 */
export class AppError extends Error {
  override name = 'AppError';

  constructor(
    readonly code: ErrorCode,
    readonly status: ContentfulStatusCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  toJSON(): ApiError {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

function make(code: ErrorCode, message: string, details?: unknown): AppError {
  return new AppError(code, ERROR_STATUS[code], message, details);
}

/** Shorthands with the default status for each code. */
export const errors = {
  unauthorized: (message = 'Sign in to continue') => make('unauthorized', message),
  forbidden: (message = "You don't have permission to do that", details?: unknown) =>
    make('forbidden', message, details),
  /** Also used for resources in teams the caller doesn't belong to (never leak existence). */
  notFound: (what = 'Resource') => make('not_found', `${what} not found`),
  /** `not_found` with a specific message (e.g. naming the ref and the valid values). */
  notFoundWith: (message: string, details?: unknown) => make('not_found', message, details),
  validation: (message: string, details?: unknown) => make('validation_failed', message, details),
  conflict: (message: string, details?: unknown) => make('conflict', message, details),
  rateLimited: (message = 'Too many requests, slow down') => make('rate_limited', message),
  payloadTooLarge: (message = 'Payload too large') => make('payload_too_large', message),
  emailNotVerified: () => make('email_not_verified', 'Verify your email address first'),
  usernameRequired: () => make('username_required', 'Choose a username first'),
  /** An agent member's write while it, its team or its project is paused. */
  agentsPaused: (message: string) => make('agents_paused', message),
  internal: (message = 'Something went wrong') => make('internal', message),
} as const;

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Not a failure: an agent member's destructive action now waits for its owner's sign-off
 * (design §6). Thrown by `requireSignoff` once the request is stored, so every caller (REST route,
 * MCP tool, trash handler) stops alike; the REST error handler answers `202` with `body` and MCP
 * tools return `body` as a normal result.
 */
export class PendingApproval extends Error {
  override name = 'PendingApproval';

  constructor(readonly body: PendingApprovalResponse) {
    super(body.message);
  }
}

export function isPendingApproval(error: unknown): error is PendingApproval {
  return error instanceof PendingApproval;
}
