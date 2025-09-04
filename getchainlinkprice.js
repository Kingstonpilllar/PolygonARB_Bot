const { ethers } = require('ethers');
const chainlinkFeeds = require('./chainlinkpricefeed.json');

const provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');
const contractABI = [
  "function latestAnswer() view returns (int256)"
];

async function getChainlinkPrice(token) {
  const feedAddress = chainlinkFeeds[token].feedAddress;
  const contract = new ethers.Contract(feedAddress, contractABI, provider);
  const price = await contract.latestAnswer();
  return ethers.utils.formatUnits(price, 8);  // Chainlink feeds return price with 8 decimal points
}

async function getPrices() {
  const usdtPrice = await getChainlinkPrice('USDT');
  console.log("USDT Price from Chainlink:", usdtPrice);
  
  const daiPrice = await getChainlinkPrice('DAI');
  console.log("DAI Price from Chainlink:", daiPrice);
  
  const maticPrice = await getChainlinkPrice('MATIC');
  console.log("MATIC Price from Chainlink:", MATICPrice);
  
  const usdcPrice = await getChainlinkPrice('USDC');
  console.log("USDC Price from Chainlink:", usdcPrice);
  
  const wethPrice = await getChainlinkPrice('WETH');
  console.log("WETH Price from Chainlink:", wethPrice);
}

getPrices();
