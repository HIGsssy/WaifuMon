/**
 * An image a caller has already fetched through a permission-gated loader and
 * holds as an object URL. The one place such a URL becomes an `<img>`, so
 * feature code never writes one (plan §12): use {@link AuthoredArtwork} when
 * the component should do the loading, and this when the caller needs to know
 * the outcome itself — to say *why* a picture is missing, for instance.
 */
export function LoadedArtwork({
  url,
  alt,
  className = 'h-full w-full object-cover',
  testId,
}: {
  url: string;
  alt: string;
  className?: string;
  testId?: string | undefined;
}) {
  return <img src={url} alt={alt} className={className} data-testid={testId} />;
}
