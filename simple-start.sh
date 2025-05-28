#!/bin/bash
# simple-start.sh - Simple startup script that should work

# Set basic Node.js memory limits (only valid flags)
export NODE_OPTIONS="--max-old-space-size=1536 --expose-gc"
export NGROK_AUTH_TOKEN="2cKYrd2xutXBO4roxT0EVg21omR_7vNj3TmNX685FTtho1Wh9"

echo "🚀 Starting n8n-optimized server (simple version)"
echo "💾 Memory limit: 1536MB"
echo "🔧 Garbage collection: Enabled"
echo ""

# Clean up any existing processes
echo "🧹 Cleaning up existing processes..."
pkill -f "server-n8n-optimized.mjs" 2>/dev/null || true
pkill -f "chrome" 2>/dev/null || true
sleep 2

# Check if the server file exists
if [ ! -f "server-n8n-optimized.mjs" ]; then
    echo "❌ server-n8n-optimized.mjs not found!"
    echo "💡 Make sure you're in the correct directory"
    exit 1
fi

echo "📁 Current directory: $(pwd)"
echo "📄 Server file: $(ls -la server-n8n-optimized.mjs 2>/dev/null || echo 'NOT FOUND')"
echo ""

# Start the server directly
echo "🟢 Starting server..."
node server-n8n-optimized.mjs