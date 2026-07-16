/**
 * UI helpers — respondScreen chooses update() vs reply() based on interaction
 * kind; withBackRow appends a Back button.
 */
import { describe, expect, it, vi } from 'vitest';
import { DiscordAPIError, MessageFlags } from 'discord.js';
import {
  backButton,
  isStaleInteractionError,
  respondScreen,
  withBackRow,
} from '../../src/discord/ui';

function fakeButtonInteraction(overrides: Partial<Record<string, unknown>> = {}) {
  const state = { replied: false, deferred: false };
  return {
    ...state,
    isButton: () => true,
    reply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    ...overrides,
  } as unknown as import('discord.js').ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };
}

function fakeCommandInteraction() {
  return {
    replied: false,
    deferred: false,
    isButton: () => false,
    reply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
  } as unknown as import('discord.js').ChatInputCommandInteraction & {
    reply: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };
}

describe('respondScreen', () => {
  it('updates the same ephemeral message when invoked from a button', async () => {
    const btn = fakeButtonInteraction();
    await respondScreen(btn, { content: 'hi', components: [] });
    expect(btn.update).toHaveBeenCalledOnce();
    expect(btn.reply).not.toHaveBeenCalled();
    expect(btn.editReply).not.toHaveBeenCalled();
  });

  it('uses editReply if the button interaction is already deferred', async () => {
    const btn = fakeButtonInteraction({ deferred: true });
    await respondScreen(btn, { content: 'later', components: [] });
    expect(btn.editReply).toHaveBeenCalledOnce();
    expect(btn.update).not.toHaveBeenCalled();
  });

  it('replies with the Ephemeral flag for slash commands', async () => {
    const cmd = fakeCommandInteraction();
    await respondScreen(cmd, { content: 'first' });
    expect(cmd.reply).toHaveBeenCalledOnce();
    const payload = cmd.reply.mock.calls[0]![0] as { flags?: number };
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
  });

  it('normalizes missing fields to empty defaults so files/components are cleared', async () => {
    const btn = fakeButtonInteraction();
    await respondScreen(btn, { embeds: [{ toJSON: () => ({}) } as never] });
    const payload = btn.update.mock.calls[0]![0] as {
      files: unknown[];
      components: unknown[];
      content: string;
    };
    expect(payload.files).toEqual([]);
    expect(payload.components).toEqual([]);
    expect(payload.content).toBe('');
  });
});

describe('withBackRow / backButton', () => {
  it('backButton uses the menu:back custom id', () => {
    const b = backButton().toJSON() as { custom_id?: string };
    expect(b.custom_id).toBe('wm|v1|menu|back');
  });

  it('withBackRow appends a single trailing row containing the Back button', () => {
    const rows = withBackRow();
    expect(rows).toHaveLength(1);
    const last = rows[rows.length - 1]!.toJSON() as { components: Array<{ custom_id: string }> };
    expect(last.components).toHaveLength(1);
    expect(last.components[0]?.custom_id).toBe('wm|v1|menu|back');
  });
});

describe('isStaleInteractionError', () => {
  it('matches Discord 10008/10062/40060 codes', () => {
    for (const code of [10008, 10062, 40060]) {
      const err = Object.create(DiscordAPIError.prototype) as DiscordAPIError;
      Object.assign(err, { code, message: 'x' });
      expect(isStaleInteractionError(err)).toBe(true);
    }
  });

  it('does not match arbitrary errors', () => {
    expect(isStaleInteractionError(new Error('nope'))).toBe(false);
    expect(isStaleInteractionError('string')).toBe(false);
    expect(isStaleInteractionError(null)).toBe(false);
  });

  it('does not match non-stale Discord errors', () => {
    const err = Object.create(DiscordAPIError.prototype) as DiscordAPIError;
    Object.assign(err, { code: 50013, message: 'Missing Permissions' });
    expect(isStaleInteractionError(err)).toBe(false);
  });
});
