/**
 * The shared "not built yet" page (plan §8.10).
 *
 * Achievements, Events and Friends use this permanently — each is reachable by
 * URL, reserved in the sidebar, and honest about being unbuilt. During Phase 0
 * every route renders it, and each phase replaces one instance with the real
 * page.
 */
import type { LucideIcon } from 'lucide-react';

import { EmptyState } from '@/components/layout/EmptyState';
import { PageHeader } from '@/components/layout/PageHeader';

export interface ComingSoonPageProps {
  title: string;
  description: string;
  icon: LucideIcon;
  /** One line on what will eventually live here. */
  detail?: string;
}

export function ComingSoonPage({ title, description, icon, detail }: ComingSoonPageProps) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <EmptyState
        icon={icon}
        title="Coming Soon"
        description={detail ?? 'This part of the Portal has not been built yet.'}
        hint="The sidebar slot is reserved so the layout will not shift when it lands."
      />
    </>
  );
}
