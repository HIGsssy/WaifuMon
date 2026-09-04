/**
 * Admin panel routes. Every path below sits behind the auth hook registered in
 * `auth.ts` — including the asset-preview route, which is the only file reader
 * exposed and is confined to `ASSETS_DIR`.
 *
 * GET routes render HTML; POST routes take and return JSON so the page script
 * can show validation errors inline without a full round-trip.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  AdminValidationError,
  DEFAULT_NEW_SPECIES_FILE,
  resolveWithinRoot,
  type AdminContentService,
} from '../modules/content/adminContentService';
import { QuestPoolEntrySchema, type QuestPoolEntry } from '../modules/content/schemas';
import { dashboardPage, loginPage } from './views/pages';
import { itemFormPage, itemListPage } from './views/itemPages';
import { questFormPage, questListPage } from './views/questPages';
import {
  filterAndSortSpecies,
  speciesFormPage,
  speciesListPage,
  type SpeciesListFilters,
} from './views/speciesPages';
import { tablesPage } from './views/tablePages';
import {
  encounterFormPage,
  encounterListPage,
  encounterPreviewPage,
  filterEncounters,
  type EncounterListFilters,
  type PreviewChoiceRender,
} from './views/encounterPages';
import {
  AdminEncounterValidationError,
  type WorldEncounterAdminService,
} from '../modules/worldEncounters/adminService';
import { computeChance } from '../modules/worldEncounters/checkResolver';
import type {
  BuddyProfile,
  EncounterCheckContext,
  LoadedEncounter,
} from '../modules/worldEncounters/types';

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

interface ErrorBody {
  ok: false;
  message: string;
  errors: string[];
}

function toErrorBody(err: unknown): ErrorBody {
  if (err instanceof AdminValidationError) {
    return { ok: false, message: 'Validation failed — nothing was written.', errors: err.issues };
  }
  if (err instanceof AdminEncounterValidationError) {
    return { ok: false, message: 'Validation failed — nothing was written.', errors: err.issues };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, message: 'Request failed — nothing was written.', errors: [message] };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Cheap per-render probe so a read-only mount is visible before the first save. */
function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function registerRoutes(
  app: FastifyInstance,
  content: AdminContentService,
  worldEncounters?: WorldEncounterAdminService | undefined,
): void {
  const html = (reply: import('fastify').FastifyReply, body: string): unknown =>
    reply.type('text/html; charset=utf-8').send(body);

  app.get('/', async (_req, reply) => reply.redirect('/admin', 302));

  app.get('/admin/login', async (req, reply) => {
    const next = str((req.query as Record<string, unknown>)?.next) || '/admin';
    return html(reply, loginPage(next.startsWith('/admin') ? next : '/admin'));
  });

  // ── dashboard ──────────────────────────────────────────────────────────────

  app.get('/admin', async (_req, reply) => {
    const report = content.validateContent();
    const summary = report.summary ?? {
      speciesTotal: 0,
      speciesEnabled: 0,
      speciesDisabled: 0,
      byRarity: [],
      byAffinity: [],
      itemsTotal: 0,
      itemsEnabled: 0,
      questsTotal: 0,
      questsEnabled: false,
      speciesFiles: [],
      highlights: [],
    };
    return html(
      reply,
      dashboardPage(summary, report, content.reloadAvailable(), isWritable(content.contentDir)),
    );
  });

  app.post('/admin/validate-content', async (_req, reply) => {
    const report = content.validateContent();
    return reply.send({
      ok: report.ok,
      message: report.ok
        ? `Content valid — ${report.summary?.speciesTotal ?? 0} species (${report.summary?.speciesEnabled ?? 0} enabled), ${report.summary?.itemsTotal ?? 0} items, ${report.summary?.questsTotal ?? 0} quests.`
        : 'Content validation failed.',
      errors: report.errors,
      warnings: report.warnings,
      summary: report.summary,
      checkedAt: report.checkedAt,
    });
  });

  app.post('/admin/reload-content', async (req, reply) => {
    const report = content.validateContent();
    if (!report.ok) {
      return reply.code(400).send({
        ok: false,
        message: 'Refusing to reload — content is currently invalid.',
        errors: report.errors,
      });
    }
    try {
      const result = await content.reloadContent();
      return reply.send({
        ok: true,
        message: `Reload complete — ${result.summary.species} species and ${result.summary.items} items seeded (${result.summary.disabledSpecies} species, ${result.summary.disabledItems} items disabled as missing from JSON).`,
        summary: result.summary,
        warnings: report.warnings,
        notes: [
          'tables.json tuning (rates, quests, care mode, session) is read at bot startup — restart the bot to apply those.',
        ],
      });
    } catch (err) {
      req.log.error({ err }, 'admin reload-content failed');
      return reply.code(500).send({
        ...toErrorBody(err),
        message:
          'Files were saved, but the reload into Postgres failed. The JSON on disk is valid — fix the database issue and press Reload again, or restart the bot.',
      });
    }
  });

  // ── species ────────────────────────────────────────────────────────────────

  app.get('/admin/species', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const filters: SpeciesListFilters = {
      q: str(q.q),
      rarity: str(q.rarity),
      affinity: str(q.affinity),
      enabled: str(q.enabled),
      sort: str(q.sort) || 'rarity',
    };
    const raw = content.readRaw();
    const rows = raw.speciesFiles.flatMap((g) => g.species.map((s) => ({ species: s, file: g.file })));
    return html(reply, speciesListPage(filterAndSortSpecies(rows, filters), filters));
  });

  app.get('/admin/species/new', async (_req, reply) =>
    html(
      reply,
      speciesFormPage(null, {
        speciesFiles: content.listSpeciesFileNames(),
        defaultFile: DEFAULT_NEW_SPECIES_FILE,
      }),
    ),
  );

  app.get<{ Params: { slug: string } }>('/admin/species/:slug', async (req, reply) => {
    const found = content.findSpecies(req.params.slug);
    if (!found) return reply.code(404).type('text/html').send('<h1>404 — species not found</h1>');
    return html(
      reply,
      speciesFormPage(found.species, {
        file: found.file,
        speciesFiles: content.listSpeciesFileNames(),
        defaultFile: DEFAULT_NEW_SPECIES_FILE,
      }),
    );
  });

  app.post('/admin/species', async (req, reply) => {
    const body = { ...((req.body ?? {}) as Record<string, unknown>) };
    const file = str(body.__file) || DEFAULT_NEW_SPECIES_FILE;
    delete body.__file;
    try {
      const result = content.createSpecies(body, file);
      return reply.send({
        ok: true,
        message: `Created — written to ${result.file} (backup: ${result.backup ?? 'none, new file'}).`,
        redirect: `/admin/species/${encodeURIComponent(str(body.slug))}`,
      });
    } catch (err) {
      return reply.code(400).send(toErrorBody(err));
    }
  });

  app.post<{ Params: { slug: string } }>('/admin/species/:slug', async (req, reply) => {
    try {
      const result = content.updateSpecies(req.params.slug, req.body);
      const nextSlug = str((req.body as Record<string, unknown>)?.slug);
      return reply.send({
        ok: true,
        message: `Saved to ${result.file} (backup: ${result.backup ?? 'none'}).`,
        ...(nextSlug && nextSlug !== req.params.slug
          ? { redirect: `/admin/species/${encodeURIComponent(nextSlug)}` }
          : {}),
      });
    } catch (err) {
      return reply.code(400).send(toErrorBody(err));
    }
  });

  app.post<{ Params: { slug: string } }>(
    '/admin/species/:slug/toggle-enabled',
    async (req, reply) => {
      try {
        const { result, enabled } = content.toggleSpeciesEnabled(req.params.slug);
        return reply.send({
          ok: true,
          message: `${req.params.slug} is now ${enabled ? 'enabled' : 'disabled'} in ${result.file} (backup: ${result.backup ?? 'none'}). Reload content to apply.`,
        });
      } catch (err) {
        return reply.code(400).send(toErrorBody(err));
      }
    },
  );

  // ── items ──────────────────────────────────────────────────────────────────

  /**
   * Form-shape fixups only — never validation. The item form always renders a
   * per-effect-type config block, so a blank `effectType` select arrives as
   * `''` and must become `null`, and an item with no effect must carry no
   * config at all. Everything else (including "capture fields on a
   * restore_energy_full item") is left for the schema to reject, so a
   * hand-crafted POST gets the same errors the form would.
   */
  function normalizeItemBody(input: unknown): Record<string, unknown> {
    const body = { ...((input ?? {}) as Record<string, unknown>) };
    if (body.effectType === '' || body.effectType == null) body.effectType = null;
    if (body.effectType == null) body.effectConfig = null;
    return body;
  }

  app.get('/admin/items', async (_req, reply) => {
    const raw = content.readRaw();
    const rows = raw.items.map((item) => ({
      item,
      references: content.findItemReferences(item.slug),
    }));
    return html(reply, itemListPage(rows));
  });

  app.get('/admin/items/new', async (_req, reply) => html(reply, itemFormPage(null, [])));

  app.get<{ Params: { slug: string } }>('/admin/items/:slug', async (req, reply) => {
    const item = content.findItem(req.params.slug);
    if (!item) return reply.code(404).type('text/html').send('<h1>404 — item not found</h1>');
    return html(reply, itemFormPage(item, content.findItemReferences(item.slug)));
  });

  app.post('/admin/items', async (req, reply) => {
    try {
      const result = content.createItem(normalizeItemBody(req.body));
      return reply.send({
        ok: true,
        message: `Created (backup: ${result.backup ?? 'none'}).`,
        redirect: `/admin/items/${encodeURIComponent(str((req.body as Record<string, unknown>)?.slug))}`,
      });
    } catch (err) {
      return reply.code(400).send(toErrorBody(err));
    }
  });

  app.post<{ Params: { slug: string } }>('/admin/items/:slug', async (req, reply) => {
    try {
      const result = content.updateItem(req.params.slug, normalizeItemBody(req.body));
      const nextSlug = str((req.body as Record<string, unknown>)?.slug);
      return reply.send({
        ok: true,
        message: `Saved (backup: ${result.backup ?? 'none'}).`,
        ...(nextSlug && nextSlug !== req.params.slug
          ? { redirect: `/admin/items/${encodeURIComponent(nextSlug)}` }
          : {}),
      });
    } catch (err) {
      return reply.code(400).send(toErrorBody(err));
    }
  });

  app.post<{ Params: { slug: string } }>('/admin/items/:slug/toggle-enabled', async (req, reply) => {
    try {
      const { result, enabled } = content.toggleItemEnabled(req.params.slug);
      return reply.send({
        ok: true,
        message: `${req.params.slug} is now ${enabled ? 'enabled' : 'disabled'} (backup: ${result.backup ?? 'none'}). Reload content to apply.`,
      });
    } catch (err) {
      return reply.code(400).send(toErrorBody(err));
    }
  });

  // ── tables ─────────────────────────────────────────────────────────────────

  app.get('/admin/tables', async (_req, reply) => html(reply, tablesPage(content.readRaw())));

  app.post('/admin/tables', async (req, reply) => {
    const body = (req.body ?? {}) as { section?: unknown; value?: unknown };
    try {
      const result =
        typeof body.section === 'string'
          ? content.saveTablesSection(body.section, body.value)
          : content.saveTables(body.value ?? body);
      return reply.send({
        ok: true,
        message: `Saved ${result.file} (backup: ${result.backup ?? 'none'}).`,
        warnings: content.validateContent().warnings,
        notes: ['Restart the bot to apply tables.json tuning to a running session.'],
      });
    } catch (err) {
      return reply.code(400).send(toErrorBody(err));
    }
  });

  // ── quests ─────────────────────────────────────────────────────────────────

  function parseQuest(input: unknown): QuestPoolEntry {
    const body = { ...((input ?? {}) as Record<string, unknown>) };
    // The form always submits the rarity select; blank means "not applicable".
    if (body.rarityAtLeast === '' || body.rarityAtLeast == null) delete body.rarityAtLeast;
    const parsed = QuestPoolEntrySchema.safeParse(body);
    if (!parsed.success) {
      throw new AdminValidationError(
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      );
    }
    return parsed.data;
  }

  function saveQuestPool(pool: QuestPoolEntry[]): string {
    const current = content.readRaw().tables.dailyQuests;
    const result = content.saveTablesSection('dailyQuests', { ...current, pool });
    return result.backup ?? 'none';
  }

  app.get('/admin/quests', async (_req, reply) =>
    html(reply, questListPage(content.readRaw().tables.dailyQuests)),
  );

  app.get('/admin/quests/new', async (_req, reply) => html(reply, questFormPage(null)));

  app.get<{ Params: { slug: string } }>('/admin/quests/:slug', async (req, reply) => {
    const quest = content.readRaw().tables.dailyQuests.pool.find((q) => q.slug === req.params.slug);
    if (!quest) return reply.code(404).type('text/html').send('<h1>404 — quest not found</h1>');
    return html(reply, questFormPage(quest));
  });

  app.post('/admin/quests', async (req, reply) => {
    try {
      const quest = parseQuest(req.body);
      const pool = content.readRaw().tables.dailyQuests.pool;
      if (pool.some((q) => q.slug === quest.slug)) {
        throw new AdminValidationError([`slug: "${quest.slug}" already exists in the pool`]);
      }
      const backup = saveQuestPool([...pool, quest]);
      return reply.send({
        ok: true,
        message: `Quest created (backup: ${backup}).`,
        redirect: `/admin/quests/${encodeURIComponent(quest.slug)}`,
      });
    } catch (err) {
      return reply.code(400).send(toErrorBody(err));
    }
  });

  app.post<{ Params: { slug: string } }>('/admin/quests/:slug', async (req, reply) => {
    try {
      const quest = parseQuest(req.body);
      const pool = content.readRaw().tables.dailyQuests.pool;
      if (!pool.some((q) => q.slug === req.params.slug)) {
        throw new AdminValidationError([`slug: "${req.params.slug}" is not in the pool`]);
      }
      if (quest.slug !== req.params.slug && pool.some((q) => q.slug === quest.slug)) {
        throw new AdminValidationError([`slug: "${quest.slug}" already exists in the pool`]);
      }
      const backup = saveQuestPool(pool.map((q) => (q.slug === req.params.slug ? quest : q)));
      return reply.send({
        ok: true,
        message: `Quest saved (backup: ${backup}).`,
        ...(quest.slug !== req.params.slug
          ? { redirect: `/admin/quests/${encodeURIComponent(quest.slug)}` }
          : {}),
      });
    } catch (err) {
      return reply.code(400).send(toErrorBody(err));
    }
  });

  app.post<{ Params: { slug: string } }>('/admin/quests/:slug/remove', async (req, reply) => {
    try {
      const pool = content.readRaw().tables.dailyQuests.pool;
      if (!pool.some((q) => q.slug === req.params.slug)) {
        throw new AdminValidationError([`slug: "${req.params.slug}" is not in the pool`]);
      }
      const backup = saveQuestPool(pool.filter((q) => q.slug !== req.params.slug));
      return reply.send({
        ok: true,
        message: `Removed ${req.params.slug} from the pool (backup: ${backup}).`,
        redirect: '/admin/quests',
      });
    } catch (err) {
      return reply.code(400).send(toErrorBody(err));
    }
  });

  // ── authenticated asset preview ────────────────────────────────────────────

  app.get<{ Params: { '*': string } }>('/admin/assets/*', async (req, reply) => {
    const relative = decodeURIComponent(req.params['*'] ?? '');
    const resolved = resolveWithinRoot(content.assetsDir, relative);
    if (!resolved) {
      req.log.warn({ relative }, 'admin asset request rejected: path escapes assets root');
      return reply.code(400).send({ ok: false, errors: ['Invalid asset path'] });
    }
    const ext = path.extname(resolved).toLowerCase();
    const type = IMAGE_TYPES[ext];
    if (!type) return reply.code(415).send({ ok: false, errors: ['Unsupported asset type'] });
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return reply.code(404).send({ ok: false, errors: ['Asset not found'] });
    }
    return reply
      .type(type)
      .header('cache-control', 'private, max-age=60')
      .send(fs.createReadStream(resolved));
  });

  // ── world encounters ───────────────────────────────────────────────────────

  const encountersDisabledResponse = (reply: import('fastify').FastifyReply): unknown =>
    html(
      reply,
      encounterListPage(
        [],
        { q: '', region: '', source: '', type: '', rarity: '', lifecycle: '' },
      ),
    );

  function parseEncounterFilters(query: unknown): EncounterListFilters {
    const q = (query ?? {}) as Record<string, unknown>;
    return {
      q: str(q.q),
      region: str(q.region),
      source: str(q.source),
      type: str(q.type),
      rarity: str(q.rarity),
      lifecycle: str(q.lifecycle),
    };
  }

  app.get('/admin/encounters', async (req, reply) => {
    if (!worldEncounters) return encountersDisabledResponse(reply);
    const filters = parseEncounterFilters(req.query);
    const all = await worldEncounters.list();
    return html(reply, encounterListPage(filterEncounters(all, filters), filters));
  });

  app.get('/admin/encounters/new', async (_req, reply) => {
    if (!worldEncounters) return reply.code(404).send({ ok: false, errors: ['Feature disabled'] });
    const itemSlugs = content.readRaw().items.map((i) => i.slug);
    return html(reply, encounterFormPage(null, itemSlugs));
  });

  app.get<{ Params: { id: string } }>('/admin/encounters/:id', async (req, reply) => {
    if (!worldEncounters) return reply.code(404).send({ ok: false, errors: ['Feature disabled'] });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false, errors: ['Bad id'] });
    const encounter = await worldEncounters.get(id);
    if (!encounter) return reply.code(404).send({ ok: false, errors: ['Not found'] });
    const itemSlugs = content.readRaw().items.map((i) => i.slug);
    return html(reply, encounterFormPage(encounter, itemSlugs));
  });

  app.post<{ Body: { input?: unknown } }>('/admin/encounters/save', async (req, reply) => {
    if (!worldEncounters) return reply.code(404).send({ ok: false, errors: ['Feature disabled'] });
    try {
      const result = await worldEncounters.upsert(
        (req.body?.input ?? req.body ?? {}) as Parameters<typeof worldEncounters.upsert>[0],
      );
      return reply.send({
        ok: true,
        message: `Saved "${result.name}".`,
        redirect: `/admin/encounters/${result.id}`,
      });
    } catch (err) {
      req.log.warn({ err }, 'encounter save failed');
      return reply.code(400).send(toErrorBody(err));
    }
  });

  app.post<{ Params: { id: string } }>('/admin/encounters/:id/toggle-enabled', async (req, reply) => {
    if (!worldEncounters) return reply.code(404).send({ ok: false, errors: ['Feature disabled'] });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false, errors: ['Bad id'] });
    const encounter = await worldEncounters.get(id);
    if (!encounter) return reply.code(404).send({ ok: false, errors: ['Not found'] });
    const next = encounter.lifecycle === 'active' ? 'disabled' : 'active';
    await worldEncounters.setLifecycle(id, next);
    return reply.send({ ok: true, message: `Encounter ${next}.` });
  });

  app.post<{ Params: { id: string } }>('/admin/encounters/:id/clone', async (req, reply) => {
    if (!worldEncounters) return reply.code(404).send({ ok: false, errors: ['Feature disabled'] });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false, errors: ['Bad id'] });
    const encounter = await worldEncounters.get(id);
    if (!encounter) return reply.code(404).send({ ok: false, errors: ['Not found'] });
    // Cheap, unique-ish suffix so clones do not collide on their own next round.
    const newSlug = `${encounter.slug}_copy_${Math.floor(Date.now() / 1000) % 100000}`;
    try {
      const cloned = await worldEncounters.clone(id, newSlug);
      return reply.send({ ok: true, redirect: `/admin/encounters/${cloned.id}` });
    } catch (err) {
      return reply.code(400).send(toErrorBody(err));
    }
  });

  app.post<{ Params: { id: string } }>('/admin/encounters/:id/delete', async (req, reply) => {
    if (!worldEncounters) return reply.code(404).send({ ok: false, errors: ['Feature disabled'] });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return reply.code(400).send({ ok: false, errors: ['Bad id'] });
    const result = await worldEncounters.remove(id);
    if (!result.ok) {
      return reply.code(409).send({ ok: false, message: result.reason, errors: [result.reason ?? ''] });
    }
    return reply.send({ ok: true, message: 'Deleted.', redirect: '/admin/encounters' });
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/admin/encounters/:id/preview',
    async (req, reply) => {
      if (!worldEncounters) return reply.code(404).send({ ok: false, errors: ['Feature disabled'] });
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ ok: false, errors: ['Bad id'] });
      const encounter = await worldEncounters.get(id);
      if (!encounter) return reply.code(404).send({ ok: false, errors: ['Not found'] });

      const q = req.query ?? {};
      const playerLevel = Number(q.playerLevel) > 0 ? Number(q.playerLevel) : 20;
      const withBuddy = q.withBuddy === '1' || 'buddyLevel' in q;
      let buddy: BuddyProfile | null = null;
      let buddyLine: { level: number; affinity: string; race: string; currentSp: number } | null = null;
      if (withBuddy) {
        const level = Number(q.buddyLevel) > 0 ? Number(q.buddyLevel) : 10;
        const currentSp = Number(q.buddySp) > 0 ? Number(q.buddySp) : 60;
        const affinity = str(q.buddyAffinity) || 'switch';
        const race = str(q.buddyRace) || 'human';
        buddy = {
          waifuId: 0,
          speciesSlug: 'test',
          speciesName: 'Test Buddy',
          level,
          affinity,
          baseSp: currentSp,
          currentSp,
          rarity: 'R',
          raceTags: [race],
        };
        buddyLine = { level, affinity, race, currentSp };
      }

      const ctx: EncounterCheckContext = {
        playerId: 0,
        playerLevel,
        buddy,
        buddyBonusPercent: 0,
      };
      const choiceRenders: PreviewChoiceRender[] = encounter.choices.map((c) => {
        const preview = computeChance(c.check, ctx);
        // Availability: reuse the service's rules would require pulling the
        // service in here. The preview is authoring-facing, so we inline the
        // subset (affinity + race + player level + buddy level).
        let available = true;
        let reason: string | null = null;
        const r = c.requirements;
        if (r.affinity && (!buddy || buddy.affinity !== r.affinity)) {
          available = false;
          reason = `requires ${r.affinity} affinity`;
        } else if (r.raceAny && r.raceAny.length > 0) {
          const has = buddy && r.raceAny.some((t) => buddy!.raceTags.includes(t));
          if (!has) {
            available = false;
            reason = `requires ${r.raceAny.join('/')}`;
          }
        } else if (r.minPlayerLevel && playerLevel < r.minPlayerLevel) {
          available = false;
          reason = `requires player level ${r.minPlayerLevel}`;
        } else if (r.minBuddyLevel && (!buddy || buddy.level < r.minBuddyLevel)) {
          available = false;
          reason = `requires buddy level ${r.minBuddyLevel}`;
        }
        return {
          choiceId: c.id,
          label: c.label,
          emoji: c.emoji,
          available,
          unavailableReason: reason,
          chance: preview.chance,
          breakdown: preview.breakdown,
        };
      });

      return html(
        reply,
        encounterPreviewPage(encounter, { playerLevel, buddy: buddyLine }, choiceRenders),
      );
    },
  );
}
