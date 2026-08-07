/**
 * "Switch player" — the way back to the developer login screen, dev only.
 *
 * Rendered in two places, both of which a developer already reaches for when
 * they want to know or change who they are: the header (icon, always visible)
 * and the Settings page's development-build card (labelled, next to the
 * diagnostics link). Callers guard it with `import.meta.env.DEV` so a
 * production build never references `useDevAuth`.
 *
 * Signing out clears the stored session but keeps the pair in memory, so the
 * login form comes up pre-filled and switching back is a single click.
 */
import { UserRoundCog } from 'lucide-react';
import { useNavigate } from 'react-router';

import { useDevAuth } from '@/auth/dev/useDevAuth';
import { Button } from '@/components/ui/button';

export interface SwitchPlayerButtonProps {
  /** Icon-only for the header; labelled everywhere there is room for words. */
  iconOnly?: boolean;
  className?: string;
}

const LABEL = 'Switch player';

export function SwitchPlayerButton({ iconOnly = false, className }: SwitchPlayerButtonProps) {
  const { signOut } = useDevAuth();
  const navigate = useNavigate();

  function handleClick() {
    signOut();
    void navigate('/select-player');
  }

  if (iconOnly) {
    return (
      <Button
        variant="ghost"
        size="icon"
        onClick={handleClick}
        aria-label={LABEL}
        title={`${LABEL} (development build)`}
        {...(className ? { className } : {})}
      >
        <UserRoundCog aria-hidden="true" />
      </Button>
    );
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleClick} {...(className ? { className } : {})}>
      <UserRoundCog aria-hidden="true" />
      {LABEL}
    </Button>
  );
}
