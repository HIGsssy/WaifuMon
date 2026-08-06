/** Phase 0 placeholder. The real Game Guide (plan §8.9) ships in Phase 2. */
import { Compass } from 'lucide-react';

import { ComingSoonPage } from '@/features/comingSoon/ComingSoonPage';

export function GuidePage() {
  return (
    <ComingSoonPage
      title="Game Guide"
      description="How hunting, care, affinities and currency actually work."
      icon={Compass}
      detail="Scaffolding is in place; the Guide lands in Phase 2."
    />
  );
}
