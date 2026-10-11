import { useLayoutEffect, useRef, useState } from 'react';

/**
 * The height that carries an element from where it starts to the bottom of the
 * viewport, so a workspace can fill the screen without knowing how tall the
 * app chrome above it is. Measured against the document, not the scroll
 * position, so scrolling the page never resizes the workspace.
 */
export function useViewportFill<T extends HTMLElement>(bottomGap = 16, minHeight = 480) {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const element = ref.current;
      if (!element) return;
      const top = element.getBoundingClientRect().top + window.scrollY;
      setHeight(Math.max(minHeight, Math.round(window.innerHeight - top - bottomGap)));
    };
    measure();
    window.addEventListener('resize', measure);
    // Chrome above the workspace (banners, late fonts) can move its top edge.
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => {
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, [bottomGap, minHeight]);
  return { ref, height };
}
