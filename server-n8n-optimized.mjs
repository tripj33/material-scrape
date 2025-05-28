// server-n8n-optimized.mjs - Optimized for n8n making 3000 individual API calls
import express from 'express';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import genericPool from 'generic-pool';
import PQueue from 'p-queue';
import ngrok from 'ngrok';
import fs from 'fs/promises';
import path from 'path';

// Apply stealth plugin
puppeteer.use(StealthPlugin());

// CRITICAL: Memory limits for handling 3000 individual n8n requests
const MEMORY_LIMITS = {
  MAX_HEAP: '1536m',
  SCREENSHOT_QUALITY: 60,     // Very low quality for memory conservation
  SCREENSHOT_WIDTH: 1280,      // Smaller screenshots
  SCREENSHOT_HEIGHT: 900,
  MAX_PAGES: 1,              // Single page only
  PAGE_TIMEOUT: 25000,       // Shorter timeouts
  NAVIGATION_TIMEOUT: 20000,
  RESTART_THRESHOLD: 700,    // Restart at 700MB (very conservative)
  MAX_REQUESTS_BEFORE_RESTART: 500, // Restart after 500 requests
  GC_FREQUENCY: 10,          // Force GC every 10 requests
  QUEUE_CONCURRENCY: 1,      // Process one at a time
  REQUEST_TIMEOUT: 45000     // 45 second max per request
};

let requestCount = 0;
let lastGC = 0;

// Aggressive garbage collection
const gcInterval = setInterval(() => {
  if (typeof global.gc === 'function') {
    global.gc();
    const mem = process.memoryUsage();
    console.log(`🧹 Scheduled GC: ${Math.round(mem.heapUsed / 1024 / 1024)}MB heap`);
  }
}, 20000); // Every 20 seconds

// Memory monitoring with automatic restart
function getMemoryStats() {
  const mem = process.memoryUsage();
  return {
    rss: Math.round(mem.rss / 1024 / 1024),
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    external: Math.round(mem.external / 1024 / 1024)
  };
}

function isMemoryCritical() {
  const mem = getMemoryStats();
  return mem.heapUsed > MEMORY_LIMITS.RESTART_THRESHOLD || 
         mem.rss > (MEMORY_LIMITS.RESTART_THRESHOLD + 200);
}

// URL validation
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

// Minimal ngrok connection
async function connectToNgrok() {
  try {
    console.log('🔗 Connecting to ngrok...');
    const url = await ngrok.connect({
      addr: 3000,
      authtoken: process.env.NGROK_AUTH_TOKEN
    });
    console.log(`🔗 Tunnel: ${url}`);
    return url;
  } catch (err) {
    console.error('❌ ngrok error:', err.message);
    return 'http://localhost:3000';
  }
}

// Ultra-minimal cookie dismissal
async function dismissCookies(page) {
  if (!page || page._isClosed) return;
  
  try {
    // Only try the most essential selectors
    const selectors = ['[aria-label*="Accept"]', '.cookie-accept', '#cookie-accept'];
    
    for (const selector of selectors) {
      if (page._isClosed) return;
      try {
        const element = await page.$(selector);
        if (element) {
          await element.click();
          return; // Exit immediately after first successful click
        }
      } catch (e) {
        // Continue to next
      }
    }
  } catch (e) {
    // Ignore all errors to save memory
  }
}

(async () => {
  const app = express();
  app.use(express.json({ limit: '500kb' })); // Very small limit

  let browser = null;
  let pagePool = null;
  let isRestarting = false;
  let restartAttempts = 0;
  const MAX_RESTART_ATTEMPTS = 3;

  // Minimal browser initialization
  async function initializeBrowser() {
    try {
      console.log('🚀 Launching browser for n8n requests...');
      
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=TranslateUI,VizDisplayCompositor',
          '--disable-ipc-flooding-protection',
          '--memory-pressure-off',
          '--max_old_space_size=1536',
          '--single-process',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
          '--disable-background-networking',
          '--disable-client-side-phishing-detection',
          '--disable-default-apps',
          '--disable-extensions',
          '--disable-hang-monitor',
          '--disable-popup-blocking',
          '--disable-prompt-on-repost',
          '--disable-sync',
          '--metrics-recording-only',
          '--no-default-browser-check',
          '--safebrowsing-disable-auto-update',
          `--window-size=${MEMORY_LIMITS.SCREENSHOT_WIDTH},${MEMORY_LIMITS.SCREENSHOT_HEIGHT}`
        ],
        ignoreHTTPSErrors: true,
        timeout: 20000
      });
      
      browser.on('disconnected', handleBrowserCrash);
      console.log('✅ Browser ready for n8n');
      
      createPagePool();
      restartAttempts = 0;
      return browser;
    } catch (error) {
      console.error('Browser launch failed:', error);
      throw error;
    }
  }

  // Single page pool for n8n requests
  function createPagePool() {
    pagePool = genericPool.createPool({
      create: async () => {
        if (!browser || !browser.isConnected()) {
          throw new Error('Browser not connected');
        }
        
        const page = await browser.newPage();
        page._poolId = `n8n_${Date.now()}`;
        page._created = Date.now();
        
        // Minimal page setup
        await page.setDefaultNavigationTimeout(MEMORY_LIMITS.NAVIGATION_TIMEOUT);
        await page.setViewport({ 
          width: MEMORY_LIMITS.SCREENSHOT_WIDTH, 
          height: MEMORY_LIMITS.SCREENSHOT_HEIGHT 
        });
        
        // Block everything except HTML and scripts
        await page.setRequestInterception(true);
        page.on('request', (request) => {
          const resourceType = request.resourceType();
          const allowedTypes = ['document', 'script'];
          
          if (allowedTypes.includes(resourceType)) {
            request.continue();
          } else {
            request.abort();
          }
        });
        
        page.on('error', () => {
          page._hasError = true;
        });
        
        page.on('close', () => {
          page._isClosed = true;
        });
        
        console.log(`📄 Created page: ${page._poolId}`);
        return page;
      },
      destroy: async (page) => {
        try {
          if (page && !page._isClosed) {
            await page.close();
          }
        } catch (error) {
          console.error(`Page destruction error: ${error.message}`);
        }
      },
      validate: (page) => {
        const isValid = page && 
                       !page._isClosed && 
                       !page._hasError &&
                       browser && 
                       browser.isConnected() &&
                       (Date.now() - page._created) < 300000; // 5 minute max age
        
        if (!isValid && page) {
          console.warn(`Page validation failed: ${page._poolId}`);
        }
        return isValid;
      }
    }, {
      max: 1,
      min: 1,
      idleTimeoutMillis: 60000,    // 1 minute idle timeout
      acquireTimeoutMillis: 10000, // 10 second acquire timeout
      testOnBorrow: true,
      testOnReturn: true
    });
    
    return pagePool;
  }

  // Fast browser crash handling
  async function handleBrowserCrash() {
    if (isRestarting) return;
    
    isRestarting = true;
    restartAttempts++;
    
    if (restartAttempts > MAX_RESTART_ATTEMPTS) {
      console.error('❌ Max restarts reached. Process will exit.');
      process.exit(1);
    }
    
    console.log(`🔄 Browser restart ${restartAttempts}/${MAX_RESTART_ATTEMPTS}`);
    
    try {
      // Quick cleanup
      if (pagePool) {
        await pagePool.drain().catch(() => {});
        await pagePool.clear().catch(() => {});
      }
      
      if (browser) {
        await browser.close().catch(() => {});
      }
      
      // Force GC
      if (typeof global.gc === 'function') {
        global.gc();
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      await initializeBrowser();
      
      isRestarting = false;
      console.log('🔄 Browser restarted for n8n');
    } catch (error) {
      console.error('Restart failed:', error);
      isRestarting = false;
      setTimeout(handleBrowserCrash, 3000);
    }
  }

  await initializeBrowser();

  // Single-request queue for n8n
  const queue = new PQueue({ 
    concurrency: MEMORY_LIMITS.QUEUE_CONCURRENCY,
    timeout: MEMORY_LIMITS.REQUEST_TIMEOUT,
    throwOnTimeout: true
  });

  // Monitor queue size (n8n might send requests faster than we can process)
  setInterval(() => {
    if (queue.size > 10) {
      console.warn(`⚠️ Queue backing up: ${queue.size} pending, ${queue.pending} processing`);
    }
  }, 5000);

  // Ultra-fast scrape job for n8n
  async function runScrapeJob(context) {
    requestCount++;
    const jobId = `req_${requestCount}`;
    
    // Force GC periodically
    if (requestCount % MEMORY_LIMITS.GC_FREQUENCY === 0) {
      if (typeof global.gc === 'function') {
        global.gc();
        console.log(`🧹 Forced GC after ${requestCount} requests`);
      }
    }
    
    // Memory check
    if (isMemoryCritical()) {
      console.warn(`⚠️ Memory critical at request ${requestCount}, forcing restart`);
      setTimeout(handleBrowserCrash, 100);
      throw new Error('Memory critical - restart initiated');
    }
    
    // Auto-restart after many requests
    if (requestCount >= MEMORY_LIMITS.MAX_REQUESTS_BEFORE_RESTART) {
      console.log(`🔄 Planned restart after ${requestCount} requests`);
      setTimeout(() => {
        requestCount = 0;
        handleBrowserCrash();
      }, 100);
    }
    
    if (!context.url || !isValidUrl(context.url)) {
      return { 
        data: JSON.stringify({ 
          success: false, 
          error: `Invalid URL: ${context.url}` 
        }), 
        type: 'application/json' 
      };
    }
    
    let page = null;
    let pageAcquired = false;
    
    try {
      // Quick page acquisition
      page = await pagePool.acquire();
      pageAcquired = true;
      
      const result = await fastScraper(page, context, jobId);
      return result;
    } catch (error) {
      console.error(`${jobId} error: ${error.message}`);
      return { 
        data: JSON.stringify({ success: false, error: error.message }), 
        type: 'application/json' 
      };
    } finally {
      if (pageAcquired && page && !page._isClosed) {
        try {
          // Minimal cleanup
          await page.evaluate(() => {
            // Clear only essential memory
            if (typeof window.gc === 'function') window.gc();
          }).catch(() => {});
          
          await pagePool.release(page);
        } catch (e) {
          console.error(`${jobId} cleanup error: ${e.message}`);
        }
      }
    }
  }

  // Ultra-minimal scraper for n8n requests
  async function fastScraper(page, context, jobId) {
    const { url } = context;
    
    if (page._isClosed) {
      throw new Error('Page closed');
    }
    
    console.log(`🔍 ${jobId}: ${url}`);
    
    try {
      // Minimal setup
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
      
      // Fast navigation
      await page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: MEMORY_LIMITS.PAGE_TIMEOUT
      });
      
      // Minimal wait
      await new Promise(r => setTimeout(r, 500));
      
      // Quick cookie dismissal
      await dismissCookies(page);
      
      // Take low-quality screenshot immediately
      if (page._isClosed) {
        throw new Error('Page closed before screenshot');
      }
      
      const screenshot = await page.screenshot({ 
        type: 'jpeg',
        quality: MEMORY_LIMITS.SCREENSHOT_QUALITY,
        fullPage: false,
        clip: {
          x: 0, 
          y: 0, 
          width: MEMORY_LIMITS.SCREENSHOT_WIDTH, 
          height: MEMORY_LIMITS.SCREENSHOT_HEIGHT
        }
      });
      
      console.log(`✅ ${jobId}: ${screenshot.length} bytes`);
      return { data: screenshot, type: 'image/jpeg' };
      
    } catch (error) {
      console.error(`❌ ${jobId}: ${error.message}`);
      return { 
        data: JSON.stringify({ success: false, error: error.message }), 
        type: 'application/json' 
      };
    }
  }

  // n8n-optimized scrape endpoint
  app.post('/scrape', async (req, res) => {
    const startTime = Date.now();
    
    try {
      if (!req.body.url) {
        return res.status(400).json({ success: false, error: "URL required" });
      }
      
      if (!isValidUrl(req.body.url)) {
        return res.status(400).json({ 
          success: false, 
          error: `Invalid URL: ${req.body.url}` 
        });
      }
      
      const result = await queue.add(() => runScrapeJob(req.body));
      
      if (result.type.startsWith('image/')) {
        const imageBase64 = result.data.toString('base64');
        const duration = Date.now() - startTime;
        
        return res.json({ 
          success: true, 
          mimeType: result.type, 
          imageBase64,
          processingTime: duration,
          requestNumber: requestCount
        });
      }
      
      if (result.type === 'application/json') {
        const errorData = JSON.parse(result.data);
        return res.status(errorData.success ? 200 : 400).json(errorData);
      }
      
      return res.status(400).json({ 
        success: false, 
        error: 'Unexpected result type' 
      });
    } catch (err) {
      console.error(`Request failed: ${err.message}`);
      
      // Auto-restart on certain errors
      if (err.message.includes('timeout') || 
          err.message.includes('memory') ||
          err.message.includes('Target closed')) {
        setTimeout(handleBrowserCrash, 100);
      }
      
      return res.status(500).json({ 
        success: false, 
        error: err.message 
      });
    }
  });

  // Health check for n8n monitoring
  app.get('/healthz', async (req, res) => {
    const mem = getMemoryStats();
    const browserConnected = browser && browser.isConnected();
    
    res.json({
      status: browserConnected && !isMemoryCritical() ? 'healthy' : 'unhealthy',
      browser: browserConnected ? 'connected' : 'disconnected',
      memory: mem,
      memoryOk: !isMemoryCritical(),
      requests: requestCount,
      queueSize: queue.size,
      queuePending: queue.pending,
      restarting: isRestarting,
      uptime: Math.round(process.uptime())
    });
  });

  // Status endpoint for n8n
  app.get('/status', (req, res) => {
    res.json({
      ready: !isRestarting && browser && browser.isConnected(),
      requests: requestCount,
      memory: getMemoryStats(),
      queue: {
        waiting: queue.size,
        processing: queue.pending
      }
    });
  });

  // Memory monitoring with aggressive restart
  setInterval(async () => {
    const mem = getMemoryStats();
    
    if (isMemoryCritical()) {
      console.log(`⚠️ Memory critical: ${mem.heapUsed}MB heap, ${mem.rss}MB RSS`);
      
      // Only restart if no requests are currently processing
      if (queue.pending === 0) {
        console.log('🔄 Initiating memory-based restart');
        await handleBrowserCrash();
      }
    }
  }, 10000); // Check every 10 seconds

  // Start server
  const server = app.listen(3000, async () => {
    console.log('🟢 n8n-optimized server running on :3000');
    console.log(`📊 Memory limits: ${MEMORY_LIMITS.RESTART_THRESHOLD}MB restart threshold`);
    console.log(`🔄 Auto-restart after ${MEMORY_LIMITS.MAX_REQUESTS_BEFORE_RESTART} requests`);
    console.log(`⚡ Optimized for n8n individual API calls`);
    
    try {
      const url = await connectToNgrok();
      console.log(`🌐 Available for n8n at: ${url}/scrape`);
    } catch (err) {
      console.error('❌ ngrok error:', err);
    }
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('🔴 Shutting down...');
    
    server.close();
    queue.pause();
    
    if (queue.pending > 0) {
      console.log('⏳ Waiting for current requests to finish...');
      await queue.onIdle();
    }
    
    if (pagePool) {
      await pagePool.drain().catch(() => {});
      await pagePool.clear().catch(() => {});
    }
    
    if (browser) {
      await browser.close().catch(() => {});
    }
    
    console.log('✅ Shutdown complete');
    process.exit(0);
  });

  // Handle memory errors immediately
  process.on('uncaughtException', async (error) => {
    console.error('💥 Uncaught exception:', error.message);
    
    if (error.message.includes('out of memory') || 
        error.message.includes('heap') ||
        error.message.includes('allocation failed') ||
        error.message.includes('Maximum call stack')) {
      console.log('🔄 Fatal memory error, forcing restart');
      process.exit(1); // Let process manager restart us
    } else {
      await handleBrowserCrash();
    }
  });

  process.on('unhandledRejection', (reason) => {
    console.error('💥 Unhandled rejection:', reason);
  });

})();