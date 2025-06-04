// server-n8n-with-login.mjs - Memory-optimized server for n8n WITH login support
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
  SCREENSHOT_QUALITY: 70,      // Higher quality for price visibility
  SCREENSHOT_WIDTH: 1366,      // Full width for price detection
  SCREENSHOT_HEIGHT: 768,
  MAX_PAGES: 1,               // Single page only
  PAGE_TIMEOUT: 150000,       // Extended for slow sites (2.5 minutes)
  NAVIGATION_TIMEOUT: 150000, // Extended for slow sites (2.5 minutes)
  RESTART_THRESHOLD: 600,     // Lower threshold - 600MB
  MAX_REQUESTS_BEFORE_RESTART: 300, // Lower for memory safety
  GC_FREQUENCY: 5,            // More frequent GC
  QUEUE_CONCURRENCY: 1,       // Process one at a time
  REQUEST_TIMEOUT: 180000     // 3 minutes for complex login flows
};

let requestCount = 0;

// Aggressive garbage collection
const gcInterval = setInterval(() => {
  if (typeof global.gc === 'function') {
    global.gc();
    const mem = process.memoryUsage();
    console.log(`🧹 Scheduled GC: ${Math.round(mem.heapUsed / 1024 / 1024)}MB heap`);
  }
}, 30000); // Every 30 seconds

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

// Connect to ngrok with proper error handling
async function connectToNgrok() {
  try {
    console.log('🔗 Connecting to ngrok...');
    
    // Try to disconnect any existing sessions
    await ngrok.disconnect().catch(() => {});
    
    const url = await ngrok.connect({
      addr: 3000,
      authtoken: process.env.NGROK_AUTH_TOKEN
    });
    
    console.log(`🔗 Tunnel: ${url}`);
    return url;
  } catch (err) {
    console.error('❌ ngrok error:', err.message);
    console.log('⚠️ Server running only on local address: http://localhost:3000');
    return 'http://localhost:3000';
  }
}

// Enhanced cookie dismissal from original server
async function dismissCookies(page) {
  if (!page || page._isClosed) return;
  
  try {
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
    
    let clickedCookie = false;
    
    for (let i = 0; i < selectors.length; i++) {
      if (page._isClosed) return;
      
      try {
        const element = await page.$(selectors[i]);
        if (element) { 
          await element.click();
          await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
          clickedCookie = true;
          return;
        }
      } catch (selectorError) {
        // Continue to next selector
      }
    }
    
    // Fallback approach using text matching
    if (!clickedCookie && !page._isClosed) {
      try {
        const clickResult = await page.evaluate(() => {
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
  app.use(express.json({ limit: '2mb' })); // Keep larger limit for login instructions

  let browser = null;
  let pagePool = null;
  let isRestarting = false;
  let restartAttempts = 0;
  const MAX_RESTART_ATTEMPTS = 5;

  // Browser initialization with crash-resistant options
  async function initializeBrowser() {
    try {
      console.log('🚀 Launching browser with login support...');
      
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
          '--ignore-certificate-errors',
          '--disable-web-security',
          '--disable-features=TranslateUI,VizDisplayCompositor',
          '--disable-ipc-flooding-protection',
          '--memory-pressure-off',
          '--single-process'
        ],
        ignoreHTTPSErrors: true,
        timeout: 60000
      });
      
      browser.on('disconnected', handleBrowserCrash);
      console.log('✅ Browser ready for n8n with login support');
      
      createPagePool();
      restartAttempts = 0;
      return browser;
    } catch (error) {
      console.error('Browser launch failed:', error);
      throw error;
    }
  }

  // Enhanced page pool with login capabilities
  function createPagePool() {
    pagePool = genericPool.createPool({
      create: async () => {
        if (!browser || !browser.isConnected()) {
          throw new Error('Browser not connected');
        }
        
        const page = await browser.newPage();
        page._poolId = `login_${Date.now()}`;
        page._created = Date.now();
        page._lastActivity = Date.now();
        page._inUse = false;
        
        // Enhanced page setup for login flows
        await page.setDefaultNavigationTimeout(150000); // Increased to 2.5 minutes
        await page.setViewport({ 
          width: MEMORY_LIMITS.SCREENSHOT_WIDTH, 
          height: MEMORY_LIMITS.SCREENSHOT_HEIGHT 
        });
        
        // More permissive resource blocking for difficult sites
        await page.setRequestInterception(true);
        page.on('request', (request) => {
          const resourceType = request.resourceType();
          const url = request.url();
          
          // Block only truly unnecessary resources
          const blockedTypes = ['image', 'media', 'font'];
          const allowCritical = resourceType === 'document' || 
                               resourceType === 'script' || 
                               resourceType === 'xhr' || 
                               resourceType === 'fetch' || 
                               resourceType === 'stylesheet' ||
                               url.includes('api') ||
                               url.includes('login') ||
                               url.includes('auth');
          
          if (blockedTypes.includes(resourceType) && !allowCritical) {
            request.abort();
          } else {
            request.continue();
          }
        });
        
        page.on('error', () => {
          page._hasError = true;
        });
        
        page.on('close', () => {
          page._isClosed = true;
        });
        
        console.log(`📄 Created login-capable page: ${page._poolId}`);
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
                       (Date.now() - page._created) < 600000; // 10 minute max age
        
        if (!isValid && page) {
          console.warn(`Page validation failed: ${page._poolId}`);
        }
        return isValid;
      }
    }, {
      max: 1,
      min: 1,
      idleTimeoutMillis: 300000,   // 5 minute idle timeout
      acquireTimeoutMillis: 30000, // 30 second acquire timeout for login flows
      testOnBorrow: true,
      testOnReturn: true
    });
    
    return pagePool;
  }

  // Browser crash handling
  async function handleBrowserCrash() {
    if (isRestarting) return;
    
    isRestarting = true;
    restartAttempts++;
    
    if (restartAttempts > MAX_RESTART_ATTEMPTS) {
      console.error('❌ Max restarts reached. Process will exit.');
      process.exit(1);
    }
    
    console.log(`🔄 Browser restart ${restartAttempts}/${MAX_RESTART_ATTEMPTS} (with login support)`);
    
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
      
      await new Promise(resolve => setTimeout(resolve, 3000));
      await initializeBrowser();
      
      isRestarting = false;
      console.log('🔄 Browser restarted with login capabilities');
    } catch (error) {
      console.error('Restart failed:', error);
      isRestarting = false;
      setTimeout(handleBrowserCrash, 5000);
    }
  }

  await initializeBrowser();

  // Request queue for n8n
  const queue = new PQueue({ 
    concurrency: MEMORY_LIMITS.QUEUE_CONCURRENCY,
    timeout: MEMORY_LIMITS.REQUEST_TIMEOUT,
    throwOnTimeout: true
  });

  // Human-like typing for login forms
  const humanType = async (page, selector, text) => {
    try {
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.focus(selector);
      await page.evaluate(sel => {
        const element = document.querySelector(sel);
        if (element) element.value = '';
      }, selector);
      
      for (const ch of text) {
        await page.type(selector, ch, { delay: Math.random() * 100 + 30 });
        await new Promise(r => setTimeout(r, Math.random() * 100 + 30));
      }
      return true;
    } catch (error) {
      console.warn(`Human type error for selector ${selector}: ${error.message}`);
      return false;
    }
  };

  // Random delay helper
  const randomDelay = async (min = 100, max = 500) => {
    const d = Math.floor(Math.random() * (max - min) + min);
    await new Promise(r => setTimeout(r, d));
  };

  // Wait safely helper
  const waitSafely = async (page, ms) => {
    if (typeof page.waitForTimeout === 'function') {
      await page.waitForTimeout(ms);
    } else {
      await new Promise(r => setTimeout(r, ms));
    }
  };

  // Full price scraper with login support (from your original server)
  async function priceScraper(page, context) {
    const { url, loginInstructions = [], credentials = {} } = context;
    
    // URL validation
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
    
    console.log(`🔍 Scraping ${url} with login support using page ${page._poolId}`);

    try {
      // Set user agent & viewport
      try {
        await page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
        );
        await page.setViewport({ width: 1366, height: 768 });
      } catch (configError) {
        console.error(`Failed to configure browser: ${configError.message}`);
        if (page._isClosed) {
          throw new Error('Page closed during configuration');
        }
      }

      // LOGIN LOGIC - Find matching login site
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

      // PERFORM LOGIN if credentials available
      if (loginSite && credentials[loginSite.site.toLowerCase()]) {
        console.log(`🔐 Logging in to ${loginSite.site} for price access`);
        
        try {
          if (!isValidUrl(loginSite.url)) {
            console.warn(`Invalid login URL: ${loginSite.url}, skipping login`);
          } else {
            if (page._isClosed) throw new Error('Page closed before login');
            
            // Navigate to login page
            await page.goto(loginSite.url, { 
              waitUntil: 'domcontentloaded',
              timeout: MEMORY_LIMITS.PAGE_TIMEOUT
            });
            await waitSafely(page, 2000);
            
            // Check for Winsupply location redirect
            const currentLoginUrl = page.url();
            let loginSuccess = false;
            let stepSuccess = 0;
            
            if (loginSite.site.toLowerCase() === 'winsupply' && currentLoginUrl.includes('/Location/')) {
              console.log('🔄 Detected Winsupply redirect to location page, skipping login process');
              loginSuccess = true;
              
              if (!page._isClosed) {
                const locationScreenshot = await page.screenshot({ type: 'jpeg', quality: 60 });
                console.log(`📍 Location page loaded, size: ${locationScreenshot.length} bytes`);
              }
            } else {
              // Process normal login steps
              try {
                if (!page._isClosed) {
                  const loginScreenshot = await page.screenshot({ type: 'jpeg', quality: 60 });
                  console.log(`📋 Login page loaded, size: ${loginScreenshot.length} bytes`);
                } else {
                  throw new Error('Page closed during login screenshot');
                }
                
                // Execute login steps
                for (const step of loginSite.steps) {
                  if (page._isClosed) throw new Error('Page closed during login steps');
                  
                  try {
                    console.log(`🔧 Executing login step: ${step.type}`);
                    
                    switch (step.type) {
                      case 'input': {
                        const val = credentials[loginSite.site.toLowerCase()][step.valueKey] || '';
                        const inputSuccess = await humanType(page, step.selector, val);
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
                            }
                          }
                        } catch (err) {
                          console.warn(`Click failed for ${step.selector}: ${err.message}`);
                        }
                        break;
                      }
                      case 'clickText': {
                        await randomDelay(500, 1500);
                        try {
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
                            }
                          } else {
                            const clicked = await page.evaluate((text) => {
                              const elements = [...document.querySelectorAll('*')]
                                .filter(e => e.textContent.includes(text) && 
                                        e.offsetWidth > 0 && 
                                        e.offsetHeight > 0);
                              
                              if (elements.length > 0) {
                                elements[0].click();
                                return true;
                              }
                              return false;
                            }, step.text);
                            
                            if (clicked) {
                              console.log(`Clicked text '${step.text}' using evaluate fallback`);
                              stepSuccess++;
                            }
                          }
                        } catch (err) {
                          console.warn(`Click text failed for '${step.text}': ${err.message}`);
                        }
                        break;
                      }
                      case 'wait':
                        await waitSafely(page, step.time || 1500);
                        stepSuccess++;
                        break;
                    }
                    await waitSafely(page, 1000 + Math.random() * 1000);
                    
                  } catch (err) {
                    console.warn(`Login step error (${step.type}): ${err.message}`);
                    if (page._isClosed) throw new Error('Page closed during login step');
                  }
                }
                
                // Check for successful login
                await waitSafely(page, 3000);
                
                if (page._isClosed) throw new Error('Page closed after login steps');
                
                const currentUrl = page.url();
                
                if (currentUrl !== loginSite.url) {
                  console.log('✅ Login succeeded - URL changed');
                  loginSuccess = true;
                } else if (stepSuccess >= loginSite.steps.length * 0.75) {
                  console.log('✅ Login probably succeeded - most steps completed');
                  loginSuccess = true;
                } else {
                  console.log('❌ Login may have failed - URL unchanged and some steps failed');
                }
                
                // Post-login screenshot
                if (!page._isClosed) {
                  const postLoginScreenshot = await page.screenshot({ type: 'jpeg', quality: 60 });
                  console.log(`📊 Post-login screenshot size: ${postLoginScreenshot.length} bytes`);
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

      // NAVIGATE TO TARGET URL (after login if applicable)
      console.log(`🌐 Navigating to target URL: ${url}`);
      
      if (page._isClosed) throw new Error('Page closed before navigation');
      
      // Enhanced navigation with better timeout handling
      let navigationSuccessful = false;
      const navigationStrategies = [
        { waitUntil: 'domcontentloaded', timeout: 60000, name: 'DOM ready (60s)' },
        { waitUntil: 'load', timeout: 45000, name: 'Full load (45s)' },
        { waitUntil: 'networkidle2', timeout: 30000, name: 'Network idle (30s)' },
        { waitUntil: 'domcontentloaded', timeout: 120000, name: 'Extended DOM (120s)' }
      ];
      
      for (let attempt = 0; attempt < navigationStrategies.length; attempt++) {
        const strategy = navigationStrategies[attempt];
        
        try {
          if (page._isClosed) throw new Error('Page closed during navigation attempt');
          
          console.log(`🎯 Navigation attempt ${attempt + 1}: ${strategy.name}`);
          
          await page.goto(url, { 
            waitUntil: strategy.waitUntil,
            timeout: strategy.timeout
          });
          
          navigationSuccessful = true;
          console.log(`✅ Navigation successful with strategy: ${strategy.name}`);
          break;
          
        } catch (navError) {
          console.warn(`⚠️ Strategy "${strategy.name}" failed: ${navError.message}`);
          
          if (page._isClosed) throw new Error('Page closed during navigation');
          
          // For timeout errors, try a quick recovery
          if (navError.message.includes('timeout') || navError.message.includes('Navigation timeout')) {
            try {
              console.log('🔄 Attempting timeout recovery...');
              
              // Stop any pending navigation
              await page.evaluate(() => window.stop()).catch(() => {});
              
              // Check if page actually loaded despite timeout
              const currentUrl = page.url();
              const hasContent = await page.evaluate(() => {
                return document.body && document.body.children.length > 0;
              }).catch(() => false);
              
              if (currentUrl !== 'about:blank' && hasContent) {
                console.log(`🎯 Page actually loaded despite timeout: ${currentUrl}`);
                navigationSuccessful = true;
                break;
              }
              
              // Clear any dialogs that might be blocking
              await page.evaluate(() => {
                if (window.alert) window.alert = () => true;
                if (window.confirm) window.confirm = () => true;
                if (window.prompt) window.prompt = () => '';
              }).catch(() => {});
              
            } catch (recoveryError) {
              console.warn(`Recovery attempt failed: ${recoveryError.message}`);
            }
          }
          
          // If this is the last attempt, we still need to try
          if (attempt === navigationStrategies.length - 1) {
            console.error('❌ All navigation strategies failed');
            
            // Final desperate attempt - try to use whatever is loaded
            try {
              const currentUrl = page.url();
              if (currentUrl !== 'about:blank' && currentUrl !== 'chrome-error://') {
                console.log(`🚨 Using partially loaded page: ${currentUrl}`);
                navigationSuccessful = true;
                break;
              }
            } catch (e) {}
            
            if (!navigationSuccessful) {
              throw new Error(`Navigation failed after all strategies: ${navError.message}`);
            }
          }
          
          // Wait before next strategy
          await waitSafely(page, 3000);
        }
      }
      
      // SCROLL PAGE for price visibility
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
          console.warn('⚠️ Error during scrolling:', scrollError.message);
          if (page._isClosed) throw new Error('Page closed during scrolling');
        }
      }

      // DISMISS COOKIES
      if (!page._isClosed) {
        await dismissCookies(page);
      }

      // TAKE SCREENSHOT with price-quality settings
      if (page._isClosed) {
        throw new Error('Page closed before taking screenshot');
      }
      
      console.log(`📸 Taking screenshot for price analysis with page ${page._poolId}`);
      
      // Memory cleanup before screenshot
      try {
        if (!page._isClosed) {
          await page.evaluate(() => {
            if (typeof window.gc === 'function') window.gc();
          });
        }
      } catch (e) {
        console.warn('Memory cleanup failed:', e.message);
        if (page._isClosed) throw new Error('Page closed during memory cleanup');
      }
      
      // Screenshot with retries
      let screenshot = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (page._isClosed) throw new Error('Page closed before screenshot attempt');
          
          console.log(`📸 Screenshot attempt ${attempt}`);
          screenshot = await Promise.race([
            page.screenshot({ 
              type: 'jpeg', 
              quality: MEMORY_LIMITS.SCREENSHOT_QUALITY, // Higher quality for price text
              fullPage: false, 
              clip: {x:0, y:0, width: MEMORY_LIMITS.SCREENSHOT_WIDTH, height: MEMORY_LIMITS.SCREENSHOT_HEIGHT}
            }),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Screenshot timeout')), 45000)
            )
          ]);
          console.log(`✅ Screenshot captured successfully on attempt ${attempt} (${screenshot.length} bytes)`);
          break;
        } catch (screenshotError) {
          console.warn(`⚠️ Screenshot attempt ${attempt} failed:`, screenshotError.message);
          
          if (page._isClosed) throw new Error('Page closed during screenshot');
          
          if (attempt === 3) {
            console.error('❌ All screenshot attempts failed, trying fallback method');
            
            try {
              if (!page._isClosed) {
                screenshot = await page.screenshot({ 
                  type: 'jpeg',
                  quality: 50,
                  fullPage: false,
                  clip: {x:0, y:0, width:800, height:600}
                });
                console.log('✅ Fallback screenshot captured with reduced parameters');
              } else {
                throw new Error('Page closed during fallback screenshot');
              }
            } catch (fallbackError) {
              console.error('❌ Fallback screenshot also failed:', fallbackError.message);
              throw screenshotError;
            }
          } else {
            await waitSafely(page, 3000);
          }
        }
      }
      
      if (screenshot) {
        return { data: screenshot, type: 'image/jpeg' };
      } else {
        throw new Error('Failed to capture screenshot after multiple attempts');
      }

    } catch (error) {
      console.error(`❌ Scrape error: ${error.message}`);
      return { data: JSON.stringify({ success: false, error: error.message }), type: 'application/json' };
    }
  }

  // Main scrape job handler for n8n
  async function runScrapeJob(context) {
    requestCount++;
    const jobId = `login_req_${requestCount}`;
    
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
      page = await pagePool.acquire();
      pageAcquired = true;
      page._inUse = true;
      page._lastActivity = Date.now();
      
      const result = await priceScraper(page, context);
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
          page._inUse = false;
          page._lastActivity = Date.now();
          
          // Minimal cleanup
          await page.evaluate(() => {
            try {
              if (typeof window.gc === 'function') window.gc();
            } catch(e) {}
          }).catch(() => {});
          
          await pagePool.release(page);
        } catch (e) {
          console.error(`${jobId} cleanup error: ${e.message}`);
        }
      }
    }
  }

  // Routes
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
          requestNumber: requestCount,
          loginSupported: true
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
      uptime: Math.round(process.uptime()),
      loginSupported: true,
      features: ['login', 'price-scraping', 'memory-optimized']
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
      },
      loginCapable: true
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
  }, 15000); // Check every 15 seconds

  // Start server
  const server = app.listen(3000, async () => {
    console.log('🟢 n8n server with login support running on :3000');
    console.log(`📊 Memory limits: ${MEMORY_LIMITS.RESTART_THRESHOLD}MB restart threshold`);
    console.log(`🔄 Auto-restart after ${MEMORY_LIMITS.MAX_REQUESTS_BEFORE_RESTART} requests`);
    console.log(`🔐 Login support: ENABLED for price access`);
    console.log(`⚡ Optimized for n8n individual API calls with credentials`);
    
    try {
      const url = await connectToNgrok();
      console.log(`🌐 Available for n8n at: ${url}/scrape`);
      console.log(`💡 Send login instructions & credentials in request body`);
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