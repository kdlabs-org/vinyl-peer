/**
 * MusicMetadata: All fields known about an audio file.
 */
export interface MusicMetadata {
  artist?: string;
  album?: string;
  title?: string;
  genre?: string;
  year?: number;
  duration?: number; // seconds
  bpm?: number;
  mood?: string;
  tags?: string[];
}

/**
 * MusicDiscoveryQuery: Filter parameters for searching music.
 */
export interface MusicDiscoveryQuery {
  artist?: string;
  album?: string;
  genre?: string;
  mood?: string;
  bpm?: { min: number; max: number };
  year?: { min: number; max: number };
  limit?: number;
}

/**
 * MusicRecommendation: Returned recommendation object.
 */
export interface MusicRecommendation {
  cid: string;
  score: number;
  reason: string;
  metadata: MusicMetadata;
}

/**
 * Playlist entry.
 */
export interface Playlist {
  name: string;
  ownerPeer: string;
  trackCids: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Announcement payload for PubSub.
 */
export interface AnnouncementPayload {
  type: "new-track";
  cid: string;
  metadata: MusicMetadata;
  peerId: string;
}
