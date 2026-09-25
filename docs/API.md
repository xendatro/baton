# Baton REST API

The REST API lives under `/api`, speaks JSON, and is what the web app uses. Scripts can use it too,
with `Authorization: Bearer bat_…`. The zod schemas in `shared/schemas/*.ts` define every request
and response below. If this file and a schema disagree, the schema is right; fix this file.

## Conventions

- **Auth**: the web app uses the Better Auth session cookie; scripts send `Authorization: Bearer bat_…`.
  Requests that change data and use a cookie must send an `Origin` (or `Referer`) that matches
  `BASE_URL`. Accounts with an unverified email or no username get `403 email_not_verified` /
  `403 username_required` from every endpoint except `/api/auth/*`, `GET /api/me` and `GET /api/config`.
- **Errors**: every response that isn't 2xx looks like `{ "error": { "code", "message", "details"? } }`
  (`apiErrorSchema`). Codes: `unauthorized` 401, `forbidden` 403, `not_found` 404,
  `validation_failed` 400 (`details.issues: [{ path, message }]`), `conflict` 409,
  `rate_limited` 429, `payload_too_large` 413, `email_not_verified` 403, `username_required` 403,
  `internal` 500. If a resource belongs to a team the caller isn't a member of, the API returns
  `404`, never `403`.
- **Ids** are ULIDs. **Timestamps** are ISO 8601 strings (`…At`). **Due dates** are `YYYY-MM-DD`.
- **Pagination**: `?cursor&limit` (limit 1–100, default 50) → `{ items, nextCursor }`. `nextCursor`
  is null on the last page. Treat cursors as opaque.
- **Deletes** return `{ ok: true }` (`okResponseSchema`).
- **Live updates**: after a change commits, the server sends a hint on `GET /api/events` (see below).
- **Rate limits** (token buckets, `429 rate_limited` with `Retry-After`): `POST /api/auth/*` 10/min per
  IP (Better Auth adds stricter per-path limits: 3 sign-in/sign-up attempts per 10 s, one code email per
  60 s); REST writes 120/min per user; uploads 30/min per user; MCP 300/min per key.
- **API keys** can call every REST endpoint except `/api/me/api-keys` (web session only).

## Shared types (`shared/schemas/core.ts`)

| Type            | Shape                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `UserSummary`   | `{ id, username, name, image }`                                                                                                |
| `ViaKey`        | `{ keyId, keyName }`                                                                                                           |
| `ActorRef`      | `{ user: UserSummary \| null, via: ViaKey \| null, source: 'web'\|'mcp'\|'api'\|'system' }`                                    |
| `RoleSummary`   | `{ id, slug, name, color }`                                                                                                    |
| `Attachment`    | `{ id, teamId, parentType, parentId, filename, mimeType, size, isImage, url, uploader, via, createdAt }`                       |
| `Reply`         | `{ id, teamId, projectId, parentType, parentId, body, author, via, attachments, createdAt, updatedAt, editedAt }`              |
| `Notification`  | `{ id, teamId, type, entityType, entityId, actor, viaKeyName, title, snippet, url, readAt, createdAt }`                        |
| `ActivityEntry` | `{ id, teamId, projectId, actor: ActorRef, entityType, entityId, action, changes: {field: {from, to}}, meta, url, createdAt }` |
| `SearchResult`  | `{ entityType: 'task'\|'issue'\|'reply', entityId, teamId, projectId, ref, title, snippet, url }`                              |

## Core endpoints

Module owners are listed in SPEC §3. A route and the service behind it can have different owners:
search and the audit log use core services, but their routes belong to admin.

| Method & path                         | Request                                                                                                                                                | Response                                                                                                                                                                                                                              | Owner                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `GET /healthz`                        | –                                                                                                                                                      | `{ ok: true, version }` (503 `{ ok: false }` if the DB is unreachable)                                                                                                                                                                | foundation                    |
| `GET /api/config`                     | –                                                                                                                                                      | `ConfigResponse` `{ version, signupsEnabled, providers: { google, github }, maxUploadMb }`                                                                                                                                            | foundation                    |
| `* /api/auth/*`                       | Better Auth (email+password, emailOTP, username, Google/GitHub, account linking)                                                                       | Better Auth                                                                                                                                                                                                                           | core                          |
| `GET /api/me`                         | –                                                                                                                                                      | `MeResponse` `{ user: { id, email, emailVerified, username, displayUsername, name, image, theme }, teams: [{ id, slug, name, icon, color, isOwner, permissions, projects: [{ id, key, name, icon, color }] }], unreadNotifications }` | core                          |
| `GET /api/me/security-log`            | `?cursor&limit`                                                                                                                                        | `{ items: ActivityEntry[], nextCursor }` newest first: the caller's account-level rows (sign-ins, sign-ups, password changes and resets, API keys created/revoked, accounts linked/unlinked)                                          | core                          |
| `GET /api/me/api-keys`                | –                                                                                                                                                      | `{ apiKeys: ApiKey[] }`                                                                                                                                                                                                               | core                          |
| `POST /api/me/api-keys`               | `CreateApiKeyInput` `{ name, expiresInDays? }`                                                                                                         | `{ key, apiKey }` (the plaintext `key` is returned only this once)                                                                                                                                                                    | core                          |
| `DELETE /api/me/api-keys/:id`         | –                                                                                                                                                      | `{ ok: true }` (revokes)                                                                                                                                                                                                              | core                          |
| `GET /api/notifications`              | `?cursor&limit&unread=1`                                                                                                                               | `{ items: Notification[], nextCursor }`                                                                                                                                                                                               | core                          |
| `GET /api/notifications/unread-count` | –                                                                                                                                                      | `{ count }`                                                                                                                                                                                                                           | core                          |
| `POST /api/notifications/read`        | `{ ids } \| { all: true }`                                                                                                                             | `{ updated }`                                                                                                                                                                                                                         | core                          |
| `POST /api/attachments`               | multipart: `file` + `UploadAttachmentFields` `{ teamId, parentType = 'pending', parentId? }`                                                           | `Attachment`                                                                                                                                                                                                                          | core                          |
| `GET /api/attachments`                | `?parentType=issue\|task\|reply\|project&parentId`                                                                                                     | `{ items: Attachment[] }` oldest first (`AttachmentListResponse`)                                                                                                                                                                     | core                          |
| `GET /api/attachments/:id/:filename`  | –                                                                                                                                                      | file bytes; images inline, everything else (and always SVG) `Content-Disposition: attachment`                                                                                                                                         | core                          |
| `DELETE /api/attachments/:id`         | –                                                                                                                                                      | `{ ok: true }` (to Trash)                                                                                                                                                                                                             | core                          |
| `GET /api/replies`                    | `?parentType=issue\|task&parentId`                                                                                                                     | `{ items: Reply[] }` oldest first                                                                                                                                                                                                     | core                          |
| `POST /api/replies`                   | `{ parentType, parentId, body, attachmentIds? }`                                                                                                       | `Reply`                                                                                                                                                                                                                               | core                          |
| `PATCH /api/replies/:id`              | `{ body }`                                                                                                                                             | `Reply`                                                                                                                                                                                                                               | core                          |
| `DELETE /api/replies/:id`             | –                                                                                                                                                      | `{ ok: true }` (to Trash)                                                                                                                                                                                                             | core                          |
| `GET /api/activity`                   | `?entityType&entityId`                                                                                                                                 | `{ items: ActivityEntry[] }` oldest first                                                                                                                                                                                             | core                          |
| `GET /api/teams/:teamId/audit-log`    | `?cursor&limit&actorId&keyId&source&entityType&action&projectId&from&to` (`action` exact, or a prefix ending in `.`; `from` inclusive, `to` exclusive) | `{ items: ActivityEntry[], nextCursor }` newest first; needs `VIEW_AUDIT_LOG`                                                                                                                                                         | admin (route), core (service) |
| `GET /api/teams/:teamId/mentionables` | `?q`                                                                                                                                                   | `{ users: UserSummary[], roles: RoleSummary[] }` (only roles the caller may mention)                                                                                                                                                  | core                          |
| `GET /api/search`                     | `?q&teamId&projectId&types=task,issue,reply&limit` (limit ≤ 50, default 20)                                                                            | `{ results: SearchResult[] }`                                                                                                                                                                                                         | admin (route), core (service) |
| `GET /api/subscriptions`              | `?entityType=issue\|task&entityId`                                                                                                                     | `{ subscribed }`                                                                                                                                                                                                                      | core                          |
| `POST /api/subscriptions`             | `{ entityType, entityId, subscribed }`                                                                                                                 | `{ subscribed }`                                                                                                                                                                                                                      | core                          |
| `GET /api/events`                     | – (SSE)                                                                                                                                                | stream of `LiveEvent`                                                                                                                                                                                                                 | core                          |

`ApiKey` = `{ id, name, prefix, lastUsedAt, expiresAt, revokedAt, createdAt }`.

### Uploads and downloads

- `POST /api/attachments` takes `multipart/form-data` with the file in `file`. Files above
  `MAX_UPLOAD_MB` or beyond the team's `TEAM_STORAGE_QUOTA_MB` get `413 payload_too_large`. The stored
  type is sniffed from the content; the filename is sanitized. Without a parent the upload is
  `pending`: only the uploader can see it, and it must be claimed within 24 h by passing its id in
  `attachmentIds` (replies) or the feature's equivalent, or it is purged. Uploading straight to a
  parent needs edit rights on it (author / `EDIT_ANY_CONTENT`; tasks also `UPDATE_TASKS`; projects
  `MANAGE_PROJECTS`). `parentType: 'user_avatar'` is rejected here (account settings handle avatars).
- `GET /api/attachments/:id/:filename`: only PNG, JPEG, GIF and WebP whose bytes match are served
  `inline`; everything else, SVG and HTML included, is `attachment`. `Cache-Control: private,
max-age=31536000, immutable`, an `ETag` (`If-None-Match` → 304) and `X-Content-Type-Options: nosniff`.

### `GET /api/events` (Server-Sent Events)

- Each message is a default (`message`) event whose `data` is one JSON `LiveEvent` (`shared/events.ts`):
  `{ type, teamId, projectId?, entityType, entityId, parentType?, parentId?, actorId, userId?, at }`.
- The stream carries events for every team the user belongs to, plus their personal events
  (`notification.created`, `me.updated`, delivered only to `userId`).
- The server sends a `: ping` comment every 25 s and a `retry: 3000` hint.
- Events only say what changed. They carry no data: clients refetch (`web/lib/live.ts` maps each
  type to the TanStack Query keys it invalidates).
- `parentType`/`parentId` name the parent item for `reply.*` and `attachment.changed`, and the
  entity the row is about for `activity.created`.

### Auth (`/api/auth/*`, Better Auth)

The web app talks to Better Auth directly (its client or plain `fetch`). Endpoints in use:

| Endpoint                                                                                                               | Body                                                     | Notes                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/auth/sign-up/email`                                                                                         | `{ email, password, name, username }`                    | `username` is required (3–32 `[a-z0-9_]`, any case, stored lowercase, reserved names refused). Emails a 6-digit code; no session until verified. |
| `POST /api/auth/email-otp/verify-email`                                                                                | `{ email, otp }`                                         | Verifies and signs in (sets the session cookie). 10-minute codes, 5 attempts.                                                                    |
| `POST /api/auth/email-otp/send-verification-otp`                                                                       | `{ email, type: 'email-verification' }`                  | Resend; one per 60 s.                                                                                                                            |
| `POST /api/auth/sign-in/email` / `sign-in/username`                                                                    | `{ email \| username, password }`                        | `403` while the email is unverified.                                                                                                             |
| `POST /api/auth/sign-in/social`                                                                                        | `{ provider: 'google' \| 'github', callbackURL }`        | Only providers enabled in `/api/config`. OAuth sign-ups arrive verified, without a username (→ `/onboarding/username`).                          |
| `POST /api/auth/email-otp/request-password-reset`                                                                      | `{ email }`                                              | Emails a reset code (one per 60 s).                                                                                                              |
| `POST /api/auth/email-otp/reset-password`                                                                              | `{ email, otp, password }`                               | Signs out every session.                                                                                                                         |
| `POST /api/auth/change-password`                                                                                       | `{ currentPassword, newPassword, revokeOtherSessions? }` |                                                                                                                                                  |
| `POST /api/auth/update-user`                                                                                           | `{ name?, image?, username? }`                           | Username onboarding/changes (same rules as sign-up).                                                                                             |
| `POST /api/auth/link-social`, `POST /api/auth/unlink-account`, `GET /api/auth/list-accounts`                           |                                                          | Connect/disconnect Google and GitHub (linking by a signed-in user may use a different email).                                                    |
| `GET /api/auth/get-session`, `POST /api/auth/sign-out`, `GET /api/auth/list-sessions`, `POST /api/auth/revoke-session` |                                                          | Sessions: 30 days, extended daily while used. Cookies are `baton.*` (`__Secure-baton.*` in production), `HttpOnly`, `SameSite=Lax`.              |

Disabled: `sign-in/email-otp` (codes never sign anyone in), email change, and `delete-user` (account
deletion goes through the account module). Security-log rows are written for sign-ups, sign-ins,
password changes/resets/sets and account links/unlinks.

### MCP (`/mcp`)

Streamable HTTP, stateless: `POST /mcp` with `Authorization: Bearer bat_…` (401 +
`WWW-Authenticate: Bearer` otherwise). `GET` and `DELETE` answer `405` (no sessions). Every write is
attributed to the key's owner with `source: 'mcp'` and the key name. Core tools: `whoami`, `search`,
`list_notifications`, `mark_notifications_read`, `list_replies`, `add_reply`, `edit_reply`,
`delete_reply`, `upload_attachment`, `list_attachments`, `get_attachment`, `delete_attachment`,
`get_activity`, `subscribe`, `unsubscribe`.

## Feature endpoints

Each module documents its own routes here as it lands, in the same table format. One router file
per area lives in `server/routes/<area>.ts`, and each is mounted from `server/routes/index.ts`.
