// factories.js (updated with verified addresses where found)

const ABI = {
  UniswapV2Factory: [
    "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
    "function getPair(address tokenA, address tokenB) external view returns (address)",
    "function allPairs(uint256) external view returns (address)",
    "function allPairsLength() external view returns (uint256)"
  ],
  UniswapV3Factory: [
    "event PoolCreated(address indexed token0, address indexed token1, uint24 fee, int24 tickSpacing, address pool)",
    "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address)"
  ],
  AlgebraFactory: [
    "event Pool(address indexed token0, address indexed token1, address pool)",
    "function poolByPair(address tokenA, address tokenB) external view returns (address)"
  ],
  KyberElasticFactory: [
    "event PoolCreated(address indexed token0, address indexed token1, uint24 fee, uint160 sqrtGamma, address pool)",
    "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address)"
  ],
  DODOv3_D3MMFactory: [
    "event NewD3Pool(address indexed creator, address indexed token, address pool)",
    "function getD3Pool(address token) external view returns (address)"
  ],
  BalancerVault: [
    "function getPoolTokens(bytes32 poolId) external view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)"
  ],
  CurveRegistry: [
    "function get_n_coins(address pool) external view returns (uint256)",
    "function find_pool_for_coins(address from, address to) external view returns (address)"
  ]
};

const addr = (address, abiKey) => ({
  address,
  abi: ABI[abiKey] || []
});

const FACTORIES = {
  UniswapV3: addr("0x1F98431c8aD98523631AE4a59f267346ea31F984", "UniswapV3Factory"), // Verified from Uniswap docs 0

  QuickSwapV2: addr("0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32", "UniswapV2Factory"), // Verified QuickSwap V2 factory 1

  QuickSwapV3: addr("0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28", "AlgebraFactory"), // QuickSwap V3 (Algebra) factory 2

  BalancerV2: addr("0xBA12222222228d8Ba445958a75a0704d566BF2C8", "BalancerVault"), // Balancer V2 Vault 3

  Clipper: { address: null, abi: [] }, // No standard factory

  SushiSwapV2: addr("0xc35DADB65012eC5796536bD9864eD8773aBc74C4", "UniswapV2Factory"), // Verified SushiSwap V2 on Polygon

  SushiSwapV3: addr("0x9179338983A964aF39bDd8e90aCaE3D9f86b49fA", "UniswapV3Factory"), // Verified SushiSwap V3

  PearlFi: { address: null, abi: ABI.UniswapV2Factory }, // Factory address not publicly found

  Retro: { address: null, abi: ABI.UniswapV2Factory }, // Factory address not publicly found

  DODOv3: addr("0xFeAFe253802b77456B4627F8c2306a9CeBb5d681", "DODOv3_D3MMFactory"), // Verified DODO v3 4

  CrowdSwap: { address: null, abi: [] }, // Aggregator

  DOOAR: { address: null, abi: ABI.UniswapV2Factory }, // Not publicly documented

  KyberElastic: addr("0xC7a590291e07B9fe9E64b86c58fD8fC764308C4A", "KyberElasticFactory"), // Verified KyberSwap Elastic 5

  Curve: { address: null, abi: ABI.CurveRegistry }, // Registry address not found

  Firebird: { address: null, abi: [] }, // Aggregator / no standard factory

  ComethSwap: addr("0x11BFd590f592457b65Eb85327F5938141f61878a", "UniswapV2Factory"), // From 1inch spot-price oracle listing 6

  PolycatFinance: addr("0x477Ce834Ae6b7aB003cCe4BC4d8697763FF456FA", "UniswapV2Factory"), // Verified from ecosystem explorer

  OneInch: { address: null, abi: [] }, // Aggregator

  Matcha: { address: null, abi: [] }, // Aggregator

  OpenOcean: { address: null, abi: [] } // Aggregator
};

module.exports = { ABI, FACTORIES };
