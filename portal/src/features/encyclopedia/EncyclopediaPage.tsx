/** Phase 0 placeholder. The real Encyclopedia (plan §8.7) ships in Phase 2. */
import { BookOpen } from 'lucide-react';

import { ComingSoonPage } from '@/features/comingSoon/ComingSoonPage';

export function EncyclopediaPage() {
  return (
    <ComingSoonPage
      title="Encyclopedia"
      description="Every species in the world, discovered or not."
      icon={BookOpen}
      detail="Scaffolding is in place; the Encyclopedia lands in Phase 2."
    />
  );
}
