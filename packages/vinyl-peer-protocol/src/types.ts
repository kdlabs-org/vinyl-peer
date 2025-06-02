import type { Application, Router } from "express";

/**
 * PeerInfo: Basic information about a peer in the network.
 */
export interface PeerInfo {
  id: string;
  address: string;
  status: "connected" | "disconnected" | "connecting";
  lastSeen: Date;
  latency?: number;
}

/**
 * NodeStats: Aggregated statistics about the local node.
 */
export interface NodeStats {
  id: string;
  isOnline: boolean;
  connectedPeers: number;
  totalPeers: number;
  uploadedFiles: number;
  downloadedFiles: number;
  storageUsed: number;
  storageAvailable: number;
  pinnedFiles: number;
}

/**
 * StorageMode: Whether to store data in IPFS or via P2P streaming.
 */
export type StorageMode = "ipfs" | "p2p-stream";

/**
 * FileInfo: Metadata for a stored file.
 */
export interface FileInfo {
  cid: string;
  name: string;
  size: number;
  type: string;
  uploadDate: Date;
  encrypted: boolean;
  storageMode: StorageMode;
  streamId?: string;
  pinned?: boolean;
  shareLink?: string;
  metadata?: any;
}

/**
 * NetworkFileInfo: A FileInfo plus which peer it's hosted on and availability.
 */
export interface NetworkFileInfo extends FileInfo {
  peerId: string;
  peerAddress: string;
  availability: "online" | "offline";
}

/**
 * UploadFile: An abstraction for any “file‐like” object that can produce an ArrayBuffer.
 * (For example, a browser File or our NodeFile wrapper).
 */
export interface UploadFile {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * PluginPermissions: Defines what a plugin is allowed to do.
 */
export interface PluginPermissions {
  accessFiles: boolean;
  useNetwork: boolean;
  modifyPeers: boolean;
  exposeHttp?: boolean;
  // future fine‐grained options...
}

/**
 * PluginContext: Provided by Vinyl → plugins upon initialization.
 */
export interface PluginContext {
  nodeId: string;
  libp2p: any;
  files: Map<string, FileInfo>;
  peers: Map<string, PeerInfo>;
  networkFiles: Map<string, NetworkFileInfo>;

  /**
   * Internal event emitter. Every call will include an envelope:
   *   { source: <pluginName>, payload: <whatever> }.
   * Validated against a schema before dispatch.
   */
  emit: (event: string, envelope: { source: string; payload: any }) => void;

  /** Pin a CID on this node (download/store it locally). */
  pinFile: (cid: string) => Promise<void>;
  /** Unpin a CID on this node. */
  unpinFile: (cid: string) => Promise<void>;

  /** Retrieve this plugin’s permissions. */
  getPermissions: () => PluginPermissions;
}

/**
 * PluginCapabilities: Declares what a plugin supports.
 */
export interface PluginCapabilities {
  name: string;
  version: string;
  /** e.g. ["/music-discovery/1.0.0", ...] */
  protocols: string[];
  /** e.g. ["streaming","discovery","recommendations"] */
  capabilities: string[];
  fileTypes?: string[];
  permissions: PluginPermissions;
}

/**
 * HttpPlugin: If a plugin wishes to expose HTTP routes,
 * it must implement getHttpNamespace() + getHttpRouter().
 */
export interface HttpPlugin {
  /** e.g. returns "/analytics" */
  getHttpNamespace(): string;
  /** Return an Express.Application or an Express.Router. */
  getHttpRouter(): Application | Router;
}

/**
 * VinylPeerPlugin: Core plugin interface.
 */
export interface VinylPeerPlugin {
  getCapabilities(): PluginCapabilities;
  initialize(context: PluginContext): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;
  setupProtocols(): void;
  handleProtocol(protocol: string, stream: any, peerId: string): Promise<void>;

  canHandleFile?(file: FileInfo): boolean;
  processFile?(file: FileInfo, context: PluginContext): Promise<any>;
  enhanceMetadata?(file: UploadFile): Promise<any>;

  searchFiles?(query: any): Promise<NetworkFileInfo[]>;
  getRecommendations?(basedOnCid: string): Promise<NetworkFileInfo[]>;

  identifyPeer?(peerId: string): Promise<boolean>;

  onPeerConnected?(peerId: string, peer: PeerInfo): void;
  onPeerDisconnected?(peerId: string, peer: PeerInfo): void;
  onFileUploaded?(cid: string, fileInfo: FileInfo): void;
  onFileDownloaded?(cid: string): void;

  getHttpNamespace?(): string;
  getHttpRouter?(): Application | Router;
}
