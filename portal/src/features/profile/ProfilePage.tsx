/** Phase 0 placeholder. The real Profile page (plan §8.8) ships in Phase 2. */
import { User } from 'lucide-react';

import { ComingSoonPage } from '@/features/comingSoon/ComingSoonPage';

export function ProfilePage() {
  return (
    <ComingSoonPage
      title="Trainer Profile"
      description="Who you are, and how far you have come."
      icon={User}
      detail="Scaffolding is in place; the Profile page lands in Phase 2."
    />
  );
}
