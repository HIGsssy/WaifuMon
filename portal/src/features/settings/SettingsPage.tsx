/** Phase 0 placeholder. Theme toggle + About section (plan §8.10) ship in Phase 2. */
import { Settings } from 'lucide-react';

import { ComingSoonPage } from '@/features/comingSoon/ComingSoonPage';

export function SettingsPage() {
  return (
    <ComingSoonPage
      title="Settings"
      description="Theme, and what this build is."
      icon={Settings}
      detail="Scaffolding is in place; Settings lands in Phase 2. The theme toggle is in the header meanwhile."
    />
  );
}
