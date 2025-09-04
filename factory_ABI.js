// factory_ABI.js
// Polygon-only factory ABIs & addresses
// Safe for your current poolfetcher.js (which requires UniswapV2-like factories)

// --- ABIs ---
const FactoryABIs = {
  // Uniswap V2-style factory ABI (used by many Polygon V2 DEXes)
  uniswapV2Factory: [
    "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
    "function getPair(address tokenA, address tokenB) external view returns (address pair)",
    "function allPairs(uint256) external view returns (address pair)",
    "function allPairsLength() external view returns (uint256)",
    "function feeTo() external view returns (address)",
    "function feeToSetter() external view returns (address)",
    "function createPair(address tokenA, address tokenB) external returns (address pair)"
  ],

  // Included for completeness; NOT used by poolfetcher (no allPairsLength)
  // (kept empty so poolfetcher will skip V3/Algebra by design)
  uniswapV3Factory: [],
  algebraFactory: [],
  dodoV3Factory: []
};

// --- FACTORIES (Polygon) ---
// Keys MUST match names in your dexconfig.json (dexConfig.polygon[].name)
const FACTORIES = {
  // ✅ ENABLED (V2-style)
  "QuickSwap V2": {
    address: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32",
    abi: FactoryABIs.uniswapV2Factory
  },
  "SushiSwap V2": {
    address: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
    abi: FactoryABIs.uniswapV2Factory
  },
  "ComethSwap": {
    address: "0x800b052609c355cA8103E06F022aa30647eAd60a",
    abi: FactoryABIs.uniswapV2Factory
  },
  "Polycat Finance": {
    address: "0x8D5Ed43dca87F6f93E2cb3e29aE1E4ACd77F6d09",
    abi: FactoryABIs.uniswapV2Factory
  },

  // ❌ SKIPPED BY poolfetcher (no V2 enumeration ABI)
  // (Keep the address for reference; abi: [] makes poolfetcher skip safely)
  "Uniswap V3": {
    address: "0x1F98431c8aD98523631AE4a59f267346ea31F984", // Polygon Uniswap V3 Factory
    abi: [] // V3 not supported by V2 fetcher
  },
  "QuickSwap V3": {
    address: "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28", // Algebra Factory
    abi: [] // Algebra (V3-like) not supported by V2 fetcher
  },
  "KyberSwap Elastic": {
    address: "0xC7a590291e07B9fe9E64b86c58fD8fC764308C4A", // Factory
    abi: [] // Not V2
  },
  "Balancer V2": {
    address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", // Vault (not a pair factory)
    abi: [] // Not V2
  },
  "Curve Finance": {
    address: null,
    abi: [] // Uses registries/pools, not V2 factory
  },
  "DODO": {
    address: "0xFeAFe253802b77456B4627F8c2306a9CeBb5d681", // D3MM Factory
    abi: [] // Not V2
  },
  "Clipper":     { address: null, abi: [] },
  "PearlFi":     { address: null, abi: [] },
  "Retro":       { address: null, abi: [] },
  "CrowdSwap":   { address: null, abi: [] }, // Aggregator
  "DOOAR":       { address: null, abi: [] },
  "Firebird Finance": { address: null, abi: [] }, // Aggregator/AMM mix
  "1inch":       { address: null, abi: [] }, // Aggregator
  "Matcha":      { address: null, abi: [] }, // Aggregator
  "OpenOcean":   { address: null, abi: [] }  // Aggregator
};

module.exports = {
  FactoryABIs,
  FACTORIES
};
