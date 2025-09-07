import fs from "fs";
import axios from "axios";

// List of 10 Polygon DEXes (GraphQL endpoints)
const routers = {
  uniswap: 'https://api.thegraph.com/subgraphs/name/ianlapham/uniswap-v2',
  sushiswap: 'https://api.thegraph.com/subgraphs/name/sushiswap/exchange',
  quickswap: 'https://api.thegraph.com/subgraphs/name/quickswap/quick_swap_v3',
  curve: 'https://api.thegraph.com/subgraphs/name/curvefi/curve-polygon',
  balancer: 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-polygon',
  dfyn: 'https://api.thegraph.com/subgraphs/name/dfyn/dfyn-polygon',
  saddle: 'https://api.thegraph.com/subgraphs/name/saddle-finance/saddle-polygon',
  pancake: 'https://api.thegraph.com/subgraphs/name/pancakeswap/pancakeswap-polygon',
  inch: 'https://api.thegraph.com/subgraphs/name/1inch-exchange/1inch-polygon',
  v3: 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3-polygon'
};

// File to save router data
const ROUTERS_FILE = './routers.json';

// Fetch top 200 tokens from CoinGecko by market cap
async function fetchTopTokens() {
  const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=200&page=1';
  const res = await axios.get(url);
  return res.data.map(token => ({
    symbol: token.symbol.toUpperCase(),
    coingeckoId: token.id
  }));
}

// Helper function to fetch data from GraphQL endpoint
async function fetchRouterData(routerUrl, tokenSymbol) {
  const query = `
  {
    pairs(first: 5) {
      id
      token0 {
        symbol
        id
      }
      token1 {
        symbol
        id
      }
      token0Price
      token1Price
    }
  }`;

  try {
    const res = await axios.post(routerUrl, { query });
    const pairs = res.data.data.pairs;
    return pairs.filter(pair =>
      (pair.token0.symbol === tokenSymbol || pair.token1.symbol === tokenSymbol)
    );
  } catch (err) {
    console.error(`Error fetching data for ${tokenSymbol} from ${routerUrl}:`, err);
    return [];
  }
}

// Helper function to get the best price from all routers
async function getBestPrice(tokenSymbol) {
  const prices = [];
  for (const [routerName, routerUrl] of Object.entries(routers)) {
    const pairs = await fetchRouterData(routerUrl, tokenSymbol);
    pairs.forEach(pair => {
      let price;
      if (pair.token0.symbol === tokenSymbol) {
        price = parseFloat(pair.token0Price);
      } else {
        price = parseFloat(pair.token1Price);
      }

      prices.push({
        router: routerName,
        price,
        pair: pair.id
      });
    });
  }

  // Find the router with the best price (max price)
  const bestPrice = prices.reduce((prev, current) => (prev.price > current.price) ? prev : current, { price: 0 });
  return bestPrice;
}

// Main function to update routers.json
async function updateRouters() {
  const routersData = [];
  const tokens = await fetchTopTokens();  // Fetch top 200 tokens by market cap

  // Loop through all tokens and fetch the best price from each router
  for (const token of tokens) {
    const bestPrice = await getBestPrice(token.symbol);

    routersData.push({
      symbol: token.symbol,
      bestRouter: bestPrice.router,
      price: bestPrice.price,
      pairId: bestPrice.pair
    });
  }

  // Save data to routers.json
  fs.writeFileSync(ROUTERS_FILE, JSON.stringify(routersData, null, 2));
  console.log('✅ routers.json updated successfully!');
}

// Run the update process
updateRouters();

// Optional: Update every 5 minutes
setInterval(updateRouters, 5 * 60 * 1000); // Update every 5 minutes

