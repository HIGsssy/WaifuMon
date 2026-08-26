/**
 * Slash-command definitions must survive `.toJSON()`.
 *
 * discord.js validates builders at serialization time, and the only place that
 * runs in production is `registerCommands` during boot — so a malformed option
 * (a bad name, an out-of-range choice list, too many options) would surface as
 * a failed startup against the live API rather than a failed test. This pins
 * the shape cheaply, with attention to the admin surface that mutates state.
 */
import { describe, expect, it } from 'vitest';
import { buildCommandDefinitions } from '../../src/discord/commandRegistry';
import {
  ADMIN_CHARM_CHOICES,
  ADMIN_MAX_CHARM_GRANT,
  ADMIN_MAX_ESSENCE_GRANT,
} from '../../src/discord/commands/waifumonAdminPlayer';

/** Discord application-command option types used below. */
const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;

const defs = () => buildCommandDefinitions() as any[];

function commandNamed(name: string): any {
  const found = defs().find((c) => c.name === name);
  expect(found, `command /${name} is missing`).toBeDefined();
  return found;
}

function optionNamed(options: any[] | undefined, name: string): any {
  return (options ?? []).find((o: any) => o.name === name);
}

describe('buildCommandDefinitions', () => {
  it('serializes without throwing', () => {
    expect(() => buildCommandDefinitions()).not.toThrow();
  });

  it('registers the three top-level commands', () => {
    expect(defs().map((c) => c.name).sort()).toEqual(['waifumon', 'waifumon-admin', 'wm']);
  });
});

describe('/waifumon-admin player', () => {
  const adminCommand = () => commandNamed('waifumon-admin');
  const playerGroup = () => optionNamed(adminCommand().options, 'player');

  it('is a subcommand group on the admin command, not a player-facing one', () => {
    const group = playerGroup();
    expect(group).toBeDefined();
    expect(group.type).toBe(SUB_COMMAND_GROUP);

    // Belt and braces: the live-testing tools must never appear on /wm or
    // /waifumon, which any player can run.
    for (const name of ['wm', 'waifumon']) {
      expect(optionNamed(commandNamed(name).options, 'player')).toBeUndefined();
    }
  });

  it('inherits the admin command’s ManageGuild gate and is guild-only', () => {
    const cmd = adminCommand();
    // ManageGuild is bit 1 << 5; serialized as a decimal string.
    expect(String(cmd.default_member_permissions)).toBe('32');
    expect(cmd.dm_permission).toBe(false);
  });

  it('exposes energy, essence and charms', () => {
    const subs = (playerGroup().options ?? []).map((o: any) => o.name).sort();
    expect(subs).toEqual(['charms', 'energy', 'essence']);
    for (const sub of playerGroup().options ?? []) {
      expect(sub.type).toBe(SUB_COMMAND);
    }
  });

  it('requires an explicit target user on every subcommand', () => {
    for (const sub of playerGroup().options ?? []) {
      const user = optionNamed(sub.options, 'user');
      expect(user, `${sub.name} is missing the user option`).toBeDefined();
      expect(user.required, `${sub.name} target must be required`).toBe(true);
      // The target is always the first option, so it cannot be omitted by a
      // caller relying on positional entry.
      expect(sub.options[0].name).toBe('user');
    }
  });

  it('caps essence at the documented ceiling', () => {
    const essence = optionNamed(playerGroup().options, 'essence');
    const amount = optionNamed(essence.options, 'amount');
    expect(amount.required).toBe(true);
    expect(amount.min_value).toBe(1);
    expect(amount.max_value).toBe(ADMIN_MAX_ESSENCE_GRANT);
  });

  it('caps charms at the documented ceiling and offers only capture charms', () => {
    const charms = optionNamed(playerGroup().options, 'charms');
    const amount = optionNamed(charms.options, 'amount');
    expect(amount.min_value).toBe(1);
    expect(amount.max_value).toBe(ADMIN_MAX_CHARM_GRANT);

    const choices = optionNamed(charms.options, 'charm').choices ?? [];
    expect(choices.map((c: any) => c.value)).toEqual(ADMIN_CHARM_CHOICES.map((c) => c.value));
    // Discord hard-caps choice lists at 25.
    expect(choices.length).toBeLessThanOrEqual(25);
  });

  it('leaves the energy amount optional so the bare command means "reset"', () => {
    const energy = optionNamed(playerGroup().options, 'energy');
    const amount = optionNamed(energy.options, 'amount');
    expect(amount.required).toBeFalsy();
    expect(amount.min_value).toBe(0);
  });
});
