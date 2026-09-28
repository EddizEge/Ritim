import { useMobileArtwork } from '../appearanceContext'
import { visibleArtworkUrl } from '../appearancePreferences'

type CoverProps = {
  index: number
  className?: string
  label?: string
  thumbnailUrl?: string
}

export function Cover({ index, className = '', label, thumbnailUrl }: CoverProps) {
  const artwork = useMobileArtwork()
  const visibleThumbnail = visibleArtworkUrl(thumbnailUrl, artwork)
  return (
    <div
      className={`cover ${visibleThumbnail ? 'cover--remote' : `cover-${index}`} artwork-${artwork} ${className}`}
      style={visibleThumbnail ? { backgroundImage: `url(${JSON.stringify(visibleThumbnail).slice(1, -1)})` } : undefined}
      role={artwork === 'hidden' ? undefined : 'img'}
      aria-label={artwork === 'hidden' ? undefined : label}
      aria-hidden={artwork === 'hidden' ? true : undefined}
    />
  )
}
