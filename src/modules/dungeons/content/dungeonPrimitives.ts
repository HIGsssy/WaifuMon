/**
 * The small shared vocabulary of a dungeon definition: artwork references,
 * flags, conditions and routing destinations. Kept apart from
 * `dungeonDefinition.ts` so the event schemas (`dungeonEvents.ts`) can use
 * them without importing the definition that contains events.
 * `dungeonDefinition.ts` re-exports everything here.
 */
import { z } from 'zod';
import { DungeonIdSchema as id } from './dungeonIdentifiers';

export const DUNGEON_MAX_CONDITION_DEPTH = 6;

export const BASIS_POINTS = 10_000;

export const referenceKey = z.string().trim().min(1).max(100);
export const basisPoints = z.number().int().min(0).max(BASIS_POINTS);
export const shortText = (max: number) => z.string().trim().max(max);

// ── artwork ─────────────────────────────────────────────────────────────────

/**
 * A picture, named in a way that survives a move between environments: a file
 * shipped under `assets/`, or a managed upload by the sha256 of its bytes.
 * Never a managed asset's id, which is minted per environment.
 */
export const DungeonArtworkRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('shipped'),
      path: z
        .string()
        .trim()
        .min(1)
        .max(300)
        .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'must be a relative path under assets/'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('managed'),
      category: z.string().trim().min(1).max(40),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/, 'must be a lower-case sha256 hex digest'),
      /** The file name it was uploaded under. Informational. */
      name: shortText(200).optional(),
    })
    .strict(),
]);
export type DungeonArtworkRef = z.infer<typeof DungeonArtworkRefSchema>;

// ── flags and conditions ────────────────────────────────────────────────────

/**
 * Where a flag lives. `run` flags die with the run. `player` flags persist per
 * player and dungeon; they are declared here so content can be written against
 * them, but nothing sets one until the phase that adds their store.
 *
 * Both are namespaced by the dungeon. A future campaign namespace would be a
 * third scope value, not a change to these two.
 */
export const DUNGEON_FLAG_SCOPES = ['run', 'player'] as const;
export type DungeonFlagScope = (typeof DUNGEON_FLAG_SCOPES)[number];

export const DungeonFlagDeclarationSchema = z
  .object({
    key: id,
    scope: z.enum(DUNGEON_FLAG_SCOPES).default('run'),
    description: shortText(300).default(''),
  })
  .strict();
export type DungeonFlagDeclaration = z.infer<typeof DungeonFlagDeclarationSchema>;

export type DungeonCondition =
  | { type: 'flag'; flag: string; scope: DungeonFlagScope; equals: boolean }
  | { type: 'room_completed'; roomId: string }
  | { type: 'all'; conditions: DungeonCondition[] }
  | { type: 'any'; conditions: DungeonCondition[] }
  | { type: 'not'; condition: DungeonCondition };

type DungeonConditionInput =
  | { type: 'flag'; flag: string; scope?: DungeonFlagScope | undefined; equals?: boolean | undefined }
  | { type: 'room_completed'; roomId: string }
  | { type: 'all'; conditions: DungeonConditionInput[] }
  | { type: 'any'; conditions: DungeonConditionInput[] }
  | { type: 'not'; condition: DungeonConditionInput };

/**
 * What a `when` or `requires` tests. A small closed vocabulary: Phase 3
 * replaces it with the shared rules module's condition union, of which every
 * member here is one.
 */
export const DungeonConditionSchema: z.ZodType<DungeonCondition, z.ZodTypeDef, DungeonConditionInput> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('flag'),
        flag: id,
        scope: z.enum(DUNGEON_FLAG_SCOPES).default('run'),
        equals: z.boolean().default(true),
      })
      .strict(),
    z.object({ type: z.literal('room_completed'), roomId: id }).strict(),
    z.object({ type: z.literal('all'), conditions: z.array(DungeonConditionSchema).min(1).max(20) }).strict(),
    z.object({ type: z.literal('any'), conditions: z.array(DungeonConditionSchema).min(1).max(20) }).strict(),
    z.object({ type: z.literal('not'), condition: DungeonConditionSchema }).strict(),
  ]),
);

// ── routing ─────────────────────────────────────────────────────────────────

/**
 * Where a room's sequence goes after an action.
 *
 *   next           the action after this one; the room completes after the last
 *   action         a named action later in this room (never earlier)
 *   room_complete  the room completes now, whatever follows
 *   leave          the room completes and the player goes through a connection
 *   retreat        the room is left *unfinished* and the player goes back to
 *                  the room they came from; its sequence resumes on return
 *   end_run        the run ends here
 */
export const ActionDestinationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('next') }).strict(),
  z.object({ type: z.literal('action'), actionId: id }).strict(),
  z.object({ type: z.literal('room_complete') }).strict(),
  z.object({ type: z.literal('leave'), connectionId: id }).strict(),
  z.object({ type: z.literal('retreat') }).strict(),
  z.object({ type: z.literal('end_run'), outcome: z.enum(['completed', 'defeated']) }).strict(),
]);
export type ActionDestination = z.infer<typeof ActionDestinationSchema>;
