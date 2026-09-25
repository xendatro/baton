import { z } from 'zod';
import { timestampSchema } from './common';

/**
 * Wire contracts of the teams module. The account module consumes the deleted-teams contract
 * below (account settings → Deleted teams); the teams module owns this file and its routes.
 */

/** A team the caller owns that is in Trash (restorable until `purgeAt`). */
export const deletedTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  icon: z.string().nullable(),
  color: z.string(),
  deletedAt: timestampSchema,
  purgeAt: timestampSchema,
});
export type DeletedTeam = z.infer<typeof deletedTeamSchema>;

/** `GET /api/me/deleted-teams`. */
export const deletedTeamsResponseSchema = z.object({ items: z.array(deletedTeamSchema) });
export type DeletedTeamsResponse = z.infer<typeof deletedTeamsResponseSchema>;
