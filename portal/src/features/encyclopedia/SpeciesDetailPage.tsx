/** Phase 0 placeholder. The real species page (plan §8.7) ships in Phase 2. */
import { BookOpen } from 'lucide-react';

import { ComingSoonPage } from '@/features/comingSoon/ComingSoonPage';

export function SpeciesDetailPage() {
  return (
    <ComingSoonPage
      title="Species"
      description="A single encyclopedia entry."
      icon={BookOpen}
      detail="Scaffolding is in place; the species page lands in Phase 2."
    />
  );
}
