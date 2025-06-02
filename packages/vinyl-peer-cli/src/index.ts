// packages/vinyl-peer-cli/src/index.ts

import { Command } from "commander";
import path from "path";
import fs from "fs";
import { Vinyl, VinylPeerPlugin } from "vinyl-peer-protocol";
import { MusicPlugin } from "vinyl-peer-plugin-music";
import { AnalyticsPlugin } from "vinyl-peer-plugin-analytics";
import mime from "mime-types";
import { NodeManager } from "./NodeManager.js";
import { NodeFile } from "./Node.js";
import { WebServer } from "./WebServer.js";
const program = new Command();

/**
 * CLIManager: eenvoudige façade‐klasse die direct Vinyl aanroept.
 */
class CLIManager {
  public vinyl!: Vinyl;
  private nodeManager: NodeManager | null = null;

  constructor() {
    // We instantiate Vinyl when start() is called.
  }

  /**
   * Start the node with the given plugins and local‐storage option.
   * Previously, Vinyl’s constructor accepted a plugin array. We now must:
   * 1) Create a new Vinyl()
   * 2) Initialize it
   * 3) After initialization, register & start each plugin manually
   */
  async start(
    plugins: Array<MusicPlugin | AnalyticsPlugin>,
    enableLocalStorage: boolean,
  ): Promise<boolean> {
    // 1) Instantiate Vinyl without arguments
    this.vinyl = new Vinyl();

    // 2) Initialize (starts libp2p, Helia, and sets up plugin context)
    const success = await this.vinyl.initialize(enableLocalStorage);
    if (!success) {
      return false;
    }

    // 3) Register each plugin with the PluginManager, then start them
    const pluginManager = this.vinyl.getPluginManager();
    for (const plugin of plugins as VinylPeerPlugin[]) {
      await pluginManager.registerPlugin(plugin);
    }
    await pluginManager.startAllPlugins();

    // 4) Create NodeManager wrapper that relies on vinyl having been initialized
    this.nodeManager = new NodeManager(this.vinyl as any);

    return true;
  }

  async uploadFile(
    nodeFile: NodeFile,
    storageMode: "ipfs" | "p2p-stream",
    metadata?: any,
  ): Promise<string> {
    return await this.vinyl.uploadFile(nodeFile, storageMode, metadata);
  }

  async downloadFile(cid: string): Promise<Uint8Array | null> {
    return await this.vinyl.downloadFile(cid);
  }

  getStats() {
    return this.vinyl.getNodeStats();
  }

  getPeers() {
    return this.vinyl.getPeers();
  }

  getFiles() {
    return this.vinyl.getFiles();
  }

  async searchFiles(query: string) {
    return await this.vinyl.searchFiles(query);
  }

  async getRecommendations(cid: string) {
    return await this.vinyl.getRecommendations(cid);
  }

  getNodeId(): string {
    if (!this.nodeManager) {
      throw new Error("NodeManager not initialized");
    }
    return this.nodeManager.getNodeId();
  }

  isNodeRunning(): boolean {
    if (!this.nodeManager) {
      throw new Error("NodeManager not initialized");
    }
    return this.nodeManager.isNodeRunning();
  }

  async pinFile(cid: string): Promise<void> {
    return await this.vinyl.pinFile(cid);
  }

  async unpinFile(cid: string): Promise<void> {
    return await this.vinyl.unpinFile(cid);
  }

  onEvent(callback: (event: string, data: any) => void) {
    // delegate to Vinyl’s event bus
    this.vinyl.onEvent(callback);
  }

  async stop() {
    await this.vinyl.stop();
  }
}

program.name("vinyl-peer").description("Vinyl Peer – P2P Music Sharing Network").version("1.0.0");

/**
 * `start` command:
 *   - --no-local-storage: run as relay-only (no IPFS)
 *   - --web-server: start Express WebServer op port 3001
 */
program
  .command("start")
  .description("Start the Vinyl Peer node")
  .option("--no-local-storage", "Disable local IPFS storage (relay-only mode)")
  .option("--web-server", "Start the web server for browser interface")
  .action(async (options) => {
    console.log("🎵 Starting Vinyl Peer node...");
    const cliManager = new CLIManager();

    try {
      // Maak plugin‐instanties
      const musicPlugin = new MusicPlugin();
      const analyticsPlugin = new AnalyticsPlugin();

      // Start Vinyl met beide plugins
      const success = await cliManager.start(
        [musicPlugin, analyticsPlugin],
        options.localStorage !== false,
      );
      if (!success) {
        console.error("❌ Failed to start node");
        process.exit(1);
      }

      console.log("✅ Node started successfully!");
      console.log(`📋 Node ID: ${cliManager.getNodeId()}`);

      // Optioneel: start WebServer
      let webServer: WebServer | null = null;
      if (options.webServer) {
        webServer = new WebServer(cliManager.vinyl);
        await webServer.start();
        console.log("🌐 Web server started at http://localhost:3001");
      }

      // Log alle node+plugin events naar console
      cliManager.onEvent((evt, data) => {
        console.log(`[Event] ${evt}:`, data);
      });

      // Houd de process alive tot SIGINT
      process.on("SIGINT", async () => {
        console.log("\n🛑 Shutting down...");
        if (webServer) {
          await webServer.stop();
        }
        await cliManager.stop();
        process.exit(0);
      });
    } catch (err: any) {
      console.error("❌ Failed to start node:", err.message);
      process.exit(1);
    }
  });

/**
 * `upload <file>`: upload een bestand vanaf schijf.
 *  -o, --storage-mode <ipfs|p2p-stream> (default: ipfs)
 */
program
  .command("upload <file>")
  .description("Upload a file to the network")
  .option("-s, --storage-mode <mode>", "Storage mode (ipfs or p2p-stream)", "ipfs")
  .action(async (filePath: string, options: any) => {
    try {
      const resolvedPath = path.resolve(filePath);
      if (!fs.existsSync(resolvedPath)) {
        console.error(`❌ File not found: ${resolvedPath}`);
        process.exit(1);
      }

      const cliManager = new CLIManager();
      // Voor een enkele upload gebruiken we GEEN plugins, enkel lokale opslag
      await cliManager.start([], true);

      console.log(`📤 Uploading ${resolvedPath}...`);
      const fileBuffer = fs.readFileSync(resolvedPath);
      const fileName = path.basename(resolvedPath);
      const fileMime = (mime.lookup(fileName) as string) || "application/octet-stream";

      const nodeFile = new NodeFile(fileBuffer, fileName, fileMime);
      const cid = await cliManager.uploadFile(
        nodeFile,
        options.storageMode as "ipfs" | "p2p-stream",
      );
      console.log(`✅ File uploaded successfully!`);
      console.log(`📋 CID: ${cid}`);

      await cliManager.stop();
    } catch (err: any) {
      console.error(`❌ Upload failed: ${err.message}`);
      process.exit(1);
    }
  });

/**
 * `download <cid> <output>`: download een bestand naar een lokaal pad.
 */
program
  .command("download <cid> <output>")
  .description("Download a file from the network")
  .action(async (cid: string, output: string) => {
    try {
      const resolvedPath = path.resolve(output);
      const cliManager = new CLIManager();

      // Geen plugins nodig om te downloaden; wel lokale opslag nodig
      await cliManager.start([], true);

      console.log(`📥 Downloading ${cid} to ${resolvedPath}...`);
      const data = await cliManager.downloadFile(cid);
      if (data) {
        fs.writeFileSync(resolvedPath, data);
        console.log("✅ File downloaded successfully!");
      } else {
        console.error("❌ Failed to download file (no data)");
      }

      await cliManager.stop();
    } catch (err: any) {
      console.error(`❌ Download failed: ${err.message}`);
      process.exit(1);
    }
  });

/**
 * `search <query>`: zoek in het netwerk naar bestanden.
 */
program
  .command("search <query>")
  .description("Search for files in the network")
  .action(async (query: string) => {
    try {
      console.log(`🔍 Searching for "${query}"...`);
      const cliManager = new CLIManager();
      // Om te zoeken is alleen lokale opslag & netwerk nodig
      await cliManager.start([], true);

      const results = await cliManager.searchFiles(query);
      console.log(`✅ Found ${results.length} results:\n`);
      results.forEach((file, idx) => {
        console.log(`${idx + 1}. ${file.name} (CID: ${file.cid})`);
        if ((file.metadata as any)?.artist) {
          console.log(`   Artist: ${(file.metadata as any).artist}`);
        }
        if ((file.metadata as any)?.album) {
          console.log(`   Album: ${(file.metadata as any).album}`);
        }
        console.log(`   Size: ${file.size} bytes`);
        console.log(`   Type: ${file.type}`);
        console.log(`   Peer: ${file.peerId.substring(0, 16)}...`);
        console.log(`   Availability: ${file.availability}\n`);
      });

      await cliManager.stop();
    } catch (err: any) {
      console.error(`❌ Search failed: ${err.message}`);
      process.exit(1);
    }
  });

/**
 * `pin <cid>`: pin een bestand lokaal in IPFS.
 */
program
  .command("pin <cid>")
  .description("Pin a file to keep it in local storage")
  .action(async (cid: string) => {
    try {
      console.log(`📌 Pinning ${cid}…`);
      const cliManager = new CLIManager();
      await cliManager.start([], true);

      await cliManager.pinFile(cid);
      console.log("✅ File pinned successfully!");

      await cliManager.stop();
    } catch (err: any) {
      console.error(`❌ Pin failed: ${err.message}`);
      process.exit(1);
    }
  });

/**
 * `unpin <cid>`: unpin een bestand uit lokale IPFS.
 */
program
  .command("unpin <cid>")
  .description("Unpin a file from local storage")
  .action(async (cid: string) => {
    try {
      console.log(`🗑️ Unpinning ${cid}…`);
      const cliManager = new CLIManager();
      await cliManager.start([], true);

      await cliManager.unpinFile(cid);
      console.log("✅ File unpinned successfully!");

      await cliManager.stop();
    } catch (err: any) {
      console.error(`❌ Unpin failed: ${err.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
