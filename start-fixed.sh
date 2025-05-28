#!/bin/bash
# start-fixed.sh - Fixed startup script for n8n with ngrok

# Only set memory limit in NODE_OPTIONS (--expose-gc must be passed directly to node)
export NODE_OPTIONS="--max-old-space-size=1536"
export NGROK_AUTH_TOKEN="2cKYrd2xutXBO4roxT0EVg21omR_7vNj3TmNX685FTtho1Wh9"

echo "🚀 Starting n8n-optimized server with ngrok"
echo "💾 Memory limit: 1536MB"
echo "🔧 Garbage collection: Will be enabled via direct flag"
echo ""

# Clean up any existing processes
echo "🧹 Cleaning up existing processes..."
pkill -f "server-n8n-with-login.mjs" 2>/dev/null || true
pkill -f "chrome" 2>/dev/null || true
sleep 2

# Check if the server file exists
if [ ! -f "server-n8n-with-login.mjs" ]; then
    echo "❌ server-n8n-with-login.mjs not found!"
    echo "💡 Make sure you're in the correct directory"
    exit 1
fi

echo "📁 Current directory: $(pwd)"
echo "📄 Server file found: ✅"
echo ""

# Start the server with --expose-gc passed directly to node (not via NODE_OPTIONS)
echo "🟢 Starting server with ngrok integration..."
node --expose-gc server-n8n-with-login.mjs