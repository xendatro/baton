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
| `GET /api/me/api-keys`                | –                                                                                                                                                      | `{ apiKeys: ApiKey[] }`                                                                                                                                                                                                               | core                          |
| `POST /api/me/api-keys`               | `CreateApiKeyInput` `{ name, expiresInDays? }`                                                                                                         | `{ key, apiKey }` (the plaintext `key` is returned only this once)                                                                                                                                                                    | core                          |
| `DELETE /api/me/api-keys/:id`         | –                                                                                                                                                      | `{ ok: true }` (revokes)                                                                                                                                                                                                              | core                          |
| `GET /api/notifications`              | `?cursor&limit&unread=1`                                                                                                                               | `{ items: Notification[], nextCursor }`                                                                                                                                                                                               | core                          |
| `GET /api/notifications/unread-count` | –                                                                                                                                                      | `{ count }`                                                                                                                                                                                                                           | core                          |
| `POST /api/notifications/read`        | `{ ids } \| { all: true }`                                                                                                                             | `{ updated }`                                                                                                                                                                                                                         | core                          |
| `POST /api/attachments`               | multipart: `file` + `UploadAttachmentFields` `{ teamId, parentType = 'pending', parentId? }`                                                           | `Attachment`                                                                                                                                                                                                                          | core                          |
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

## Feature endpoints

Each module documents its own routes here as it lands, in the same table format. One router file
per area lives in `server/routes/<area>.ts`, and each is mounted from `server/routes/index.ts`.
