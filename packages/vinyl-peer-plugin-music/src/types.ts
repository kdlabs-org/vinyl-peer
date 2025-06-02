/**
 * MusicMetadata: All the fields our plugin knows about for each audio file.
 */
export interface MusicMetadata {
  artist?: string
  album?: string
  title?: string
  genre?: string
  year?: number
  duration?: number // In seconds (if known)
  bpm?: number
  mood?: string
  tags?: string[]
}

/**
 * MusicDiscoveryQuery: Filter parameters for searching music files.
 */
export interface MusicDiscoveryQuery {
  artist?: string
  album?: string
  genre?: string
  mood?: string
  bpm?: { min: number; max: number }
  year?: { min: number; max: number }
  limit?: number
}

/**
 * MusicRecommendation: The shape of each recommendation returned to clients.
 */
export interface MusicRecommendation {
  cid: string
  score: number
  reason: string
  metadata: MusicMetadata
}
