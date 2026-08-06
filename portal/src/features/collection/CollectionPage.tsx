/** Phase 0 placeholder. The real Collection (plan §8.2) ships in Phase 1. */
import { LibraryBig } from 'lucide-react';

import { ComingSoonPage } from '@/features/comingSoon/ComingSoonPage';

export function CollectionPage() {
  return (
    <ComingSoonPage
      title="Collection"
      description="Every Waifumon you have caught."
      icon={LibraryBig}
      detail="Scaffolding is in place; the Collection lands in Phase 1."
    />
  );
}
