// index.js — ESM version for ethers v6
// Ensure package.json has: { "type": "module" }

import 'dotenv/config';

function startModule(name, modulePath) {
  const start = async () => {
    console.log(`🚀 Starting ${name}...`);
    try {
      // Dynamic import (side-effect start), same behavior as require(modulePath)
      await import(modulePath);
      console.log(`✅ ${name} loaded successfully.`);
    } catch (err) {
      console.error(`❌ ${name} crashed:`, err?.message || err);
      console.log(`⏳ Restarting ${name} in 5 seconds...`);
      setTimeout(start, 5000);
    }
  };
  start();
}

// RPC provider first
startModule('Data Provider (RPC)', './dataprovider.js');

// WebSocket data suppliers
startModule('Pool Fetcher', './poolfetcher.js');
startModule('Scanner', './scanner.js');
startModule('Protection Utilities', './protectionutilities.js');

// Trading bot
startModule('Hybrid Simulation Bot', './hybridsimulationbot.js');

// Pool listeners
startModule('Direct Pool listener', './checkdirectpool.js');
startModule('Tri Pool listener', './check_tri_pool.js');

console.log('🎯 All services are running. Monitoring trade alerts and supplying pool data...');

