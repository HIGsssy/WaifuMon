import type {
  DungeonImportPlan,
  DungeonLootImportDecision,
  DungeonLootImportDecisions,
} from '@/api/adminDungeons';
import type { DungeonLootTableBody } from '@/api/dungeonLootTypes';
import { describeGrant, formatChance, rewardNames } from '../adminDungeonLoot/lootModel';

const names = rewardNames([]);
function RewardBody({ body }: { body: DungeonLootTableBody | null }) {
  if (!body) return <p>Rewards are missing or unreadable.</p>;
  return (
    <ul className="space-y-1">
      {body.guaranteed.map((entry) => (
        <li key={`g_${entry.id}`}>Guaranteed: {describeGrant(entry.grant, names)}</li>
      ))}
      {body.chances.map((entry) => (
        <li key={`c_${entry.id}`}>
          {formatChance(entry.chanceBasisPoints / 10000)} chance:{' '}
          {describeGrant(entry.grant, names)}
        </li>
      ))}
      {body.pools.map((pool) => {
        const total = pool.entries.reduce((sum, entry) => sum + entry.weight, 0);
        return (
          <li key={`p_${pool.id}`}>
            {pool.name}: {pool.draws} {pool.draws === 1 ? 'pick' : 'picks'}
            <ul className="pl-4">
              {pool.entries.map((entry) => (
                <li key={entry.id}>
                  {formatChance(entry.weight / total)} per pick:{' '}
                  {'grant' in entry ? describeGrant(entry.grant, names) : 'Nothing'}
                </li>
              ))}
            </ul>
          </li>
        );
      })}
      {!body.guaranteed.length && !body.chances.length && !body.pools.length && <li>No rewards</li>}
    </ul>
  );
}
export function DungeonLootImportReview({
  plan,
  choices,
  onChange,
}: {
  plan: DungeonImportPlan;
  choices: DungeonLootImportDecisions;
  onChange: (key: string, choice: DungeonLootImportDecision | null) => void;
}) {
  if (!plan.lootTables) return null;
  return (
    <div className="space-y-4">
      <h3 className="font-semibold">Dungeon loot tables</h3>
      <p>Existing loot tables are kept. Imported copies preserve the source rewards.</p>
      {plan.lootTables.length === 0 && <p>No reusable loot tables in this package.</p>}
      {plan.lootTables.map((table) => {
        const choice = Object.hasOwn(choices, table.key) ? choices[table.key] : table.decision;
        return (
          <div key={table.key} className="space-y-2 rounded border border-border p-3">
            <p className="font-medium">
              {table.name}:{' '}
              {table.status === 'missing'
                ? 'Missing here — create on import'
                : table.status === 'identical'
                  ? 'Same rewards — reuse existing'
                  : 'Different rewards — choose how to import'}
            </p>
            {table.archived && (
              <p className="text-danger">
                The destination table is archived. Restore it before publication.
              </p>
            )}
            {table.status === 'different' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <h4 className="font-medium">Source rewards</h4>
                  <RewardBody body={table.incomingBody} />
                </div>
                <div>
                  <h4 className="font-medium">Destination rewards · {table.currentName}</h4>
                  <RewardBody body={table.currentBody} />
                </div>
              </div>
            )}
            <label className="block">
              Decision for loot table {table.name}{' '}
              <select
                aria-label={`Decision for loot table ${table.name}`}
                value={choice?.action ?? ''}
                onChange={(event) => {
                  const action = event.target.value;
                  onChange(
                    table.key,
                    action === 'copy'
                      ? {
                          action,
                          key: choice?.action === 'copy' ? choice.key : table.suggestedCopyKey,
                        }
                      : action === 'create' ||
                          action === 'use_existing' ||
                          action === 'leave_missing'
                        ? { action }
                        : null,
                  );
                }}
              >
                <option value="">Choose a decision</option>
                {table.status === 'missing' ? (
                  <>
                    <option value="create">Create source loot table</option>
                    <option value="leave_missing">Leave missing in incomplete draft</option>
                  </>
                ) : table.status === 'identical' ? (
                  <option value="use_existing">Reuse identical destination table</option>
                ) : (
                  <>
                    <option value="copy">Import as copy under a new key</option>
                    <option value="use_existing">
                      Use existing destination table — rewards may differ
                    </option>
                  </>
                )}
              </select>
            </label>
            {choice?.action === 'copy' && (
              <label className="block">
                New key for {table.name}{' '}
                <input
                  aria-label={`New key for ${table.name}`}
                  value={choice.key}
                  maxLength={64}
                  onChange={(event) =>
                    onChange(table.key, { action: 'copy', key: event.target.value })
                  }
                />
                <span className="block text-sm text-ink-muted">
                  Lowercase letters, numbers and underscores. Choose a key that is unused here.
                </span>
              </label>
            )}
            {choice?.action === 'use_existing' && table.status === 'different' && (
              <p className="text-danger">
                Using destination rewards can give different amounts, items or gear. Review both
                reward lists before confirming.
              </p>
            )}
          </div>
        );
      })}
      {plan.equipmentChanges?.map((change) => (
        <div key={change.selectorKey}>
          <p className="font-medium">Different gear can drop here: {change.description}</p>
          <p>Source pieces: {change.sourceCandidates.map((c) => c.name).join(', ') || 'None'}</p>
          <p>
            Destination pieces: {change.targetCandidates.map((c) => c.name).join(', ') || 'None'}
          </p>
          {!!change.added.length && <p>New here: {change.added.map((c) => c.name).join(', ')}</p>}
          {!!change.removed.length && (
            <p>Unavailable here: {change.removed.map((c) => c.name).join(', ')}</p>
          )}
        </div>
      ))}
      {plan.resultingContentHash && plan.resultingContentHash !== plan.contentHash && (
        <p>
          Copying loot tables changes the dungeon references. Resulting content hash:{' '}
          {plan.resultingContentHash}
        </p>
      )}
    </div>
  );
}
