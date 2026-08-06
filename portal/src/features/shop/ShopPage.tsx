/** Phase 0 placeholder. The real Shop page (plan §8.6) ships in Phase 2. */
import { Store } from 'lucide-react';

import { ComingSoonPage } from '@/features/comingSoon/ComingSoonPage';

export function ShopPage() {
  return (
    <ComingSoonPage
      title="Shop"
      description="What is for sale today."
      icon={Store}
      detail="Scaffolding is in place; the Shop page lands in Phase 2."
    />
  );
}
