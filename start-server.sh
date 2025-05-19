#!/bin/bash
# start-server.sh - Start ngrok and server together

# Set environment variables
export NODE_OPTIONS="--max-old-space-size=1024"
export NGROK_AUTH_TOKEN="2cKYrd2xutXBO4roxT0EVg21omR_7vNj3TmNX685FTtho1Wh9"

# First, modify server.mjs to not try to start ngrok - create a temporary file
TEMP_SERVER="temp-server.mjs"
cp server.mjs $TEMP_SERVER

# Replace the connectToNgrok function in the temporary file
sed -i 's/async function connectToNgrok() {/async function connectToNgrok() {\n  console.log("Running in local-only mode");\n  return "http:\/\/localhost:3000";\n/g' $TEMP_SERVER

# Start the server in the background
echo "Starting server..."
node $TEMP_SERVER &
SERVER_PID=$!

# Wait for the server to initialize
echo "Waiting for server to start..."
sleep 5

# Start ngrok CLI if it exists
if command -v ngrok &> /dev/null; then
    echo "Starting ngrok tunnel..."
    # Configure ngrok
    mkdir -p $HOME/.config/ngrok
    echo "version: 2" > $HOME/.config/ngrok/ngrok.yml
    echo "authtoken: $NGROK_AUTH_TOKEN" >> $HOME/.config/ngrok/ngrok.yml
    
    # Start ngrok in the foreground
    ngrok http 3000
    
    # When ngrok is closed, kill the server
    kill $SERVER_PID
else
    echo "Ngrok CLI not found. Install it with: npm install -g ngrok"
    echo "Server is running at http://localhost:3000"
    echo "Press Ctrl+C to stop the server."
    # Keep script running until Ctrl+C
    wait $SERVER_PID
fi

# Cleanup
rm -f $TEMP_SERVER