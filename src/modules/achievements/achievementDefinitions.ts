/**
 * Achievement definition loading and validation.
 *
 * Definitions are content, authored in `content/achievements.json` and
 * validated on load exactly like every other content file (§2: content-driven,
 * not hard-coded checks). The loader is deliberately self-contained rather than
 * folded into the big species/items content pipeline: Phase-1 achievements are
 * static badges with no admin editing, so they need validation and a stable
 * in-memory list, not the reload/seed machinery.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ContentValidationError } from '../../shared/errors';
import {
  ACHIEVEMENT_CATEGORIES,
  ACHIEVEMENT_METRICS,
  type AchievementDefinition,
} from './achievementRules';

const criteriaSchema = z.object({
  metric: z.enum(ACHIEVEMENT_METRICS),
  target: z.number().int().min(1),
});

const definitionSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_]+$/, 'achievement id must be lower snake_case'),
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.enum(ACHIEVEMENT_CATEGORIES),
  hidden: z.boolean().default(false),
  series: z.string().min(1).nullable().default(null),
  tier: z.number().int().min(1).nullable().default(null),
  icon: z.string().min(1).nullable().default(null),
  criteria: criteriaSchema,
});

const fileSchema = z.object({
  achievements: z.array(definitionSchema).min(1),
});

/** Parse and validate a raw achievements document. Throws on any problem. */
export function parseAchievementDefinitions(raw: unknown): AchievementDefinition[] {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ContentValidationError(`Invalid achievements content:\n${details}`);
  }

  const seen = new Set<string>();
  for (const def of parsed.data.achievements) {
    if (seen.has(def.id)) {
      throw new ContentValidationError(`Duplicate achievement id: ${def.id}`);
    }
    seen.add(def.id);
  }
  return parsed.data.achievements;
}

/** Load `content/achievements.json` from a content directory. */
export function loadAchievementDefinitions(contentDir: string): AchievementDefinition[] {
  const filePath = path.join(contentDir, 'achievements.json');
  if (!fs.existsSync(filePath)) {
    throw new ContentValidationError(`Content file missing: ${filePath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new ContentValidationError(
      `Invalid JSON in ${filePath}: ${(err as Error).message}`,
    );
  }
  return parseAchievementDefinitions(raw);
}
