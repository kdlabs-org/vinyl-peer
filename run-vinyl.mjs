import { Vinyl } from "./packages/vinyl-peer-protocol/dist/esm/index.js";
import { MusicPlugin } from "./packages/vinyl-peer-plugin-music/dist/esm/index.js";
import { AnalyticsPlugin } from "./packages/vinyl-peer-plugin-analytics/dist/esm/index.js";
import { ReplicationPlugin } from "./packages/vinyl-peer-plugin-replication/dist/esm/index.js";
import { ReedSolomonPlugin } from "./packages/vinyl-peer-plugin-rs/dist/esm/index.js";
import { NameServicePlugin } from "./packages/vinyl-peer-plugin-name-service/dist/esm/index.js";
import { SdkGeneratorPlugin } from "./packages/vinyl-peer-plugin-sdk-generator/dist/esm/index.js";
import { VPlugin } from "./packages/vinyl-peer-plugin-v/dist/esm/VPlugin.js";
import { MonitorPlugin } from "./packages/vinyl-peer-plugin-monitor/dist/esm/index.js";
import { AutoReplicationPlugin } from "./packages/vinyl-peer-plugin-auto-replication/dist/esm/index.js";
import { AdvancedShardingPlugin } from "./packages/vinyl-peer-plugin-advanced-sharding/dist/esm/index.js";

async function main() {
  // 1) Instantiate Vinyl with only the “normal” plugins (no SDK‐generator yet)
  const vinyl = new Vinyl([
    new MusicPlugin(),
    new AnalyticsPlugin(),
    new NameServicePlugin(),
    new ReplicationPlugin(),
    new MonitorPlugin(),
    new ReedSolomonPlugin(),
    new VPlugin(),
    new AutoReplicationPlugin(),
    new AdvancedShardingPlugin()
  ]);

  // 2) Initialize (this starts libp2p, Helia, plugin.initialize + plugin.start() for each)
  const ok = await vinyl.initialize(true /* enable local IPFS storage */, []);
  if (!ok) {
    console.error("❌ Vinyl failed to initialize");
    process.exit(1);
  }

  console.log("✅ Vinyl node is up!");
  console.log(`   • Node ID: ${vinyl.getNodeStats().id}`);
  console.log(
    `   • Storage: ${
      vinyl.getNodeStats().storageAvailable > 0 ? "IPFS enabled" : "relay-only"
    }`
  );

  // 3) Start the HTTP server (this mounts core‐routes + plugin‐routes into httpApp._router.stack)
  await vinyl.startHttp(3001);
  console.log("🌐 HTTP server listening at http://localhost:3001");

  //  —— Now that all core‐routes and plugin‐routes are fully in httpApp._router.stack,
  //      register-and-start the SDK generator so it will see **every** route:
  const sdkPlugin = new SdkGeneratorPlugin({ outputDir: "generated-sdk" });
  await vinyl.getPluginManager().registerPlugin(sdkPlugin);
  await sdkPlugin.start();
  console.log("✅ SDK generated in ./generated-sdk");

  // 4) Wire up a console‐logger for every Vinyl event, and graceful shutdown
  vinyl.onEvent((eventName, data) => {
    console.log(`[event] ${eventName}:`, data);
  });

  const shutdown = async () => {
    console.log("\n🛑 Shutting down Vinyl...");
    try {
      await vinyl.stopHttp();
      console.log("✅ HTTP server stopped.");
    } catch (err) {
      console.error("Error stopping HTTP server:", err);
    }
    try {
      await vinyl.stop();
      console.log("✅ Vinyl node stopped.");
    } catch (err) {
      console.error("Error stopping Vinyl node:", err);
    }
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error in run-vinyl:", err);
  process.exit(1);
});
