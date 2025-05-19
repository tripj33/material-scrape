// server.mjs
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

// File to store ngrok tunnel info
const NGROK_CONFIG_FILE = path.join(process.cwd(), 'ngrok_tunnel_info.json');

// Add garbage collection interval
const gcInterval = setInterval(() => {
  if (typeof global.gc === 'function') {
    console.log('Forcing garbage collection...');
    global.gc();
  }
}, 60000); // Force GC every minute

// URL validation function
function isValidUrl(string) {
  try {
    const url = new URL(string);
    // Additional validation: ensure protocol is http or https
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (err) {
    return false;
  }
}
// Connect to ngrok with proper error handling
async function connectToNgrok() {
  try {
    console.log('Checking for existing ngrok tunnels...');
    
    // Try to find existing tunnel first using HTTP request
    try {
      const http = require('http');
      
      // Function to make a simple HTTP request to the ngrok API
      const getNgrokTunnels = () => {
        return new Promise((resolve, reject) => {
          const options = {
            hostname: '127.0.0.1',
            port: 4040,
            path: '/api/tunnels',
            method: 'GET'
          };
          
          const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });
            res.on('end', () => {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                reject(new Error('Failed to parse ngrok API response'));
              }
            });
          });
          
          req.on('error', (e) => {
            reject(e);
          });
          
          req.end();
        });
      };
      
      // Attempt to get tunnels
      const tunnelsResponse = await getNgrokTunnels();
      
      if (tunnelsResponse && tunnelsResponse.tunnels && tunnelsResponse.tunnels.length > 0) {
        const existingTunnel = tunnelsResponse.tunnels[0];
        console.log(`🔗 Found existing ngrok tunnel: ${existingTunnel.public_url}`);
        return existingTunnel.public_url;
      }
    } catch (e) {
      console.log(`No existing tunnel found: ${e.message}`);
    }
    
    // If no existing tunnel found, create a new one
    console.log('Attempting to start ngrok tunnel...');
    
    // Try to disconnect any existing sessions
    await ngrok.disconnect().catch(() => {});
    
    // Start a new tunnel with minimal options
    const url = await ngrok.connect({
      addr: 3000,
      authtoken: process.env.NGROK_AUTH_TOKEN
    });
    
    console.log('🔗 Connected to ngrok tunnel:', url);
    return url;
  } catch (err) {
    console.error('❌ ngrok connection error:', err.message);
    console.log('⚠️ Server running only on local address: http://localhost:3000');
    
    // Return local URL as fallback
    return 'http://localhost:3000';
  }
}

// Helper function for dismissing cookies
async function dismissCookies(page) {
  if (!page || page._isClosed) return;
  
  try {
    // Updated selectors to use valid syntax
    const selectors = [
      '[aria-label="Accept cookies"]',
      '.cookie-accept',
      '#cookie-accept',
      '.cookie-banner button', 
      '[data-cookie-accept]',
      'button.accept-cookies',
      '.consent-btn',
      '#accept-cookies'
    ];
    
    // Try each selector
    let clickedCookie = false;
    
    for (let i = 0; i < selectors.length; i++) {
      if (page._isClosed) return;
      
      try {
        const element = await page.$(selectors[i]);
        if (element) { 
          await element.click();
          await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
          clickedCookie = true;
          return; // Exit the function after successful click
        }
      } catch (selectorError) {
        // Just try the next selector
      }
    }
    
    // Try a more generic approach using document.querySelector
    if (!clickedCookie && !page._isClosed) {
      try {
        const clickResult = await page.evaluate(() => {
          // Find buttons containing text about cookies or accept
          const textPhrases = ['accept', 'Accept', 'agree', 'Agree', 'Cookie', 'cookie'];
          
          for (const phrase of textPhrases) {
            const elements = Array.from(document.querySelectorAll('button, a'))
              .filter(el => el.textContent.includes(phrase) && 
                      el.offsetWidth > 0 && 
                      el.offsetHeight > 0);
            
            if (elements.length > 0) {
              elements[0].click();
              return true;
            }
          }
          return false;
        });
        
        if (clickResult) {
          console.log('Clicked cookie consent using evaluate approach');
        }
      } catch (e) {
        // Ignore errors from this fallback approach
      }
    }
  } catch (e) {
    console.warn(`Error dismissing cookies: ${e.message}`);
  }
}

(async () => {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Store browser instance in a variable we can update
  let browser = null;
  let pagePool = null;
  let isRestarting = false;
  let restartAttempts = 0;
  const MAX_RESTART_ATTEMPTS = 5;
  const RESTART_DELAY = 5000; // 5 seconds

  // Enhanced browser initialization with crash-resistant options
  async function initializeBrowser() {
    try {
      // Launch browser with crash-resistant options
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
          '--disable-infobars',
          '--window-size=1366,768',
          '--ignore-certificate-errors'
        ],
        ignoreHTTPSErrors: true,
        timeout: 60000
      });
      
      // Monitor browser disconnect event
      browser.on('disconnected', async () => {
        console.error('🔥 Browser disconnected! Attempting to restart...');
        await handleBrowserCrash();
      });
      
      console.log('✅ Browser launched successfully');
      
      // Create page pool with enhanced tracking
      createPagePool();
      
      // Set up page health monitoring
      setupPageHealthMonitoring();
      
      restartAttempts = 0; // Reset on successful launch
      return browser;
    } catch (error) {
      console.error('Failed to launch browser:', error);
      throw error;
    }
  }

  // Function to create the page pool with enhanced tracking
  function createPagePool() {
    pagePool = genericPool.createPool({
      create: async () => {
        if (!browser || !browser.isConnected()) {
          throw new Error('Browser not connected');
        }
        
        const page = await browser.newPage();
        
        // Give each page a unique ID for tracking
        page._poolId = `page_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        console.log(`Created new page: ${page._poolId}`);
        
        // Track page lifecycle
        page._lastActivity = Date.now();
        page._inUse = false;
        
        // Monitor page errors and closures more closely
        page.on('error', error => {
          console.error(`Page error on ${page._poolId}:`, error.message);
        });
        
        page.on('close', () => {
          console.warn(`Page closed: ${page._poolId}`);
          // Mark that this page has been closed so we can handle it gracefully
          page._isClosed = true;
        });
        
        // Set default navigation timeout to a higher value
        await page.setDefaultNavigationTimeout(120000); // 2 minutes
        
        // Configure page for better stability
        await page.setRequestInterception(true);
        page.on('request', (request) => {
          // Block unnecessary resource types to improve stability
          const resourceType = request.resourceType();
          const blockedTypes = ['image', 'media', 'font', 'texttrack', 'object', 'beacon', 'csp_report', 'imageset'];
          
          if (blockedTypes.includes(resourceType)) {
            request.abort();
          } else {
            request.continue();
          }
        });
        
        return page;
      },
      destroy: async (page) => {
        try {
          console.log(`Destroying page: ${page._poolId || 'unknown'}`);
          if (page && typeof page.close === 'function' && !page._isClosed) {
            await page.close().catch(e => console.warn(`Error closing page: ${e.message}`));
          }
        } catch (error) {
          console.error(`Error during page destruction: ${error.message}`);
        }
      },
      validate: (page) => {
        // Check if page is still valid
        const isValid = page && !page._isClosed && browser && browser.isConnected();
        if (!isValid) {
          console.warn(`Page validation failed for: ${page?._poolId || 'unknown'}`);
        }
        return isValid;
      }
    }, {
      max: 1,              // Maximum 1 pages in the pool
      min: 1,              // Keep at least 1 page
      idleTimeoutMillis: 600000,   // Increase idle timeout to 10 minutes (from 30-40s)
      evictionRunIntervalMillis: 120000,  // Check for pages to evict every 2 minutes
      numTestsPerEvictionRun: 1,   // Only test 1 page per eviction run
      softIdleTimeoutMillis: 300000, // Soft idle of 5 minutes
      testOnBorrow: true,          // Test pages when they're borrowed
      acquireTimeoutMillis: 60000, // 1 minute acquire timeout
      fifo: true                   // First in, first out
    });
    
    return pagePool;
  }

  // Set up page health monitoring
  function setupPageHealthMonitoring() {
    // Check page health less frequently - every 5 minutes instead of every minute
    setInterval(async () => {
      try {
        if (!browser || !browser.isConnected()) {
          console.warn('Browser not connected, skipping page health check');
          return;
        }
        
        // Get all pages from browser
        const pages = await browser.pages();
        console.log(`Current browser has ${pages.length} pages`);
        
        // Only clean up VERY old pages - increased from 5 minutes to 30 minutes
        const STALE_PAGE_THRESHOLD = 30 * 60 * 1000; // 30 minutes in milliseconds
        
        // Check for zombie pages (pages that are open but not in the pool)
        for (const page of pages) {
          // Skip the default about:blank page and the first page (often Chrome's initial tab)
          if (page.url() === 'about:blank' || pages.indexOf(page) === 0) continue;
          
          // If page hasn't been tracked by our pool
          if (!page._poolId) {
            console.warn(`Found untracked page at ${page.url()}, but leaving it alone`);
            continue; // Don't close untracked pages automatically
          }
          
          // Only clean up very old inactive pages
          if (page._lastActivity && (Date.now() - page._lastActivity > STALE_PAGE_THRESHOLD) && !page._inUse) {
            console.warn(`Found very stale page ${page._poolId}, refreshing it`);
            try {
              await page.goto('about:blank');
              page._lastActivity = Date.now(); // Reset the activity timer
            } catch (e) {
              console.warn(`Failed to refresh stale page: ${e.message}`);
              // Don't automatically close - let the pool handle it
            }
          }
        }
      } catch (e) {
        console.error(`Error in page health monitoring: ${e.message}`);
      }
    }, 300000); // Check every 5 minutes instead of every minute
  }

  // Function to handle browser crashes with improved handling
  async function handleBrowserCrash() {
    if (isRestarting) {
      console.warn('⚠️ Already restarting, skipping...');
      return;
    }

    isRestarting = true;
    restartAttempts++;

    if (restartAttempts > MAX_RESTART_ATTEMPTS) {
      console.error('❌ Max restart attempts reached. Exiting...');
      process.exit(1);
    }

    console.log(`🔄 Browser restart attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}`);

    try {
      // Close all pages first
      if (browser && browser.isConnected()) {
        const pages = await browser.pages().catch(() => []);
        for (const page of pages) {
          await page.close().catch(() => {});
        }
      }
      
      // Then drain the page pool
      if (pagePool) {
        console.log('Draining page pool...');
        await pagePool.drain().catch(e => {
          console.warn(`Error draining pool: ${e.message}`);
        });
        await pagePool.clear().catch(e => {
          console.warn(`Error clearing pool: ${e.message}`);
        });
      }

      // Close the browser
      if (browser) {
        console.log('Closing browser...');
        await browser.close().catch(e => {
          console.warn(`Error closing browser: ${e.message}`);
        });
      }

      // Force garbage collection
      if (typeof global.gc === 'function') {
        global.gc();
      }

      // Wait before restarting
      await new Promise(resolve => setTimeout(resolve, RESTART_DELAY));

      // Launch new browser instance with enhanced options
      await initializeBrowser();
      
      isRestarting = false;
      console.log(`🔄 Browser restarted successfully (attempt ${restartAttempts})`);
      
    } catch (error) {
      console.error('Browser restart failed:', error);
      isRestarting = false;
      
      // Retry after delay
      setTimeout(() => handleBrowserCrash(), RESTART_DELAY);
    }
  }

  // Initialize browser
  await initializeBrowser();

  // Queue to throttle concurrency
  const queue = new PQueue({ concurrency: 1 });

  // Improved runScrapeJob with better page acquisition and error handling
  async function runScrapeJob(context) {
    // URL validation - prevent acquiring page resources for invalid URLs
    if (!context.url || !isValidUrl(context.url)) {
      console.error(`Invalid URL provided: ${context.url}`);
      return { 
        data: JSON.stringify({ 
          success: false, 
          error: `Invalid URL: ${context.url}. URL must start with http:// or https://` 
        }), 
        type: 'application/json' 
      };
    }
    
    // Check browser health before proceeding
    if (!browser || !browser.isConnected()) {
      console.error('🔴 Browser not connected, attempting restart...');
      await handleBrowserCrash();
      
      // Wait for browser to be available
      const maxWaitTime = 30000; // 30 seconds
      const startTime = Date.now();
      
      while (!browser || !browser.isConnected()) {
        if (Date.now() - startTime > maxWaitTime) {
          throw new Error('Browser not available after restart');
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    let page = null;
    let pageAcquired = false;
    
    try {
      // Try to acquire a page with retries
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`Attempting to acquire page, attempt ${attempt}`);
          page = await pagePool.acquire();
          
          if (!page || page._isClosed) {
            console.warn(`Acquired invalid page on attempt ${attempt}, retrying...`);
            if (page) {
              try {
                await pagePool.destroy(page);
              } catch (e) {}
            }
            continue;
          }
          
          // Mark page as in use and update activity timestamp
          page._inUse = true;
          page._lastActivity = Date.now();
          pageAcquired = true;
          console.log(`Successfully acquired page ${page._poolId}`);
          break;
        } catch (acquireError) {
          console.error(`Failed to acquire page on attempt ${attempt}: ${acquireError.message}`);
          if (attempt === 3) throw acquireError;
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      
      if (!pageAcquired || !page) {
        throw new Error("Failed to acquire a valid page from the pool");
      }
      
      // Clear browser cache and cookies periodically (every ~10 requests)
      if (Math.random() < 0.1) {
        try {
          if (page.session && typeof page.session.clearCache === 'function') {
            await page.session.clearCache();
          }
          await page.evaluate(() => {
            try { localStorage.clear(); } catch(e) {}
            try { sessionStorage.clear(); } catch(e) {}
          });
        } catch (e) {
          console.warn(`Error clearing cache: ${e.message}`);
        }
      }
      
      const result = await priceScraper(page, context);
      return result;
    } catch (error) {
      console.error(`Scrape job error: ${error.message}`);
      
      // If page was acquired but is now closed, destroy it
      if (pageAcquired && page && page._isClosed) {
        console.warn(`Page was closed during job execution: ${page._poolId}`);
        try {
          await pagePool.destroy(page);
        } catch (e) {}
        page = null;
      }
      
      return { 
        data: JSON.stringify({ success: false, error: error.message }), 
        type: 'application/json' 
      };
    } finally {
      // Clean up page resources before returning to pool
      if (pageAcquired && page && !page._isClosed) {
        try {
          page._inUse = false;
          page._lastActivity = Date.now();
          
          await page.evaluate(() => {
            try {
              // Remove event listeners
              const oldNode = document.documentElement;
              const newNode = oldNode.cloneNode(true);
              if (oldNode.parentNode) oldNode.parentNode.replaceChild(newNode, oldNode);
              
              // Clear other browser resources
              if (typeof window.gc === 'function') window.gc();
            } catch(e) {}
          }).catch(() => {});
          
          console.log(`Releasing page back to pool: ${page._poolId}`);
          await pagePool.release(page).catch(e => {
            console.error(`Error releasing page: ${e.message}`);
          });
        } catch (e) {
          console.error(`Error in page cleanup: ${e.message}`);
        }
      }
    }
  }

  // PriceScraper function with stealth & human-like interactions
  async function priceScraper(page, context) {
    const randomDelay = async (min = 100, max = 500) => {
      const d = Math.floor(Math.random() * (max - min) + min);
      await new Promise(r => setTimeout(r, d));
    };
    
    const waitSafely = async (ms) => {
      // Compatibility function for different Puppeteer versions
      if (typeof page.waitForTimeout === 'function') {
        await page.waitForTimeout(ms);
      } else {
        await new Promise(r => setTimeout(r, ms));
      }
    };

    const humanType = async (selector, text) => {
      try {
        await page.waitForSelector(selector, { timeout: 10000 });
        await page.focus(selector);
        await page.evaluate(sel => {
          const element = document.querySelector(sel);
          if (element) element.value = '';
        }, selector);
        
        for (const ch of text) {
          await page.type(selector, ch, { delay: Math.random() * 100 + 30 });
          await randomDelay(30, 100);
        }
        return true;
      } catch (error) {
        console.warn(`Human type error for selector ${selector}: ${error.message}`);
        return false;
      }
    };

    const { url, loginInstructions = [], credentials = {} } = context;
    
    // Extra URL validation as a safety measure
    if (!url || !isValidUrl(url)) {
      console.error(`Invalid URL provided: ${url}`);
      return { 
        data: JSON.stringify({ 
          success: false, 
          error: `Invalid URL: ${url}. URL must start with http:// or https://` 
        }), 
        type: 'application/json' 
      };
    }
    
    // Check if page is still valid
    if (page._isClosed) {
      console.error(`Page ${page._poolId} closed before scraping could begin`);
      return {
        data: JSON.stringify({
          success: false,
          error: "Page was closed before scraping could begin"
        }),
        type: 'application/json'
      };
    }
    
    console.log(`Scraping ${url} with page ${page._poolId}`);

    try {
      // Set user agent & viewport with better timeout handling
      try {
        // Set user agent with retry logic
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            // Check if page is still valid
            if (page._isClosed) throw new Error('Page closed during configuration');
            
            await Promise.race([
              page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
              ),
              new Promise((_, reject) => setTimeout(() => reject(new Error('User agent timeout')), 10000))
            ]);
            break; // Success, exit retry loop
          } catch (e) {
            console.warn(`User agent setting failed on attempt ${attempt}: ${e.message}`);
            if (attempt === 3) throw e; // Re-throw on final attempt
            await waitSafely(1000); // Wait before retry
          }
        }
        
        // Set viewport size with retry logic
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            // Check if page is still valid
            if (page._isClosed) throw new Error('Page closed during configuration');
            
            await Promise.race([
              page.setViewport({ width: 1366, height: 768 }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Viewport timeout')), 10000))
            ]);
            break; // Success, exit retry loop
          } catch (e) {
            console.warn(`Viewport setting failed on attempt ${attempt}: ${e.message}`);
            if (attempt === 3) throw e; // Re-throw on final attempt
            await waitSafely(1000); // Wait before retry
          }
        }
      } catch (configError) {
        console.error(`Failed to configure browser: ${configError.message}`);
        if (page._isClosed) {
          throw new Error('Page closed during configuration');
        }
        // Continue anyway - the defaults might work
      }

      // --- handle login if provided ---
      let loginSite = null;
      try {
        const domain = new URL(url).hostname.replace('www.', '');
        loginSite = loginInstructions.find(site => {
          try {
            const sd = new URL(site.url).hostname.replace('www.', '');
            return domain.includes(sd) || sd.includes(domain);
          } catch (e) {
            console.warn(`Invalid login site URL: ${site.url}`);
            return false;
          }
        });
      } catch (e) {
        console.warn(`Error parsing URL domain: ${e.message}`);
      }

      if (loginSite && credentials[loginSite.site.toLowerCase()]) {
        console.log(`Logging in to ${loginSite.site}`);
        
        try {
          // Validate login URL
          if (!isValidUrl(loginSite.url)) {
            console.warn(`Invalid login URL: ${loginSite.url}, skipping login`);
          } else {
            // Check if page is still valid
            if (page._isClosed) throw new Error('Page closed before login');
            
            // Navigate to login page with longer timeout
            await page.goto(loginSite.url, { 
              waitUntil: 'domcontentloaded', // Changed from networkidle0 for better reliability 
              timeout: 90000  // Increased timeout for login page
            });
            await waitSafely(2000);
            
            // Check if redirected to location page for Winsupply
            const currentLoginUrl = page.url();
            let loginSuccess = false;
            let stepSuccess = 0;
            
            if (loginSite.site.toLowerCase() === 'winsupply' && currentLoginUrl.includes('/Location/')) {
              console.log('🔄 Detected Winsupply redirect to location page, skipping login process');
              loginSuccess = true; // Mark login as successful
              
              // Take screenshot of location page for verification
              if (!page._isClosed) {
                const locationScreenshot = await page.screenshot({ type: 'jpeg', quality: 60 });
                console.log(`Location page loaded, size: ${locationScreenshot.length} bytes`);
              }
            } else {
              // Only proceed with normal login if not redirected to location page
              try {
                // Take screenshot of login page for debugging
                if (!page._isClosed) {
                  const loginScreenshot = await page.screenshot({ type: 'jpeg', quality: 60 });
                  console.log(`Login page loaded, size: ${loginScreenshot.length} bytes`);
                } else {
                  throw new Error('Page closed during login screenshot');
                }
                
                // Process login steps with better error handling
                for (const step of loginSite.steps) {
                  // Check if page is still valid
                  if (page._isClosed) throw new Error('Page closed during login steps');
                  
                  try {
                    console.log(`Executing login step: ${step.type}`);
                    
                    switch (step.type) {
                      case 'input': {
                        const val = credentials[loginSite.site.toLowerCase()][step.valueKey] || '';
                        const inputSuccess = await humanType(step.selector, val);
                        if (inputSuccess) stepSuccess++;
                        break;
                      }
                      case 'click': {
                        try {
                          await page.waitForSelector(step.selector, { timeout: 10000 });
                          const el = await page.$(step.selector);
                          if (el) {
                            const box = await el.boundingBox();
                            if (box) {
                              await page.mouse.move(
                                box.x + box.width/2 + (Math.random()*10-5),
                                box.y + box.height/2 + (Math.random()*10-5),
                                { steps: Math.floor(Math.random()*5)+3 }
                              );
                              await randomDelay(100, 300);
                              await el.click({ delay: Math.floor(Math.random()*100)+50 });
                              stepSuccess++;
                            } else {
                              console.warn(`Element ${step.selector} has no bounding box`);
                            }
                          } else {
                            console.warn(`Element ${step.selector} not found`);
                          }
                        } catch (err) {
                          console.warn(`Click failed for ${step.selector}: ${err.message}`);
                        }
                        break;
                      }
                      case 'clickText': {
                        await randomDelay(500, 1500);
                        try {
                          // First try using page.$x if available
                          if (typeof page.$x === 'function') {
                            const els = await page.$x(`//*[contains(text(), '${step.text}')]`);
                            if (els.length) {
                              const b = await els[0].boundingBox();
                              if (b) {
                                await page.mouse.move(
                                  b.x + b.width/2, b.y + b.height/2,
                                  { steps: Math.floor(Math.random()*5)+3 }
                                );
                                await randomDelay(100, 300);
                                await els[0].click({ delay: Math.floor(Math.random()*100)+50 });
                                stepSuccess++;
                              }
                            } else {
                              console.warn(`Text containing '${step.text}' not found using XPath`);
                            }
                          } else {
                            // Fallback to evaluate if $x is not available
                            console.log(`Using evaluate fallback for clickText: ${step.text}`);
                            const clicked = await page.evaluate((text) => {
                              const elements = [...document.querySelectorAll('*')]
                                .filter(e => e.textContent.includes(text) && e.offsetWidth > 0 && e.offsetHeight > 0);
                              
                              if (elements.length > 0) {
                                elements[0].click();
                                return true;
                              }
                              return false;
                            }, step.text);
                            
                            if (clicked) {
                              console.log(`Clicked text '${step.text}' using evaluate fallback`);
                              stepSuccess++;
                            } else {
                              console.warn(`Text containing '${step.text}' not found using evaluate`);
                            }
                          }
                        } catch (err) {
                          console.warn(`Click text failed for '${step.text}': ${err.message}`);
                        }
                        break;
                      }
                      case 'wait':
                        await waitSafely(step.time || 1500);
                        stepSuccess++;
                        break;
                    }
                    await waitSafely(1000 + Math.random() * 1000);
                    
                  } catch (err) {
                    console.warn(`Login step error (${step.type}): ${err.message}`);
                    if (page._isClosed) throw new Error('Page closed during login step');
                  }
                }
                
                // Check for URL change to determine success
                await waitSafely(3000);  // Wait longer for login to complete
                
                // Check if page is still valid
                if (page._isClosed) throw new Error('Page closed after login steps');
                
                const currentUrl = page.url();
                
                if (currentUrl !== loginSite.url) {
                  console.log('📋 Login succeeded - URL changed');
                  loginSuccess = true;
                } else if (stepSuccess >= loginSite.steps.length * 0.75) {
                  // If at least 75% of steps succeeded, consider it a probable success
                  console.log('📋 Login probably succeeded - most steps completed');
                  loginSuccess = true;
                } else {
                  console.log('❌ Login may have failed - URL unchanged and some steps failed');
                }
                
                // Take post-login screenshot to verify
                if (!page._isClosed) {
                  const postLoginScreenshot = await page.screenshot({ type: 'jpeg', quality: 60 });
                  console.log(`Post-login screenshot size: ${postLoginScreenshot.length} bytes`);
                }
              } catch (loginStepsError) {
                console.error(`❌ Login steps error: ${loginStepsError.message}`);
                if (page._isClosed) throw new Error('Page closed during login process');
              }
            }
          }
        } catch (loginError) {
          console.error(`❌ Login process error: ${loginError.message}`);
          if (page._isClosed) throw new Error('Page closed during login process');
        }
      }

      // --- navigate & scroll with better timeout handling ---
      console.log(`Navigating to ${url}`);
      
      // Check if page is still valid
      if (page._isClosed) throw new Error('Page closed before navigation');
      
      // Try navigation with multiple attempts and increased timeout
      let navigationSuccessful = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          // Check if page is still valid
          if (page._isClosed) throw new Error('Page closed during navigation attempt');
          
          await page.goto(url, { 
            waitUntil: 'domcontentloaded', // Change from networkidle0 to less strict condition
            timeout: 90000 // Increased from 60000
          });
          navigationSuccessful = true;
          console.log(`Navigation successful on attempt ${attempt}`);
          break;
        } catch (navError) {
          console.warn(`Navigation attempt ${attempt} failed: ${navError.message}`);
          
          if (page._isClosed) throw new Error('Page closed during navigation');
          
          if (attempt === 3) {
            console.error('All navigation attempts failed');
            throw navError; // Re-throw on final attempt
          }
          
          // Wait before retry and clear any dialogs
          await waitSafely(5000);
          try {
            // Try to dismiss any alerts or dialogs
            if (!page._isClosed) {
              await Promise.race([
                page.evaluate(() => {
                  window.stop(); // Stop any pending loads
                  if (window.alert) window.alert = () => true;
                  if (window.confirm) window.confirm = () => true;
                  if (window.prompt) window.prompt = () => '';
                }),
                new Promise(r => setTimeout(r, 1000))
              ]);
            }
          } catch (e) {}
        }
      }
      
      // Only scroll if navigation was successful
      if (navigationSuccessful && !page._isClosed) {
        try {
          await page.evaluate(async () => {
            const h = document.body.scrollHeight;
            let pos = 0;
            while (pos < h) {
              const step = Math.floor(Math.random()*100)+100;
              window.scrollBy(0, step);
              pos += step;
              await new Promise(r => setTimeout(r, Math.floor(Math.random()*300)+200));
            }
            if (Math.random()>0.7) {
              window.scrollBy(0, -Math.floor(Math.random()*400)-200);
              await new Promise(r => setTimeout(r, Math.floor(Math.random()*200)+100));
            }
          });
          await randomDelay(1000, 3000);
        } catch (scrollError) {
          console.warn('Error during scrolling:', scrollError.message);
          // Continue even if scrolling fails
          if (page._isClosed) throw new Error('Page closed during scrolling');
        }
      }

      // --- dismiss cookies ---
      if (!page._isClosed) {
        await dismissCookies(page);
      }

      // --- screenshot with memory optimization and fallback ---
      if (page._isClosed) {
        throw new Error('Page closed before taking screenshot');
      }
      
      console.log(`Taking screenshot with page ${page._poolId}`);
      
      // Clear memory before taking screenshot
      try {
        if (!page._isClosed) {
          await page.evaluate(() => {
            if (typeof window.gc === 'function') window.gc();
            if (performance && performance.memory) console.log('Memory:', performance.memory.usedJSHeapSize);
          });
        }
      } catch (e) {
        console.warn('Memory cleanup failed:', e.message);
        if (page._isClosed) throw new Error('Page closed during memory cleanup');
      }
      
      // Take screenshot with retry logic
      let screenshot = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          // Check if page is still valid
          if (page._isClosed) throw new Error('Page closed before screenshot attempt');
          
          console.log(`Screenshot attempt ${attempt}`);
          screenshot = await Promise.race([
            page.screenshot({ 
              type: 'jpeg', 
              quality: 70,
              fullPage: false, 
              clip: {x:0, y:0, width:1366, height:768}
            }),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Screenshot timeout')), 30000)
            )
          ]);
          console.log(`Screenshot captured successfully on attempt ${attempt}`);
          break;
        } catch (screenshotError) {
          console.warn(`Screenshot attempt ${attempt} failed:`, screenshotError.message);
          
          if (page._isClosed) throw new Error('Page closed during screenshot');
          
          if (attempt === 3) {
            console.error('All screenshot attempts failed, trying fallback method');
            
            // Fallback: try with lower quality and smaller area
            try {
              if (!page._isClosed) {
                screenshot = await page.screenshot({ 
                  type: 'jpeg',
                  quality: 50,
                  fullPage: false,
                  clip: {x:0, y:0, width:800, height:600}
                });
                console.log('Fallback screenshot captured with reduced parameters');
              } else {
                throw new Error('Page closed during fallback screenshot');
              }
            } catch (fallbackError) {
              console.error('Fallback screenshot also failed:', fallbackError.message);
              throw screenshotError; // Re-throw original error
            }
          } else {
            await waitSafely(3000); // Wait before retry
          }
        }
      }
      
      // Only return screenshot data and type if we have a screenshot
      if (screenshot) {
        return { data: screenshot, type: 'image/jpeg' };
      } else {
        throw new Error('Failed to capture screenshot after multiple attempts');
      }

    } catch (error) {
      console.error(`Scrape error: ${error.message}`);
      return { data: JSON.stringify({ success: false, error: error.message }), type: 'application/json' };
    }
  }

  // POST /scrape → returns Base64 JSON
  app.post('/scrape', async (req, res) => {
    try {
      // Basic validation before queuing
      if (!req.body.url) {
        return res.status(400).json({
          success: false,
          error: "URL is required"
        });
      }
      
      // URL format validation
      if (!isValidUrl(req.body.url)) {
        return res.status(400).json({
          success: false,
          error: `Invalid URL: ${req.body.url}. URL must start with http:// or https://`
        });
      }
      
      const result = await queue.add(() => runScrapeJob(req.body));
      
      if (result.type.startsWith('image/')) {
        const imageBase64 = result.data.toString('base64');
        return res.json({ 
          success: true, 
          mimeType: result.type, 
          imageBase64 
        });
      }
      
      // If we received a JSON error response from our scraper
      if (result.type === 'application/json') {
        try {
          const errorData = JSON.parse(result.data);
          return res.status(errorData.success ? 200 : 400).json(errorData);
        } catch (e) {
          return res.status(500).json({
            success: false,
            error: 'Failed to parse error response'
          });
        }
      }
      
      return res.status(400).json({ 
        success: false, 
        error: 'Unexpected non-image result' 
      });
    } catch (err) {
      console.error('Scrape request failed:', err);
      
      // Check if browser crash caused the error
      if (err.message.includes('Browser') || err.message.includes('Target closed')) {
        await handleBrowserCrash();
      }
      
      return res.status(500).json({ 
        success: false, 
        error: err.message 
      });
    }
  });

  // Enhanced health check with browser status
  app.get('/healthz', async (_req, res) => {
    const browserConnected = browser && browser.isConnected();
    const pageCount = pagePool ? pagePool.borrowed : 0;
    const totalPages = browser && browser.isConnected() ? (await browser.pages()).length : 0;
    
    if (!browserConnected) {
      // Trigger browser restart if it's not connected
      handleBrowserCrash().catch(console.error);
      
      return res.status(503).json({
        status: 'unhealthy',
        browser: 'disconnected',
        restarting: isRestarting,
        pageCount,
        totalPages
      });
    }
    
    res.json({
      status: 'healthy',
      browser: 'connected',
      restarting: isRestarting,
      pageCount,
      totalPages,
      memoryUsage: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
      }
    });
  });

  // Regular browser health monitoring
  setInterval(async () => {
    if (!browser || !browser.isConnected()) {
      console.error('Browser health check failed, restarting...');
      await handleBrowserCrash();
    }
  }, 30000); // Check every 30 seconds

  // Start server & ngrok tunnel with persistence
  const server = app.listen(3000, async () => {
    console.log('🟢 Listening on http://localhost:3000');
    
    try {
      // Connect to existing tunnel or create new one
      const url = await connectToNgrok();
      console.log(`🌐 Server accessible at: ${url}`);
      
    } catch (err) {
      console.error('❌ ngrok error:', err);
    }
  });

  // Improved graceful shutdown with tunnel preservation
  process.on('SIGTERM', async () => {
    console.log('🔴 SIGTERM received, shutting down gracefully...');
    
    // Stop accepting new connections but let existing ones finish
    server.close(() => console.log('Server stopped accepting new connections'));
    
    // Pause the queue to prevent new jobs from being accepted
    queue.pause();
    console.log(`Queue status before shutdown: ${queue.size} pending, ${queue.pending} in progress`);
    
    // Wait for all current jobs to finish
    if (queue.pending > 0) {
      console.log('Waiting for in-progress jobs to complete...');
      await queue.onIdle();
      console.log('All jobs completed');
    }
    
    // Close all browser pages and resources
    if (pagePool) {
      console.log('Draining page pool...');
      await pagePool.drain().catch(e => {
        console.warn(`Error draining pool: ${e.message}`);
      });
      await pagePool.clear().catch(e => {
        console.warn(`Error clearing pool: ${e.message}`);
      });
    }
    
    // Close the browser
    if (browser) {
      console.log('Closing browser...');
      await browser.close().catch(e => {
        console.warn(`Error closing browser: ${e.message}`);
      });
    }
    
    // Force garbage collection if node is run with --expose-gc
    if (typeof global.gc === 'function') {
      global.gc();
      console.log('Forced garbage collection');
    }
    
    // IMPORTANT: Do NOT disconnect ngrok here to preserve the tunnel
    // await ngrok.disconnect();
    
    console.log('Shutdown complete');
    process.exit(0);
  });

  // Add memory monitoring with graceful queue handling
  const memoryInterval = setInterval(async () => {
    const memUsage = process.memoryUsage();
    console.log(`Memory usage: RSS ${Math.round(memUsage.rss / 1024 / 1024)}MB | Heap ${Math.round(memUsage.heapUsed / 1024 / 1024)}/${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);
    
    // Auto restart if memory usage exceeds threshold (1GB)
    if (memUsage.rss > 1000 * 1024 * 1024) {
      console.log('⚠️ Memory threshold exceeded, initiating graceful restart');
      
      // Prevent new jobs from being added
      queue.pause();
      console.log(`Queue status: ${queue.size} pending, ${queue.pending} in progress`);
      
      // Wait for current jobs to complete
      if (queue.size > 0 || queue.pending > 0) {
        console.log('Waiting for queue to drain before restart...');
        await queue.onIdle();
        console.log('Queue is now empty, proceeding with restart');
      }
      
      // Now it's safe to restart
      process.emit('SIGTERM');
    }
  }, 60000); // Check every minute

  // Clear interval on shutdown
  process.on('SIGTERM', () => clearInterval(memoryInterval));

  // Handle uncaught exceptions related to browser
  process.on('uncaughtException', async (error) => {
    console.error('💥 Uncaught exception:', error);
    
    if (error.message.includes('Browser') || error.message.includes('Target closed') || error.message.includes('Invalid URL')) {
      await handleBrowserCrash();
    } else {
      // For other critical errors, exit process
      process.exit(1);
    }
  });
})();