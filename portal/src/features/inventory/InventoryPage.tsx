/** Phase 0 placeholder. The real Inventory page (plan §8.5) ships in Phase 2. */
import { Backpack } from 'lucide-react';

import { ComingSoonPage } from '@/features/comingSoon/ComingSoonPage';

export function InventoryPage() {
  return (
    <ComingSoonPage
      title="Inventory"
      description="Charms, materials and everything else you are carrying."
      icon={Backpack}
      detail="Scaffolding is in place; the Inventory page lands in Phase 2."
    />
  );
}
