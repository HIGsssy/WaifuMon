/**
 * Admin species save — the data-preservation contract.
 *
 * The bug this guards against was silent and total: the edit form posts a
 * whitelist of fields, the service parsed that body on its own, and the result
 * was a *valid* species with `appearances`, `race`, and `card` simply gone.
 * Validation passed. The write succeeded. The content was destroyed.
 *
 * Two properties have to hold together, and they pull in opposite directions —
 * which is why both are tested here rather than one being assumed:
 *
 *   1. fields the form does not own **survive** an edit, and
 *   2. fields the form does not own **cannot be set** by posting them anyway.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPECIES_FORM_FIELDS } from '../../src/modules/content/adminContentService';
import { speciesFormPage } from '../../src/admin/views/speciesPages';
import type { SpeciesContent } from '../../src/modules/content/schemas';
import { createAdminFixture, validSpeciesInput, type AdminFixture } from '../helpers/adminFixtures';

let f: AdminFixture;

beforeEach(() => {
  f = createAdminFixture();
});
afterEach(() => {
  f.cleanup();
});

const SLUG = 'test_admin_waifu';

/** Content-only fields: authored in JSON, invisible to the edit form. */
const APPEARANCES = [
  { id: 'standard', name: 'Standard', unlock: { type: 'owned' } },
  { id: 'level_20', name: 'Midnight Shift', unlock: { type: 'level', atLevel: 20 } },
];
const CARD = {
  subtitle: 'Authored Subtitle',
  ability: { name: 'Authored Ability', text: 'Authored ability text that no admin form can see.' },
};

/** Seeds a species carrying every content-only field the form is blind to. */
function seedRichSpecies(): SpeciesContent {
  f.service.createSpecies(
    validSpeciesInput({
      slug: SLUG,
      archetype: 'demon',
      race: 'demon',
      card: CARD,
      appearances: APPEARANCES,
    }),
  );
  const found = f.service.findSpecies(SLUG);
  expect(found, 'seeded species should exist').toBeDefined();
  return found!.species;
}

/**
 * Exactly what the browser posts: the form-owned fields of the current entry,
 * with an optional edit applied. Nothing else — that is the whole point.
 */
function formBodyFor(
  species: SpeciesContent,
  edits: Record<string, unknown> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of SPECIES_FORM_FIELDS) {
    body[field] = (species as unknown as Record<string, unknown>)[field];
  }
  return { ...body, ...edits };
}

function reload(slug = SLUG): SpeciesContent {
  const found = f.service.findSpecies(slug);
  expect(found, `species "${slug}" should exist after save`).toBeDefined();
  return found!.species;
}

describe('seeding', () => {
  it('creates a species carrying appearances, race, and card', () => {
    const seeded = seedRichSpecies();
    expect(seeded.race).toBe('demon');
    expect(seeded.card).toEqual(CARD);
    expect(seeded.appearances).toHaveLength(2);
  });
});

describe('an admin edit preserves content-only fields', () => {
  it('changes the form-owned field it was given', () => {
    const seeded = seedRichSpecies();
    f.service.updateSpecies(SLUG, formBodyFor(seeded, { name: 'Renamed By Admin' }));
    expect(reload().name).toBe('Renamed By Admin');
  });

  it('leaves appearances, race, and card exactly as authored', () => {
    const seeded = seedRichSpecies();
    f.service.updateSpecies(SLUG, formBodyFor(seeded, { name: 'Renamed By Admin' }));

    const after = reload();
    expect(after.race).toBe('demon');
    expect(after.card).toEqual(CARD);
    expect(after.appearances).toEqual(seeded.appearances);
  });

  it('survives repeated edits rather than decaying one save at a time', () => {
    const seeded = seedRichSpecies();
    let current = seeded;
    for (const name of ['First', 'Second', 'Third']) {
      f.service.updateSpecies(SLUG, formBodyFor(current, { name }));
      current = reload();
    }

    expect(current.name).toBe('Third');
    expect(current.race).toBe('demon');
    expect(current.card).toEqual(CARD);
    expect(current.appearances).toEqual(seeded.appearances);
  });

  it('writes the preserved fields through to the JSON on disk', () => {
    const seeded = seedRichSpecies();
    f.service.updateSpecies(SLUG, formBodyFor(seeded, { name: 'Renamed By Admin' }));

    const file = f.service.findSpecies(SLUG)!.file;
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(f.service.contentDir, 'species', file), 'utf8'),
    ) as Record<string, unknown>[];
    const entry = onDisk.find((s) => s.slug === SLUG);

    expect(entry).toMatchObject({ name: 'Renamed By Admin', race: 'demon', card: CARD });
    expect(entry?.appearances).toHaveLength(2);
  });

  it('preserves them through the enable/disable toggle too', () => {
    const seeded = seedRichSpecies();
    f.service.toggleSpeciesEnabled(SLUG);

    const after = reload();
    expect(after.enabled).toBe(false);
    expect(after.race).toBe('demon');
    expect(after.card).toEqual(CARD);
    expect(after.appearances).toEqual(seeded.appearances);
  });
});

describe('an admin edit cannot reach fields the form does not own', () => {
  it('ignores a posted race rather than applying it', () => {
    const seeded = seedRichSpecies();
    f.service.updateSpecies(SLUG, formBodyFor(seeded, { race: 'angel' }));
    expect(reload().race).toBe('demon');
  });

  it('ignores posted card metadata', () => {
    const seeded = seedRichSpecies();
    f.service.updateSpecies(SLUG, formBodyFor(seeded, { card: { subtitle: 'Injected' } }));
    expect(reload().card).toEqual(CARD);
  });

  it('ignores a posted attempt to blank the appearance catalog', () => {
    const seeded = seedRichSpecies();
    f.service.updateSpecies(SLUG, formBodyFor(seeded, { appearances: [] }));
    expect(reload().appearances).toEqual(seeded.appearances);
  });

  it('drops unknown keys entirely instead of writing them to content', () => {
    const seeded = seedRichSpecies();
    f.service.updateSpecies(SLUG, formBodyFor(seeded, { somethingInvented: 'nope', __proto__: {} }));

    const after = reload() as unknown as Record<string, unknown>;
    expect(after['somethingInvented']).toBeUndefined();
    expect(Object.keys(after)).not.toContain('somethingInvented');
  });

  it('still rejects an invalid value for a field the form does own', () => {
    const seeded = seedRichSpecies();
    expect(() => f.service.updateSpecies(SLUG, formBodyFor(seeded, { rarity: 'MYTHIC' }))).toThrow();
    // The rejected write must not have partially landed.
    expect(reload().rarity).toBe(seeded.rarity);
  });

  it('rejects a non-object body', () => {
    seedRichSpecies();
    for (const body of [null, 'nope', 42, undefined]) {
      expect(() => f.service.updateSpecies(SLUG, body)).toThrow();
    }
  });
});

describe('SPECIES_FORM_FIELDS tracks the rendered form', () => {
  /**
   * The whitelist and the form have to agree: a field listed here but missing
   * from the form becomes deletable by omission, and a field on the form but
   * missing here silently stops saving. Neither failure is visible by reading
   * one file, so the drift is asserted rather than trusted to a comment.
   */
  it('matches every data-field the species edit form renders', () => {
    const species = seedRichSpecies();
    const html = speciesFormPage(species, { speciesFiles: ['starter.json'], defaultFile: 'custom.json' });

    const rendered = new Set(
      [...html.matchAll(/data-field="([^"]+)"/g)]
        .map((m) => m[1]!)
        // `__file` is a create-form control, not a species field.
        .filter((name) => !name.startsWith('__')),
    );

    expect([...rendered].sort()).toEqual([...SPECIES_FORM_FIELDS].sort());
  });

  it('never lists a content-only field', () => {
    for (const field of ['appearances', 'race', 'card']) {
      expect(SPECIES_FORM_FIELDS as readonly string[]).not.toContain(field);
    }
  });
});
