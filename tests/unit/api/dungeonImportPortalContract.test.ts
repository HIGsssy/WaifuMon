import { expectTypeOf, it } from 'vitest';
import type { DungeonImportPlan, DungeonImportDecisions, DungeonImportResult } from '../../../src/modules/dungeons/package/dungeonImportService';
import type { DungeonImportPlan as PortalPlan, DungeonImportDecisions as PortalDecisions, DungeonImportResult as PortalResult } from '../../../portal/src/api/dungeonImportTypes';
it('keeps frontend-local import wire DTOs compatible with the backend', () => {
  expectTypeOf<DungeonImportPlan>().toMatchTypeOf<PortalPlan>();
  expectTypeOf<PortalPlan>().toMatchTypeOf<DungeonImportPlan>();
  expectTypeOf<DungeonImportDecisions>().toMatchTypeOf<PortalDecisions>();
  expectTypeOf<PortalDecisions>().toMatchTypeOf<DungeonImportDecisions>();
  expectTypeOf<DungeonImportResult>().toMatchTypeOf<PortalResult>();
  expectTypeOf<PortalResult>().toMatchTypeOf<DungeonImportResult>();
});
