import {
  PeerInfo,
  FileInfo,
  NetworkFileInfo,
  UploadFile,
  PluginContext,
  PluginCapabilities,
  PluginPermissions,
  VinylPeerPlugin,
} from "./types.js";

/**
 * We’ve removed the duplicate interface/type declarations here, since those
 * are already exported by `types.js`. Instead, we re‐export them and then
 * provide `BasePlugin`’s implementation below.
 */

/**
 * Re-export types that were originally defined in types.js
 */
export type {
  PeerInfo,
  FileInfo,
  NetworkFileInfo,
  UploadFile,
  PluginContext,
  PluginCapabilities,
  PluginPermissions,
  VinylPeerPlugin,
};

/**
 * BasePlugin: Abstract class that enforces initialize → start ordering
 * and wraps `emit()` so that every event is tagged with `source: pluginName`.
 *
 * (Originally this lived here, but its type signatures are already in types.js.
 *  We simply provide the implementation now, without redeclaring interfaces.)
 */
export abstract class BasePlugin implements VinylPeerPlugin {
  protected context: PluginContext | null = null;
  protected isInitialized: boolean = false;
  protected isStarted: boolean = false;

  /** Must be implemented by each plugin to declare its name/version/protocols, etc. */
  abstract getCapabilities(): PluginCapabilities;

  async initialize(context: PluginContext): Promise<boolean> {
    this.context = context;
    this.isInitialized = true;

    // Verify plugin requested permissions do not exceed context‐granted permissions
    const requested = this.getCapabilities().permissions;
    const granted = context.getPermissions();
    for (const perm of Object.keys(requested) as (keyof PluginPermissions)[]) {
      if (requested[perm] && !granted[perm]) {
        console.error(
          `Plugin "${this.getCapabilities().name}" requested unauthorized permission: ${perm}`,
        );
        return false;
      }
    }
    return true;
  }

  async start(): Promise<void> {
    if (!this.isInitialized) {
      throw new Error("Plugin must be initialized before starting");
    }
    this.setupProtocols();
    this.isStarted = true;
  }

  async stop(): Promise<void> {
    this.isStarted = false;
  }

  abstract setupProtocols(): void;
  abstract handleProtocol(protocol: string, stream: any, peerId: string): Promise<void>;

  /**
   * Wrap every emitted event in an envelope: { source: pluginName, payload }.
   * Performs a basic check before dispatch.
   */
  protected emit(event: string, payload: any): void {
    if (!this.context) return;
    const pluginName = this.getCapabilities().name;
    if (typeof event !== "string" || event.trim() === "") {
      console.warn(`Plugin "${pluginName}" attempted to emit invalid event:`, event);
      return;
    }
    this.context.emit(event, { source: pluginName, payload });
  }
}
