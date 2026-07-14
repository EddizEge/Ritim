type CoverProps = {
  index: number
  className?: string
  label?: string
  thumbnailUrl?: string
}

export function Cover({ index, className = '', label, thumbnailUrl }: CoverProps) {
  return (
    <div
      className={`cover ${thumbnailUrl ? 'cover--remote' : `cover-${index}`} ${className}`}
      style={thumbnailUrl ? { backgroundImage: `url(${JSON.stringify(thumbnailUrl).slice(1, -1)})` } : undefined}
      role="img"
      aria-label={label}
    />
  )
}
