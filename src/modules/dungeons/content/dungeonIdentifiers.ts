import { z } from 'zod';

export const DUNGEON_KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
export const DUNGEON_KEY_MAX_LENGTH = 64;
/** Stable authoring IDs, short enough for a Discord custom id. */
export const DUNGEON_ID_PATTERN = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
export const DUNGEON_ID_MAX_LENGTH = 40;

export const DungeonKeySchema = z
  .string()
  .max(DUNGEON_KEY_MAX_LENGTH)
  .regex(DUNGEON_KEY_PATTERN, 'must be lower_snake_case');
export const DungeonIdSchema = z
  .string()
  .max(DUNGEON_ID_MAX_LENGTH)
  .regex(DUNGEON_ID_PATTERN, 'must be lower-case letters, digits, "_" or "-"');
