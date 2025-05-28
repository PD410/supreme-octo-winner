// Coinbase to Notion Portfolio Sync - Vercel Serverless Function
// Deploy this to Vercel for automatic portfolio updates

import crypto from 'crypto';

// Environment variables (set in Vercel dashboard)
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID || '1fbf49fa-9eb9-816d-a3f2-cd2f893a541d';
const COINBASE_API_KEY = process.env.COINBASE_API_KEY;
const COINBASE_API_SECRET = process.env.COINBASE_API_SECRET;

// Coinbase API configuration (updated for 2025)
const COINBASE_BASE_URL = 'https://api.coinbase.com/v2';

// Create HMAC signature for Coinbase API authentication
function createCoinbaseSignature(timestamp, method, path, body = '') {
  const message = timestamp + method + path + body;
  return crypto
    .createHmac('sha256', COINBASE_API_SECRET)
    .update(message)
    .digest('hex');
}

// Create authenticated headers for Coinbase API (2025 format)
function createCoinbaseHeaders(method, path, body = '') {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createCoinbaseSignature(timestamp, method, path, body);
  
  return {
    'CB-ACCESS-KEY': COINBASE_API_KEY,
    'CB-ACCESS-TIMESTAMP': timestamp,
    'CB-ACCESS-SIGN': signature,
    'CB-VERSION': '2025-01-01', // Use latest API version
    'Content-Type': 'application/json',
    'User-Agent': 'Notion-Portfolio-Sync/1.0'
  };
}

// Fetch portfolio balances from Coinbase (updated endpoint)
async function fetchCoinbaseBalances() {
  try {
    const path = '/accounts';
    const response = await fetch(`${COINBASE_BASE_URL}${path}`, {
      method: 'GET',
      headers: createCoinbaseHeaders('GET', path)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Coinbase API Error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    
    if (!data.data) {
      throw new Error('Invalid response from Coinbase API');
    }
    
    // Filter and format balances (exclude zero balances and USD unless significant)
    const balances = data.data
      .filter(account => {
        const balance = parseFloat(account.balance.amount);
        const currency = account.currency.code;
        
        // Include if balance > 0 and not USD, or if USD > $1
        return balance > 0 && (currency !== 'USD' || balance > 1);
      })
      .map(account => ({
        asset: account.currency.code,
        balance: parseFloat(account.balance.amount),
        currency: account.currency.code,
        accountId: account.id
      }));
    
    return balances;
  } catch (error) {
    console.error('Error fetching Coinbase balances:', error);
    throw error;
  }
}

// Fetch current crypto prices from Coinbase
async function fetchCryptoPrices(symbols) {
  try {
    const pricePromises = symbols.map(async (symbol) => {
      // Stablecoins and USD have fixed prices
      if (['USD', 'USDC', 'USDT', 'DAI', 'BUSD'].includes(symbol)) {
        return { symbol, price: 1.0, change24h: 0 };
      }
      
      try {
        // Get spot price
        const spotPath = `/exchange-rates?currency=${symbol}`;
        const spotResponse = await fetch(`${COINBASE_BASE_URL}${spotPath}`);
        const spotData = await spotResponse.json();
        
        let price = 0;
        let change24h = 0;
        
        if (spotData.data && spotData.data.rates && spotData.data.rates.USD) {
          price = parseFloat(spotData.data.rates.USD);
        }
        
        // Try to get 24h change (this might require different endpoint)
        try {
          const priceResponse = await fetch(`${COINBASE_BASE_URL}/prices/${symbol}-USD/spot`);
          const priceData = await priceResponse.json();
          if (priceData.data && priceData.data.amount) {
            price = parseFloat(priceData.data.amount);
          }
        } catch (priceError) {
          console.log(`Could not fetch detailed price for ${symbol}:`, priceError.message);
        }
        
        return { symbol, price, change24h };
      } catch (symbolError) {
        console.log(`Error fetching price for ${symbol}:`, symbolError.message);
        return { symbol, price: 0, change24h: 0 };
      }
    });
    
    const prices = await Promise.all(pricePromises);
    return prices.reduce((acc, { symbol, price, change24h }) => {
      acc[symbol] = { price, change24h };
      return acc;
    }, {});
  } catch (error) {
    console.error('Error fetching crypto prices:', error);
    return {};
  }
}

// Get existing Notion database entries
async function getNotionEntries() {
  try {
    const response = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({})
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Notion API Error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.error('Error fetching Notion entries:', error);
    return [];
  }
}

// Create or update Notion database entry
async function upsertNotionEntry(asset, balance, price, change24h) {
  const existingEntries = await getNotionEntries();
  const existingEntry = existingEntries.find(entry => 
    entry.properties.Asset.title[0]?.plain_text === asset
  );
  
  const pageData = {
    properties: {
      Asset: {
        title: [{ text: { content: asset } }]
      },
      Balance: {
        number: balance
      },
      'Current Price': {
        number: price
      },
      '24h Change': {
        number: change24h / 100 // Convert to decimal for percentage format
      },
      Status: {
        select: {
          name: balance > 0 ? 'Active' : 'Zero Balance'
        }
      }
    }
  };
  
  try {
    if (existingEntry) {
      // Update existing entry
      const response = await fetch(`https://api.notion.com/v1/pages/${existingEntry.id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${NOTION_API_KEY}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28'
        },
        body: JSON.stringify(pageData)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to update ${asset}: ${response.status} - ${errorText}`);
      }
      
      return await response.json();
    } else {
      // Create new entry
      const response = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_API_KEY}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28'
        },
        body: JSON.stringify({
          parent: { database_id: NOTION_DATABASE_ID },
          ...pageData
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create ${asset}: ${response.status} - ${errorText}`);
      }
      
      return await response.json();
    }
  } catch (error) {
    console.error(`Error upserting ${asset} entry:`, error);
    throw error;
  }
}

// Main sync function
async function syncPortfolioToNotion() {
  const startTime = Date.now();
  
  try {
    console.log('🚀 Starting Coinbase to Notion sync...');
    
    // Validate environment variables
    if (!NOTION_API_KEY || !COINBASE_API_KEY || !COINBASE_API_SECRET) {
      throw new Error('Missing required environment variables');
    }
    
    // Step 1: Fetch portfolio balances from Coinbase
    console.log('📊 Fetching portfolio balances...');
    const balances = await fetchCoinbaseBalances();
    console.log(`Found ${balances.length} assets with balances`);
    
    if (balances.length === 0) {
      console.log('⚠️  No balances found - check API permissions');
      return {
        success: true,
        message: 'No balances to sync',
        assets: 0,
        duration: Date.now() - startTime
      };
    }
    
    // Step 2: Fetch current prices
    console.log('💰 Fetching current prices...');
    const symbols = balances.map(b => b.asset);
    const prices = await fetchCryptoPrices(symbols);
    
    // Step 3: Update Notion database
    console.log('📝 Updating Notion database...');
    const updatePromises = balances.map(async (balance) => {
      const priceData = prices[balance.asset] || { price: 0, change24h: 0 };
      
      await upsertNotionEntry(
        balance.asset,
        balance.balance,
        priceData.price,
        priceData.change24h
      );
      
      const totalValue = balance.balance * priceData.price;
      console.log(`✅ Updated ${balance.asset}: ${balance.balance} @ $${priceData.price} = $${totalValue.toFixed(2)}`);
    });
    
    await Promise.all(updatePromises);
    
    // Calculate total portfolio value
    const totalValue = balances.reduce((sum, balance) => {
      const price = prices[balance.asset]?.price || 0;
      return sum + (balance.balance * price);
    }, 0);
    
    const duration = Date.now() - startTime;
    console.log(`🎉 Portfolio sync completed in ${duration}ms!`);
    console.log(`💼 Total Portfolio Value: $${totalValue.toLocaleString()}`);
    
    return {
      success: true,
      message: 'Sync completed successfully',
      assets: balances.length,
      totalValue: totalValue,
      duration: duration
    };
    
  } catch (error) {
    console.error('❌ Sync failed:', error);
    return {
      success: false,
      error: error.message,
      duration: Date.now() - startTime
    };
  }
}

// Vercel serverless function handler
export default async function handler(request, response) {
  // Set CORS headers
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Handle preflight requests
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }
  
  // Only allow GET and POST
  if (!['GET', 'POST'].includes(request.method)) {
    return response.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const result = await syncPortfolioToNotion();
    
    // Return appropriate status code
    const statusCode = result.success ? 200 : 500;
    return response.status(statusCode).json(result);
    
  } catch (error) {
    console.error('Handler error:', error);
    return response.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
}

// For local testing
if (process.env.NODE_ENV !== 'production') {
  syncPortfolioToNotion().then(result => {
    console.log('Test run result:', result);
  }).catch(error => {
    console.error('Test run failed:', error);
  });
}
