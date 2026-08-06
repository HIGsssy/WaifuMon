/** Phase 0 placeholder. The real Dashboard (plan §8.1) ships in Phase 1. */
import { LayoutDashboard } from 'lucide-react';

import { ComingSoonPage } from '@/features/comingSoon/ComingSoonPage';

export function DashboardPage() {
  return (
    <ComingSoonPage
      title="Dashboard"
      description="Your trainer, your buddy, and where your collection stands."
      icon={LayoutDashboard}
      detail="Scaffolding is in place; the Dashboard lands in Phase 1."
    />
  );
}
