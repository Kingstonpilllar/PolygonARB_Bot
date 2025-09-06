require("dotenv").config();

// Load PRIVATE_KEY from .env
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("❌ Error: PRIVATE_KEY is not defined in .env!");
  process.exit(1);
}

function startModule(name, modulePath) {
  const start = () => {
    console.log(`🚀 Starting ${name}...`);
    try {
      // Pass PRIVATE_KEY as an environment variable to the module if needed
      require(modulePath)(PRIVATE_KEY);
      console.log(`✅ ${name} loaded successfully.`);
    } catch (err) {
      console.error(`❌ ${name} crashed:`, err.message);
      console.log(`⏳ Restarting ${name} in 5 seconds...`);
      setTimeout(start, 5000);
    }
  };
  start();
}

// WebSocket provider first
startModule("Data Provider (WebSocket)", "./dataprovider.js");

// WebSocket data suppliers
startModule("Pool Fetcher", "./poolfetcher.js");
startModule("Scanner", "./scanner.js");
startModule("Protection Utilities", "./protectionutilities.js");

// Trading bot
startModule("Hybrid Simulation Bot", "./hybridsimulationbot.js");

// Pool listeners
startModule("Direct Pool listener", "./checkdirectpool.js");
startModule("Tri Pool listener", "./check_tri_pool.js");

console.log("🎯 All services are running. Monitoring trade alerts and supplying pool data...");

