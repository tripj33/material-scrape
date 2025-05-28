#!/bin/bash
# start-n8n-optimized.sh - Startup script optimized for n8n making 3000 individual requests

# CRITICAL: Very strict memory limits for n8n workload
export NODE_OPTIONS="--max-old-space-size=1536 --max-semi-space-size=32 --optimize-for-size --gc-interval=50 --expose-gc"

# Set ngrok auth token
export NGROK_AUTH_TOKEN="2cKYrd2xutXBO4roxT0EVg21omR_7vNj3TmNX685FTtho1Wh9"

# Process manager settings
export MAX_MEMORY_RESTART="800M"
export RESTART_DELAY="5"

echo "🎯 Starting n8n-optimized scraper server"
echo "📊 System: 4GB RAM Lenovo ThinkCentre M600"
echo "🔢 Expected load: 3000 individual API calls from n8n"
echo "💾 Node.js heap limit: 1536MB"
echo "🔄 Auto-restart threshold: 700MB"
echo "⚡ Process restart after 500 requests"
echo ""

# System optimization
echo "🔧 Optimizing system for high-frequency requests..."

# Linux memory optimization
if command -v sysctl &> /dev/null; then
    sudo sysctl vm.swappiness=5 2>/dev/null || echo "Could not adjust swappiness"
    sudo sysctl vm.overcommit_memory=1 2>/dev/null || echo "Could not adjust overcommit"
    sudo sysctl net.core.somaxconn=1024 2>/dev/null || echo "Could not adjust socket queue"
fi

# Clear system cache
if command -v sync &> /dev/null; then
    echo "🧹 Clearing system cache..."
    sync
    if [ -w /proc/sys/vm/drop_caches ]; then
        echo 3 | sudo tee /proc/sys/vm/drop_caches > /dev/null 2>&1 || echo "Could not clear cache"
    fi
fi

# Kill any existing processes
echo "🧹 Cleaning up existing processes..."
pkill -f "server-n8n-optimized.mjs" 2>/dev/null || true
pkill -f "chrome" 2>/dev/null || true
pkill -f "chromium" 2>/dev/null || true
sleep 2

# Display memory status
echo "📊 Current system memory:"
if command -v free &> /dev/null; then
    free -h
fi
echo ""

# Function to monitor system memory and restart if critical
monitor_system_memory() {
    while true; do
        sleep 30  # Check every 30 seconds
        
        # Check if server process is running
        if ! pgrep -f "server-n8n-optimized.mjs" > /dev/null; then
            echo "⚠️ Server process died, will restart..."
            break
        fi
        
        # Check available system memory
        if command -v free &> /dev/null; then
            AVAILABLE_MB=$(free -m | awk 'NR==2{print $7}')
            USED_PERCENT=$(free | awk 'NR==2{print int($3/$2*100)}')
            
            if [ "$AVAILABLE_MB" -lt 150 ]; then
                echo "🚨 CRITICAL: Only ${AVAILABLE_MB}MB available memory!"
                echo "🔄 Killing server to prevent system freeze..."
                pkill -f "server-n8n-optimized.mjs"
                sleep 3
                break
            elif [ "$USED_PERCENT" -gt 90 ]; then
                echo "⚠️ WARNING: ${USED_PERCENT}% memory usage (${AVAILABLE_MB}MB available)"
            fi
        fi
        
        # Check for zombie Chrome processes
        CHROME_COUNT=$(pgrep -c chrome 2>/dev/null || echo "0")
        if [ "$CHROME_COUNT" -gt 5 ]; then
            echo "⚠️ Too many Chrome processes ($CHROME_COUNT), cleaning up..."
            pkill -f chrome 2>/dev/null || true
        fi
    done
}

# Function to check if n8n is ready
check_n8n_connection() {
    echo "🔍 Checking if server is responsive..."
    for i in {1..10}; do
        if curl -s http://localhost:3000/healthz > /dev/null 2>&1; then
            echo "✅ Server is ready for n8n requests"
            echo "🌐 Endpoint: http://localhost:3000/scrape"
            return 0
        fi
        echo "⏳ Waiting for server... (attempt $i/10)"
        sleep 2
    done
    echo "❌ Server not responding after 20 seconds"
    return 1
}

# Start memory monitor in background
monitor_system_memory &
MONITOR_PID=$!

# Main server loop with aggressive restart policy
RESTART_COUNT=0
MAX_RESTARTS=20  # Allow more restarts for n8n workload

while [ $RESTART_COUNT -lt $MAX_RESTARTS ]; do
    echo ""
    echo "🚀 Starting server (attempt $((RESTART_COUNT + 1))/$MAX_RESTARTS) at $(date)"
    
    # Start the n8n-optimized server
    timeout 7200 node server-n8n-optimized.mjs &  # 2 hour timeout
    SERVER_PID=$!
    
    # Wait a bit for server to start
    sleep 5
    
    # Check if server started successfully
    if ! check_n8n_connection; then
        echo "❌ Server failed to start properly"
        kill $SERVER_PID 2>/dev/null || true
        RESTART_COUNT=$((RESTART_COUNT + 1))
        continue
    fi
    
    # Wait for server to exit
    wait $SERVER_PID
    EXIT_CODE=$?
    
    echo "🔴 Server exited with code $EXIT_CODE at $(date)"
    
    # Clean up processes
    pkill -f chrome 2>/dev/null || true
    pkill -f chromium 2>/dev/null || true
    
    # Determine if we should restart
    if [ $EXIT_CODE -eq 0 ] || [ $EXIT_CODE -eq 130 ] || [ $EXIT_CODE -eq 143 ]; then
        echo "📴 Graceful shutdown detected"
        break
    elif [ $EXIT_CODE -eq 124 ]; then
        echo "⏰ Server timeout (2 hours) - this is normal for long n8n workflows"
        # Don't count timeout as a failure
    else
        echo "💥 Server crashed (exit code: $EXIT_CODE)"
        RESTART_COUNT=$((RESTART_COUNT + 1))
    fi
    
    # Memory cleanup between restarts
    echo "🧹 Cleaning up before restart..."
    if command -v sync &> /dev/null; then
        sync
        if [ -w /proc/sys/vm/drop_caches ]; then
            echo 1 | sudo tee /proc/sys/vm/drop_caches > /dev/null 2>&1 || true
        fi
    fi
    
    echo "⏳ Waiting ${RESTART_DELAY} seconds before restart..."
    sleep $RESTART_DELAY
done

# Cleanup
echo ""
echo "🧹 Final cleanup..."
kill $MONITOR_PID 2>/dev/null || true
pkill -f "server-n8n-optimized.mjs" 2>/dev/null || true
pkill -f chrome 2>/dev/null || true
pkill -f chromium 2>/dev/null || true

if [ $RESTART_COUNT -ge $MAX_RESTARTS ]; then
    echo "❌ Maximum restart attempts reached ($MAX_RESTARTS)"
    echo "💡 This may indicate a persistent issue with the system or workload"
    echo "💡 Consider reducing n8n's request rate or increasing system resources"
    exit 1
else
    echo "✅ Server shutdown complete"
    exit 0
fi status unavailable"
fi

echo ""
echo "🚀 Starting memory-optimized server..."
echo "📈 Node.js heap limit: 1536MB"
echo "🔄 Garbage collection: Aggressive"
echo "📸 Screenshot quality: Low (40%)"
echo "🖼️  Screenshot size: 1024x576"
echo ""

# Function to monitor memory and restart if needed
monitor_memory() {
    while true; do
        sleep 60
        
        # Check if Node.js process is running
        if ! pgrep -f "server-optimized.mjs" > /dev/null; then
            echo "⚠️ Server process not running, restarting..."
            break
        fi
        
        # Check system memory
        if command -v free &> /dev/null; then
            AVAILABLE_MB=$(free -m | awk 'NR==2{print $7}')
            if [ "$AVAILABLE_MB" -lt 200 ]; then
                echo "⚠️ Low system memory (${AVAILABLE_MB}MB available), restarting server..."
                pkill -f "server-optimized.mjs"
                sleep 5
                break
            fi
        fi
    done
}

# Start memory monitor in background
monitor_memory &
MONITOR_PID=$!

# Main server loop with auto-restart
while true; do
    echo "🟢 Starting server at $(date)"
    
    # Start the optimized server
    node server-optimized.mjs
    
    EXIT_CODE=$?
    echo "🔴 Server exited with code $EXIT_CODE at $(date)"
    
    # If server exits with specific codes, don't restart
    if [ $EXIT_CODE -eq 0 ] || [ $EXIT_CODE -eq 130 ]; then
        echo "📴 Graceful shutdown detected, stopping..."
        break
    fi
    
    echo "⏳ Waiting 10 seconds before restart..."
    sleep 10
    
    # Clear any lingering processes
    pkill -f "chrome" 2>/dev/null || true
    pkill -f "chromium" 2>/dev/null || true
    
    # Force garbage collection at system level if possible
    if command -v sync &> /dev/null; then
        sync
    fi
done

# Cleanup
echo "🧹 Cleaning up..."
kill $MONITOR_PID 2>/dev/null || true
pkill -f "chrome" 2>/dev/null || true
pkill -f "chromium" 2>/dev/null || true

echo "✅ Shutdown complete"