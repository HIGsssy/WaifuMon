#!/usr/bin/env python3
import json
from pathlib import Path
from copy import deepcopy

ROOT = Path('/home/whistler/Projects/WaifuMon')
REVIEW_PATH = ROOT / '.hermes/reports/buddy_bonus_review.json'
STARTER_PATH = ROOT / 'content/species/starter.json'
BACKUP_PATH = ROOT / '.hermes/backups/starter.before_buddy_bonus.json'
FINAL_MAP_PATH = ROOT / '.hermes/reports/buddy_bonus_final_mapping.json'
AUDIT_PATH = ROOT / '.hermes/reports/buddy_bonus_apply_audit.json'
BONUS_PATH = ROOT / 'content/bonus.json'

# Engine-aware middle-ground values, rarity-keyed for every effect.
# (Rounded-award floors honored: buddy_xp >=25, affection/care >=50 so
# applyPercentModifierInt never rounds the bonus away.)
RARITY_VALUES = {
    'capture_chance': {'N': 8, 'R': 10, 'SR': 12, 'SSR': 15, 'UR': 18, 'LR': 20},
    'encounter_weight': {'N': 10, 'R': 12, 'SR': 15, 'SSR': 18, 'UR': 20, 'LR': 25},
    'hunt_item_find_chance': {'N': 10, 'R': 12, 'SR': 15, 'SSR': 18, 'UR': 20, 'LR': 25},
    'player_xp_gain': {'N': 10, 'R': 12, 'SR': 15, 'SSR': 18, 'UR': 20, 'LR': 25},
    'buddy_xp_gain': {'N': 25, 'R': 30, 'SR': 40, 'SSR': 50, 'UR': 60, 'LR': 75},
    'energy_save_chance': {'N': 5, 'R': 6, 'SR': 8, 'SSR': 10, 'UR': 12, 'LR': 15},
    'care_energy_gain': {'N': 50, 'R': 50, 'SR': 50, 'SSR': 75, 'UR': 75, 'LR': 100},
    'essence_gain': {'N': 25, 'R': 30, 'SR': 40, 'SSR': 50, 'UR': 60, 'LR': 75},
    'affection_gain': {'N': 50, 'R': 50, 'SR': 50, 'SSR': 75, 'UR': 75, 'LR': 100},
    'boss_reward_gain': {'N': 25, 'R': 30, 'SR': 40, 'SSR': 50, 'UR': 60, 'LR': 75},
}

# User-approved target retargets. 'any' means the bonus carries no target.
TARGET_OVERRIDES = {
    'cyber_lilith_prime': {'target_type': 'any', 'target_value': None},
}

# User-approved cleanup for spreadsheet typos / malformed parentheses.
BONUS_NAME_OVERRIDES = {
    'cafe_maid': 'Second Cup',
    'moonlit_dancer': 'Night Floor',
    'neon_kitsune_apprentice': 'First Trick',
    'royal_succubus': 'Royal Privilege',
    'leopard_bodyguard': 'Escort Duty',
}

def human_target(target):
    target_type = target['type']
    value = target.get('value')
    if target_type == 'any':
        return 'any Waifumon'
    if target_type == 'race':
        return f'{value} Waifumon'
    if target_type == 'affinity':
        return f'{value} affinity Waifumon'
    if target_type == 'rarity':
        return f'{value} Waifumon'
    if target_type == 'rarity_min':
        return f'{value}+ Waifumon'
    if target_type == 'rarity_max':
        return f'{value} and below Waifumon'
    if target_type == 'ownership':
        return 'unowned species' if value == 'unowned' else 'owned species'
    if target_type == 'hunt':
        return 'Hunting'
    if target_type == 'care':
        return 'Care mode'
    if target_type == 'boss_encounter':
        return 'Boss Encounters'
    return value or target_type


def bonus_description(name, bonus_id, value, target):
    pct = f'{value}%'
    where = human_target(target)
    if bonus_id == 'capture_chance':
        text = f'+{pct} capture chance against {where}.'
    elif bonus_id == 'encounter_weight':
        text = f'+{pct} encounter weight for {where}.'
    elif bonus_id == 'energy_save_chance':
        text = f'{pct} chance Hunting does not consume Energy.'
    elif bonus_id == 'care_energy_gain':
        text = f'+{pct} Energy gained in Care mode.'
    elif bonus_id == 'player_xp_gain':
        text = f'+{pct} Player XP gained.'
    elif bonus_id == 'buddy_xp_gain':
        text = f'+{pct} XP gained by the active Buddy.'
    elif bonus_id == 'essence_gain':
        text = f'+{pct} Essence gained.'
    elif bonus_id == 'hunt_item_find_chance':
        text = f'+{pct} chance to find items from Hunting.'
    elif bonus_id == 'affection_gain':
        text = f'+{pct} Affection gained.'
    elif bonus_id == 'boss_reward_gain':
        text = f'+{pct} eligible rewards from Boss Encounters.'
    else:
        text = f'+{pct} {bonus_id} for {where}.'
    return f'{name}: {text}'


bonus_defs = json.loads(BONUS_PATH.read_text(encoding='utf-8'))
review = json.loads(REVIEW_PATH.read_text(encoding='utf-8'))
starter = json.loads(STARTER_PATH.read_text(encoding='utf-8'))
slug_to_species = {s['slug']: s for s in starter}

errors = []
final = []
assignments_by_slug = {}

for a in review['assignments']:
    if a.get('species_file') != 'content/species/starter.json':
        continue
    slug = a.get('matched_slug')
    if not slug or slug not in slug_to_species:
        errors.append(f"Assignment row {a.get('source_row')} does not map to starter species: {a.get('sheet_entry')}")
        continue
    if slug in assignments_by_slug:
        errors.append(f"Duplicate assignment for {slug}")
    assignments_by_slug[slug] = a

for slug, species in slug_to_species.items():
    if slug not in assignments_by_slug:
        errors.append(f"Starter species missing buddy bonus assignment: {slug} / {species.get('name')}")
        continue
    a = assignments_by_slug[slug]
    if slug in TARGET_OVERRIDES:
        ov = TARGET_OVERRIDES[slug]
        a = {**a, 'target_type': ov['target_type'], 'target_value': ov['target_value']}
    bonus_id = a['effect_id']
    rarity = species.get('rarity')
    if bonus_id not in RARITY_VALUES:
        errors.append(f"Unknown bonus id {bonus_id!r} for {slug}")
        continue
    if rarity not in RARITY_VALUES[bonus_id]:
        errors.append(f"No value configured for rarity {rarity!r} on {slug} / {bonus_id}")
        continue
    value = RARITY_VALUES[bonus_id][rarity]

    definition = bonus_defs['buddyBonusEffects'].get(bonus_id)
    if not definition:
        errors.append(f"bonusId not found in bonus.json: {bonus_id}")
        continue
    # Effects whose registry rule allows no target (energy_save, care, boss,
    # item-find, xp, essence, affection) never carry one: the sheet's
    # hunt/care/boss_encounter placeholders only documented where the effect
    # applies, and the effectId is the address.
    if not (definition.get('allowedTargetTypes') or []):
        a = {**a, 'target_type': 'any', 'target_value': None}
    target_type = a['target_type']
    target_value = a.get('target_value')
    allowed_types = definition.get('allowedTargetTypes') or []
    if target_type == 'any':
        if allowed_types and not definition.get('targetOptional'):
            errors.append(f"Effect requires a target: {slug} / {bonus_id}")
            continue
    else:
        if not allowed_types:
            errors.append(f"Effect does not allow a target: {slug} / {bonus_id}")
            continue
        if target_type not in allowed_types:
            errors.append(f"Invalid target type for {slug}: {bonus_id} does not allow {target_type}")
            continue
        if target_type in ('race', 'affinity', 'rarity', 'ownership'):
            allowed = bonus_defs['targetValues'][target_type]
            if target_value not in allowed:
                errors.append(f"Invalid target value for {slug}: {target_type}={target_value!r} not in bonus.json")
                continue
        if target_type in ('rarity_min', 'rarity_max'):
            allowed = bonus_defs['targetValues']['rarity']
            if target_value not in allowed:
                errors.append(f"Invalid target value for {slug}: {target_type}={target_value!r} not in bonus.json rarity values")
                continue

    target = {'type': target_type}
    if target_value is not None:
        target['value'] = target_value
    bonus_name = BONUS_NAME_OVERRIDES.get(slug, a['buddy_bonus_name'])
    buddy_bonus = {
        'name': bonus_name,
        'flavorText': bonus_description(bonus_name, bonus_id, value, target),
        'effectId': bonus_id,
        'value': value,
    }
    if target_type in {'race', 'affinity', 'rarity', 'rarity_min', 'rarity_max', 'ownership'}:
        buddy_bonus['target'] = target
    final.append({
        'slug': slug,
        'name': species.get('name'),
        'rarity': rarity,
        'buddyBonus': buddy_bonus,
        'sourceRow': a['source_row'],
    })

if errors:
    AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    AUDIT_PATH.write_text(json.dumps({'applied': False, 'errors': errors}, indent=2, ensure_ascii=False), encoding='utf-8')
    raise SystemExit('\n'.join(errors))

# Preserve a backup before writing.
BACKUP_PATH.parent.mkdir(parents=True, exist_ok=True)
if not BACKUP_PATH.exists():
    BACKUP_PATH.write_text(STARTER_PATH.read_text(encoding='utf-8'), encoding='utf-8')

for item in final:
    slug_to_species[item['slug']]['buddyBonus'] = item['buddyBonus']

STARTER_PATH.write_text(json.dumps(starter, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
FINAL_MAP_PATH.parent.mkdir(parents=True, exist_ok=True)
FINAL_MAP_PATH.write_text(json.dumps(final, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

# Verify readback.
updated = json.loads(STARTER_PATH.read_text(encoding='utf-8'))
updated_by_slug = {s['slug']: s for s in updated}
verify_errors = []
for item in final:
    actual = updated_by_slug[item['slug']].get('buddyBonus')
    if actual != item['buddyBonus']:
        verify_errors.append(f"Readback mismatch for {item['slug']}")
missing = [s['slug'] for s in updated if 'buddyBonus' not in s]
if missing:
    verify_errors.append('Missing buddyBonus after write: ' + ', '.join(missing))

audit = {
    'applied': not verify_errors,
    'starterSpecies': len(starter),
    'buddyBonusesWritten': len(final),
    'backup': str(BACKUP_PATH),
    'finalMapping': str(FINAL_MAP_PATH),
    'errors': verify_errors,
    'values': {'rarityValues': RARITY_VALUES, 'targetOverrides': TARGET_OVERRIDES},
}
AUDIT_PATH.write_text(json.dumps(audit, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
if verify_errors:
    raise SystemExit('\n'.join(verify_errors))
print(json.dumps(audit, indent=2, ensure_ascii=False))
