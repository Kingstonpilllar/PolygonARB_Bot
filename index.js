require("dotenv").config();

function startModule(name, modulePath) {
  const start = () => {
    console.log(`🚀 Starting ${name}...`);
    try {
      require(modulePath);
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
startModule("Data Provider (WebSocket)", "./dataProvider.js");

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
