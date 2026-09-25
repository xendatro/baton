import type { z } from 'zod';
import { apiErrorSchema, type ErrorCode } from '@shared/schemas/common';

/**
 * Typed client for the Baton REST API (docs/API.md). Every request sends the session cookie, speaks
 * JSON and turns the error envelope `{ error: { code, message, details } }` into an `ApiError`.
 *
 * Auth errors are routed centrally: `401` → `/login?next=…`, `403 email_not_verified` →
 * `/verify-email`, `403 username_required` → `/onboarding/username?next=…`. The app wires the
 * navigation (client-side, via the router) with `configureApi` at startup.
 */

/** Codes of the server envelope plus `network_error` for requests that never got a response. */
export type ApiErrorCode = ErrorCode | 'network_error';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  /** HTTP status; 0 for network failures. */
  readonly status: number;
  readonly details: unknown;

  constructor(code: ApiErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** Field messages of a `validation_failed` error, keyed by dotted path. */
  get fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {};
    if (this.code !== 'validation_failed' || !isRecord(this.details)) return result;
    const issues = this.details.issues;
    if (!Array.isArray(issues)) return result;
    for (const issue of issues as unknown[]) {
      if (!isRecord(issue) || typeof issue.message !== 'string') continue;
      const path = Array.isArray(issue.path)
        ? issue.path.join('.')
        : typeof issue.path === 'string'
          ? issue.path
          : '';
      result[path] ??= issue.message;
    }
    return result;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Errors that `configureApi`'s router handles by navigating away (no toast needed). */
export function isAuthRoutingError(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.status === 401 ||
      error.code === 'email_not_verified' ||
      error.code === 'username_required')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ---------------------------------------------------------------------------------------------
// Auth-error routing
// ---------------------------------------------------------------------------------------------

/** Pages that render without a signed-in, onboarded user; never redirect away from them. */
const AUTH_PATHS = [
  '/login',
  '/signup',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
  '/onboarding/username',
];

export function isAuthPath(pathname: string): boolean {
  return AUTH_PATHS.includes(pathname);
}

export interface ApiConfig {
  /** Client-side navigation (the router's `navigate`). Defaults to a full page load. */
  navigate: (to: string) => void;
  /** Called on any 401, before navigating (e.g. to clear the cached session). */
  onUnauthorized: () => void;
}

const config: ApiConfig = {
  navigate: (to) => window.location.assign(to),
  onUnauthorized: () => undefined,
};

export function configureApi(options: Partial<ApiConfig>): void {
  Object.assign(config, options);
}

function currentPath(): string {
  const { pathname, search, hash } = window.location;
  return `${pathname}${search}${hash}`;
}

/** `/login?next=/current/path` (omits `next` for the dashboard). */
export function loginPath(next: string = currentPath()): string {
  return next === '/' || next === '' ? '/login' : `/login?next=${encodeURIComponent(next)}`;
}

/**
 * Sends the user where an auth error says they must go. Returns true when it navigated.
 * Exported for the auth guards, which reuse the same routing.
 */
export function routeAuthError(error: ApiError): boolean {
  if (error.status === 401) config.onUnauthorized();
  const pathname = window.location.pathname;
  if (isAuthPath(pathname)) return false;
  const next = encodeURIComponent(currentPath());
  if (error.status === 401) {
    config.navigate(loginPath());
    return true;
  }
  if (error.code === 'email_not_verified') {
    config.navigate(`/verify-email?next=${next}`);
    return true;
  }
  if (error.code === 'username_required') {
    config.navigate(`/onboarding/username?next=${next}`);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export type QueryValue = string | number | boolean | null | undefined | readonly string[];
export type QueryParams = Readonly<Record<string, QueryValue>>;

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** JSON body (any serialisable value) or FormData. */
  body?: unknown;
  query?: QueryParams;
  /** Zod schema the response must satisfy; the parsed value is returned. */
  schema?: z.ZodType<T>;
  signal?: AbortSignal;
  /** Route 401 / email_not_verified / username_required errors (default true). */
  routeAuthErrors?: boolean;
}

/** Serialises query params: arrays become comma-separated, empty values are dropped. */
export function buildUrl(path: string, query?: QueryParams): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(','));
    } else {
      params.set(key, String(value));
    }
  }
  const search = params.toString();
  return search ? `${path}${path.includes('?') ? '&' : '?'}${search}` : path;
}

/** Builds an `ApiError` from a non-2xx response body (JSON envelope or anything else). */
export function errorFromResponse(status: number, body: unknown): ApiError {
  const parsed = apiErrorSchema.safeParse(body);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiError(code, status, message, details);
  }
  const code: ErrorCode =
    status === 401
      ? 'unauthorized'
      : status === 403
        ? 'forbidden'
        : status === 404
          ? 'not_found'
          : status === 413
            ? 'payload_too_large'
            : status === 429
              ? 'rate_limited'
              : 'internal';
  const message =
    status === 413
      ? 'The file is too large.'
      : status === 429
        ? 'Too many requests. Try again in a moment.'
        : status >= 500
          ? `The server had a problem (${status}). Try again.`
          : `Request failed (${status}).`;
  return new ApiError(code, status, message);
}

function parseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function validate<T>(schema: z.ZodType<T> | undefined, data: unknown): T {
  if (!schema) return data as T;
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiError(
      'internal',
      200,
      'The server sent an unexpected response. Reload the page and try again.',
      result.error.issues,
    );
  }
  return result.data;
}

export async function apiRequest<T = unknown>(
  path: string,
  options: RequestOptions<T> = {},
): Promise<T> {
  const { method = 'GET', body, query, schema, signal, routeAuthErrors = true } = options;
  const headers: Record<string, string> = { Accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: payload,
      credentials: 'include',
      signal,
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new ApiError('network_error', 0, 'Could not reach Baton. Check your connection.');
  }

  const data = parseJson(await response.text());
  if (!response.ok) {
    const error = errorFromResponse(response.status, data);
    if (routeAuthErrors) routeAuthError(error);
    throw error;
  }
  return validate(schema, data);
}

type Options<T> = Omit<RequestOptions<T>, 'method' | 'body'>;

export const api = {
  get: <T = unknown>(path: string, options?: Options<T>) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),
  post: <T = unknown>(path: string, body?: unknown, options?: Options<T>) =>
    apiRequest<T>(path, { ...options, method: 'POST', body }),
  patch: <T = unknown>(path: string, body?: unknown, options?: Options<T>) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', body }),
  put: <T = unknown>(path: string, body?: unknown, options?: Options<T>) =>
    apiRequest<T>(path, { ...options, method: 'PUT', body }),
  delete: <T = unknown>(path: string, options?: Options<T>) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
};

// ---------------------------------------------------------------------------------------------
// Uploads (XHR, for progress events)
// ---------------------------------------------------------------------------------------------

export interface UploadOptions<T> {
  /** Extra multipart fields sent before the file. */
  fields?: Readonly<Record<string, string | undefined>>;
  /** Multipart field name of the file (default `file`). */
  fileField?: string;
  schema?: z.ZodType<T>;
  /** 0–1. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** POSTs a file as multipart/form-data, reporting upload progress. */
export function uploadFile<T = unknown>(
  path: string,
  file: Blob & { name?: string },
  options: UploadOptions<T> = {},
): Promise<T> {
  const { fields = {}, fileField = 'file', schema, onProgress, signal } = options;
  return new Promise<T>((resolve, reject) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) form.append(key, value);
    }
    form.append(fileField, file, file.name ?? 'file');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    });
    xhr.addEventListener('load', () => {
      const data = parseJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        try {
          resolve(validate(schema, data));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      const error = errorFromResponse(xhr.status, data);
      routeAuthError(error);
      reject(error);
    });
    xhr.addEventListener('error', () =>
      reject(new ApiError('network_error', 0, 'Upload failed. Check your connection.')),
    );
    xhr.addEventListener('abort', () =>
      reject(new DOMException('The upload was cancelled.', 'AbortError')),
    );
    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('The upload was cancelled.', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(form);
  });
}

/** Human message for any error thrown by the client (or anything else). */
export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
