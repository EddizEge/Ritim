export declare const CATALOG_RECENT_LIMIT: number

export declare function mergeCatalogTracks<T extends { id: string }>(
  catalog: Record<string, T> | undefined,
  tracks: readonly T[] | undefined,
): Record<string, T>

export declare function pruneCatalog<T>(
  catalog: Record<string, T> | undefined,
  keep?: { trackId?: string; queue?: readonly string[]; liked?: readonly string[] },
  limit?: number,
): Record<string, T>
