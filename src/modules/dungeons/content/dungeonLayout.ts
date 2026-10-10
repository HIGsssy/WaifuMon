/**
 * The editor's layout of a dungeon: where each room is drawn, the viewport and
 * free-standing notes. Stored and exported beside the definition and never
 * read by the runtime, a validator or a content hash — so dragging a room is
 * not a gameplay change and never looks like one in an import diff.
 *
 * A room with no entry here is simply unpositioned; the editor places it.
 */
import { z } from 'zod';
import { DUNGEON_ID_MAX_LENGTH, DUNGEON_ID_PATTERN } from './dungeonDefinition';

const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const point = z.object({ x: coordinate, y: coordinate }).strict();

export const DungeonLayoutSchema = z
  .object({
    viewport: z
      .object({ x: coordinate, y: coordinate, zoom: z.number().finite().min(0.01).max(100) })
      .strict()
      .optional(),
    rooms: z.record(z.string().max(DUNGEON_ID_MAX_LENGTH).regex(DUNGEON_ID_PATTERN), point).default({}),
    notes: z
      .array(
        z
          .object({
            id: z.string().max(DUNGEON_ID_MAX_LENGTH).regex(DUNGEON_ID_PATTERN),
            x: coordinate,
            y: coordinate,
            text: z.string().max(2000),
          })
          .strict(),
      )
      .max(500)
      .default([]),
  })
  .strict();

export type DungeonLayout = z.infer<typeof DungeonLayoutSchema>;

export const EMPTY_DUNGEON_LAYOUT: DungeonLayout = Object.freeze({ rooms: {}, notes: [] });

/** Positions of rooms that no longer exist are dropped; everything else is kept. */
export function pruneDungeonLayout(layout: DungeonLayout, roomIds: readonly string[]): DungeonLayout {
  const known = new Set(roomIds);
  return {
    ...layout,
    rooms: Object.fromEntries(Object.entries(layout.rooms).filter(([roomId]) => known.has(roomId))),
  };
}
