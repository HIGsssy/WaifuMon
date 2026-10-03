/**
 * Dungeon event definitions — deployed content in `content/dungeons/events.json`.
 *
 * The minimum the generator needs to place an `event` node: something to name,
 * show and switch off. An event has no choices or effects yet; those arrive
 * with playable runs, as new fields on this shape.
 *
 * Deliberately not a World Encounter. Those are spawned into a channel, expire
 * on a timer, carry cooldowns and per-guild history, and resolve through an
 * effect executor that pays players directly — none of which fits a node in a
 * run whose rewards are unbanked until extraction.
 *
 * Read by the content loader like the combat enemies (optional on disk).
 * Same envelope: `{ format, version, events: [...] }`, `.strict()`.
 *
 * Kept free of database imports so the content loader can validate the file.
 */
import { z } from 'zod';
import { relativeArtworkPath } from '../assets/artworkPath';
import { DUNGEON_KEY_MAX_LENGTH, DUNGEON_KEY_PATTERN } from './zoneDefinition';

/** Relative to the content directory. */
export const DUNGEON_EVENT_FILE = 'dungeons/events.json';
export const DUNGEON_EVENT_FILE_FORMAT = 'waifumon-dungeon-events' as const;
export const DUNGEON_EVENT_FILE_VERSION = 1 as const;

const key = z.string().max(DUNGEON_KEY_MAX_LENGTH).regex(DUNGEON_KEY_PATTERN, 'must be lower_snake_case');

export const DungeonEventDefinitionSchema = z
  .object({
    key,
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2000).default(''),
    enabled: z.boolean(),
    artworkPath: relativeArtworkPath.nullable().default(null),
    tags: z.array(key).max(20).default([]),
  })
  .strict();

export type DungeonEventDefinition = z.infer<typeof DungeonEventDefinitionSchema>;

export const DungeonEventFileSchema = z
  .object({
    format: z.literal(DUNGEON_EVENT_FILE_FORMAT),
    version: z.literal(DUNGEON_EVENT_FILE_VERSION),
    events: z.array(DungeonEventDefinitionSchema).max(5000),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Map<string, number>();
    file.events.forEach((event, i) => {
      const first = seen.get(event.key);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['events', i, 'key'],
          message: `duplicate event key "${event.key}" (also events[${first}])`,
        });
      } else seen.set(event.key, i);
    });
  });
