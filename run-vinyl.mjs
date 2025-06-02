import { Vinyl } from "./packages/vinyl-peer-protocol/dist/esm/index.js";
import { MusicPlugin } from "./packages/vinyl-peer-plugin-music/dist/esm/index.js";
import { AnalyticsPlugin } from "./packages/vinyl-peer-plugin-analytics/dist/esm/index.js";
import { ReplicationPlugin } from "./packages/vinyl-peer-plugin-replication/dist/esm/index.js";

async function main() {
  // 1) Instantiate Vinyl with Music, Analytics, and Replication plugins
  const vinyl = new Vinyl([
    new MusicPlugin(),
    new AnalyticsPlugin(),
    new ReplicationPlugin(),
  ]);

  // 2) Initialize the node (starts libp2p, Helia, and registers/plugins)
  const ok = await vinyl.initialize(true, []);
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

  // 3) Start Vinyl’s built-in HTTP server on port 3001
  //    This will log each plugin’s mounted route as it goes.
  await vinyl.startHttp(3001);
  console.log("🌐 HTTP server listening at http://localhost:3001");

  // 4) Forward all Vinyl events to the console
  vinyl.onEvent((eventName, data) => {
    // Uncomment the next line if you want to log every event:
    console.log(`[event] ${eventName}:`, data);
  });

  // 5) Clean up on SIGINT or SIGTERM: stop both HTTP server and Vinyl node
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
