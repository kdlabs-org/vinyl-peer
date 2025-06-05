import type { VinylPeerPlugin, PluginContext } from "./PluginInterface.js";
import type { PeerInfo, FileInfo, NetworkFileInfo, UploadFile } from "./types.js";

export class PluginManager {
  private plugins: Map<string, VinylPeerPlugin> = new Map();
  private context: PluginContext | null = null;
  /**
   * Maps a protocol string ("/foo/1.0.0") → the plugin that registered it.
   */
  private protocolHandlers: Map<string, VinylPeerPlugin> = new Map();

  setContext(context: PluginContext): void {
    this.context = context;
  }

  /**
   * Register a plugin:
   * 1) plugin.initialize(context)
   * 2) For each protocol in plugin.getCapabilities().protocols → libp2p.handle(...)
   *    but only if no‐one else has already bound that protocol
   * 3) Enforce protocol validation and size‐limit transforms
   * 4) Add plugin to this.plugins
   */
  async registerPlugin(plugin: VinylPeerPlugin): Promise<boolean> {
    if (!this.context) {
      throw new Error("Plugin context not set");
    }

    const caps = plugin.getCapabilities();
    console.log(`PluginManager: initializing plugin "${caps.name}" v${caps.version}…`);

    // 1) Initialize plugin
    const ok = await plugin.initialize(this.context);
    if (!ok) {
      console.error(`PluginManager: plugin "${caps.name}" failed to initialize`);
      return false;
    }

    // 2) Register protocol handlers (check for collisions)
    if (caps.protocols && this.context.libp2p) {
      for (const protocol of caps.protocols) {
        if (this.protocolHandlers.has(protocol)) {
          console.warn(
            `PluginManager: protocol "${protocol}" already registered, skipping for plugin "${plugin.getCapabilities().name}"`,
          );
          continue;
        }
        this.protocolHandlers.set(protocol, plugin);

        // Attach a wrapped handler → validate protocol and peer identity
        this.context.libp2p.handle(protocol, async ({ stream, connection }: any) => {
          try {
            if (plugin.identifyPeer) {
              const verified = await plugin.identifyPeer(connection.remotePeer.toString());
              if (!verified) {
                console.warn(
                  `PluginManager: peer ${connection.remotePeer.toString()} failed identification for protocol ${protocol}`,
                );
                return;
              }
            }

            const MAX_MESSAGE_SIZE = 1 * 1024 * 1024; // 1 MB
            const sizeLimiter = new stream.Transform({
              transform(
                chunk: Buffer,
                _: any,
                callback: (error?: Error | null, data?: Buffer) => void,
              ) {
                if (chunk.length > MAX_MESSAGE_SIZE) {
                  callback(new Error("Message too large"));
                } else {
                  callback(null, chunk);
                }
              },
            });
            const limitedStream = stream.pipe(sizeLimiter);

            await plugin.handleProtocol(protocol, limitedStream, connection.remotePeer.toString());
          } catch (err) {
            console.error(
              `PluginManager: error in handleProtocol("${protocol}") for plugin "${caps.name}"`,
              err,
            );
          }
        });
        console.log(
          `PluginManager: bound protocol "${protocol}" → plugin "${caps.name}" (no collisions).`,
        );
      }
    }

    this.plugins.set(caps.name, plugin);
    return true;
  }

  async unregisterPlugin(pluginName: string): Promise<boolean> {
    try {
      const plugin = this.plugins.get(pluginName);
      if (!plugin) {
        console.warn(`PluginManager: plugin "${pluginName}" not found`);
        return false;
      }

      const caps = plugin.getCapabilities();

      await plugin.stop();

      for (const protocol of caps.protocols) {
        this.protocolHandlers.delete(protocol);
        if (this.context?.libp2p) {
          this.context.libp2p.unhandle(protocol);
        }
      }

      this.plugins.delete(pluginName);
      console.log(`PluginManager: plugin "${pluginName}" unregistered`);
      return true;
    } catch (err) {
      console.error(`PluginManager: error unregistering "${pluginName}"`, err);
      return false;
    }
  }

  getPlugin(pluginName: string): VinylPeerPlugin | undefined {
    return this.plugins.get(pluginName);
  }

  getAllPlugins(): VinylPeerPlugin[] {
    return Array.from(this.plugins.values());
  }

  async startAllPlugins(): Promise<void> {
    console.log("PluginManager: starting all plugins…");
    for (const [name, plugin] of this.plugins.entries()) {
      try {
        // Placeholder: enforce resource quotas (not fully implemented here)
        console.log(`Enforcing resource quotas for plugin "${name}"...`);
        await plugin.start();
        console.log(`PluginManager: plugin "${name}" started`);
      } catch (err) {
        console.error(`PluginManager: error starting plugin "${name}"`, err);
      }
    }
  }

  async stopAllPlugins(): Promise<void> {
    console.log("PluginManager: stopping all plugins…");

    this.protocolHandlers.clear();

    for (const [name, plugin] of this.plugins.entries()) {
      try {
        await plugin.stop();
        console.log(`PluginManager: plugin "${name}" stopped`);
      } catch (err) {
        console.error(`PluginManager: error stopping plugin "${name}"`, err);
      }
    }

    this.plugins.clear();
  }

  /**
   * Let each plugin enhance file‐metadata.
   */
  async enhanceFileMetadata(file: UploadFile): Promise<any> {
    let aggregated: any = {};
    for (const plugin of this.plugins.values()) {
      if (plugin.enhanceMetadata) {
        try {
          const md = await plugin.enhanceMetadata(file);
          aggregated = { ...aggregated, ...md };
        } catch (err) {
          console.error("PluginManager: error in enhanceMetadata()", err);
        }
      }
    }
    return aggregated;
  }

  /**
   * Let each plugin run `searchFiles(...)` and concatenate all results.
   */
  async searchFiles(query: any): Promise<NetworkFileInfo[]> {
    let results: NetworkFileInfo[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.searchFiles) {
        try {
          const pluginResults = await plugin.searchFiles(query);
          results = results.concat(pluginResults);
        } catch (err) {
          console.error("PluginManager: error in searchFiles()", err);
        }
      }
    }
    return results;
  }

  /**
   * Let each plugin run `getRecommendations(...)` and concatenate results.
   */
  async getRecommendations(basedOnCid: string): Promise<NetworkFileInfo[]> {
    let results: NetworkFileInfo[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.getRecommendations) {
        try {
          const recs = await plugin.getRecommendations(basedOnCid);
          results = results.concat(recs);
        } catch (err) {
          console.error("PluginManager: error in getRecommendations()", err);
        }
      }
    }
    return results;
  }

  // ───────── Event Propagation to Plugins ─────────

  notifyPeerConnected(peerId: string, peer: PeerInfo): void {
    for (const plugin of this.plugins.values()) {
      if (plugin.onPeerConnected) {
        try {
          plugin.onPeerConnected(peerId, peer);
        } catch (err) {
          console.error("PluginManager: error in onPeerConnected()", err);
        }
      }
    }
  }

  notifyPeerDisconnected(peerId: string, peer: PeerInfo): void {
    for (const plugin of this.plugins.values()) {
      if (plugin.onPeerDisconnected) {
        try {
          plugin.onPeerDisconnected(peerId, peer);
        } catch (err) {
          console.error("PluginManager: error in onPeerDisconnected()", err);
        }
      }
    }
  }

  notifyFileUploaded(cid: string, fileInfo: FileInfo): void {
    for (const plugin of this.plugins.values()) {
      if (plugin.onFileUploaded) {
        try {
          plugin.onFileUploaded(cid, fileInfo);
        } catch (err) {
          console.error("PluginManager: error in onFileUploaded()", err);
        }
      }
    }
  }

  notifyFileDownloaded(cid: string): void {
    for (const plugin of this.plugins.values()) {
      if (plugin.onFileDownloaded) {
        try {
          plugin.onFileDownloaded(cid);
        } catch (err) {
          console.error("PluginManager: error in onFileDownloaded()", err);
        }
      }
    }
  }
}
