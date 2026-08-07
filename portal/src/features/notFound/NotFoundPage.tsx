/**
 * 404 (plan §19). Used both for unknown URLs and for a resource-level miss —
 * an unknown `waifuId` or species slug — where the link back is to the parent
 * list rather than the dashboard.
 */
import { Compass } from 'lucide-react';
import { Link } from 'react-router';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/layout/EmptyState';

export interface NotFoundPageProps {
  title?: string;
  description?: string;
  /** Where "go back" points. Defaults to the dashboard. */
  backTo?: string;
  backLabel?: string;
}

export function NotFoundPage({
  title = 'Page not found',
  description = 'That page does not exist in the Portal.',
  backTo = '/dashboard',
  backLabel = 'Back to Dashboard',
}: NotFoundPageProps) {
  return (
    <div className="py-6">
      <EmptyState
        icon={Compass}
        title={title}
        description={description}
        hint={
          <Button asChild variant="outline" size="sm" className="mt-1">
            <Link to={backTo}>{backLabel}</Link>
          </Button>
        }
      />
    </div>
  );
}
