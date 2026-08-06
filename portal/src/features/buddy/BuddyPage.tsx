/** Phase 0 placeholder. The real Buddy page (plan §8.4) ships in Phase 2. */
import { Heart } from 'lucide-react';

import { ComingSoonPage } from '@/features/comingSoon/ComingSoonPage';

export function BuddyPage() {
  return (
    <ComingSoonPage
      title="Buddy"
      description="The Waifumon at your side."
      icon={Heart}
      detail="Scaffolding is in place; the Buddy page lands in Phase 2."
    />
  );
}
