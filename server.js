const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced User-Agent rotation
const userAgents = [
  // Chrome
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  // Firefox
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0',
  // Safari
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Safari/605.1.15',
  // Mobile
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.210 Mobile Safari/537.36',
  // Smart TV
  'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36',
  // VLC
  'VLC/3.0.18 LibVLC/3.0.18',
  // Other common media players
  'Kodi/20.3 (Windows NT 10.0; Win64; x64) App_Bitness/64 Version/20.3-(20.3.0)-Git:2023-10-01-8e58ecb'
];

// Enhanced proxy endpoint with User-Agent rotation
app.get('/proxy', async (req, res) => {
  try {
    const url = decodeURIComponent(req.query.url);
    if (!url) {
      return res.status(400).json({ error: 'Missing URL parameter' });
    }

    // Randomize headers for each request
    const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
    const headers = {
      'User-Agent': randomUserAgent,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': new URL(url).origin || 'https://www.google.com/',
      'Origin': new URL(url).origin || 'https://www.google.com/',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Accept-Encoding': 'identity', // Important for streaming
      'Cache-Control': 'no-cache'
    };

    // Enhanced timeout handling
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      console.log(`Proxy timeout for URL: ${url}`);
    }, 20000); // 20 second timeout

    console.log(`Proxying URL: ${url} with User-Agent: ${randomUserAgent}`);

    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: 'follow',
      follow: 5 // Maximum redirects
    });

    clearTimeout(timeout);

    // Handle redirects
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (location) {
        console.log(`Redirecting to: ${location}`);
        return res.redirect(`/proxy?url=${encodeURIComponent(location)}`);
      }
    }

    // Set response headers
    const contentType = response.headers.get('content-type') || 
                       (url.includes('.m3u8') ? 'application/vnd.apple.mpegurl' : 
                       url.includes('.mpd') ? 'application/dash+xml' : 
                       'video/mp4');

    res.set({
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Connection': 'keep-alive'
    });

    // Pipe the stream with error handling
    response.body.on('error', (err) => {
      console.error('Stream pipe error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream error', details: err.message });
      }
    });

    response.body.pipe(res);
  } catch (err) {
    console.error('Proxy Error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ 
        error: 'Stream unavailable',
        details: err.message,
        solution: 'The streaming server may be blocking our requests. Try again later.'
      });
    }
  }
});

// ... [Keep all your other existing endpoints and logic]

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Available User-Agents:', userAgents.length);
});
