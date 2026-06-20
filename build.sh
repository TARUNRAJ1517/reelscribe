#!/bin/bash

# Node packages install
npm install

# yt-dlp install
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp

echo "✅ yt-dlp installed: $(yt-dlp --version)"
