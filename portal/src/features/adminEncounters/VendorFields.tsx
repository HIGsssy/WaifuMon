/**
 * The vendor form's fields — identity plus inventory. Shared by the Vendors
 * page and the "create/edit vendor" dialog inside the encounter editor, so
 * both edit a vendor exactly the same way.
 */
import { useId, useState } from 'react';

import type { AdminEncounterReference } from '@/api/adminEncounters';
import { Input } from '@/components/ui/input';
import { slugify, uniqueSlug } from './slugs';
import type { VendorFormState } from './vendorForm';
import { VendorInventoryEditor } from './VendorInventoryEditor';

const TEXTAREA =
  'mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink';

interface Props {
  form: VendorFormState;
  isNew: boolean;
  takenKeys: ReadonlySet<string>;
  items: AdminEncounterReference['items'];
  onChange: (form: VendorFormState) => void;
  disabled?: boolean | undefined;
}

export function VendorFields({ form, isNew, takenKeys, items, onChange, disabled }: Props) {
  const nameId = useId();
  const keyId = useId();
  const [showKey, setShowKey] = useState(false);

  return (
    <div className="space-y-4">
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold uppercase text-ink-muted">Identity</legend>
        <div className="text-xs text-ink-muted">
          <label htmlFor={nameId}>Name</label>
          <Input
            id={nameId}
            value={form.name}
            disabled={disabled}
            placeholder="The Wandering Merchant"
            onChange={(e) => {
              const name = e.target.value;
              onChange({
                ...form,
                name,
                // New vendors get a key from their name until the author
                // takes it over. An existing key never changes.
                ...(isNew && form.keyFromName
                  ? { vendorKey: uniqueSlug(slugify(name, 'vendor'), takenKeys) }
                  : {}),
              });
            }}
          />
        </div>
        <label className="block text-xs text-ink-muted">
          Description
          <textarea
            rows={2}
            className={TEXTAREA}
            value={form.description}
            disabled={disabled}
            onChange={(e) => onChange({ ...form, description: e.target.value })}
            placeholder="Shown when the shop opens."
          />
        </label>
        {isNew ? (
          <div className="text-xs text-ink-muted">
            {showKey ? (
              <>
                <label htmlFor={keyId}>Key (used by encounters; cannot change later)</label>
                <Input
                  id={keyId}
                  value={form.vendorKey}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange({ ...form, vendorKey: e.target.value.trim(), keyFromName: false })
                  }
                />
              </>
            ) : (
              <p>
                Key: <code>{form.vendorKey || '—'}</code>{' '}
                <button
                  type="button"
                  className="text-accent underline"
                  onClick={() => setShowKey(true)}
                >
                  Change
                </button>
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-ink-muted">
            Key: <code>{form.vendorKey}</code> — fixed, because encounters refer to it.
          </p>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold uppercase text-ink-muted">Inventory</legend>
        <VendorInventoryEditor
          stock={form.stock}
          items={items}
          disabled={disabled}
          onChange={(stock) => onChange({ ...form, stock })}
        />
      </fieldset>
    </div>
  );
}
