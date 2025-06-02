/**
 * AnalyticsSnapshot: A periodic snapshot of overall node metrics.
 */
export interface AnalyticsSnapshot {
  timestamp: string;
  totalPeers: number;
  totalConnectedPeers: number;
  totalFiles: number;
  totalMusicFiles: number;
  totalPinCount: number;
}

/**
 * TopFileType: The top N file types stored, with counts.
 */
export interface TopFileType {
  type: string;
  count: number;
}

/**
 * AnalyticsStats: Combined analytics results returned over HTTP.
 */
export interface AnalyticsStats {
  snapshot: AnalyticsSnapshot;
  topFileTypes: TopFileType[];
  pinnedFileCount: number;
  connectedMusicPeers: number;
}
