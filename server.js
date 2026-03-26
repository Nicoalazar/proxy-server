const express = require("express");
const http = require("http");
const https = require("https");
const { URL } = require("url");
require("dotenv").config();

const app = express();

// --- Configuration from .env ---
const PORT = process.env.PORT || 8080;
const PROVIDER_URL = process.env.PROVIDER_URL; // e.g. http://tv.m3uts.xyz
const PROVIDER_USERNAME = process.env.PROVIDER_USERNAME;
const PROVIDER_PASSWORD = process.env.PROVIDER_PASSWORD;
const PROXY_USERNAME = process.env.PROXY_USERNAME;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;

// --- Validate config ---
if (!PROVIDER_URL || !PROVIDER_USERNAME || !PROVIDER_PASSWORD) {
  console.error("Missing PROVIDER_URL, PROVIDER_USERNAME or PROVIDER_PASSWORD in .env");
  process.exit(1);
}

// --- Auth middleware ---
function authenticate(username, password) {
  return username === PROXY_USERNAME && password === PROXY_PASSWORD;
}

function extractCredentials(req) {
  // Credentials come as query params or in the URL path
  const username = req.query.username;
  const password = req.query.password;
  return { username, password };
}

// --- Pipe a request to the real provider (follows redirects) ---
function proxyRequest(targetUrl, req, res, maxRedirects = 5) {
  const parsed = new URL(targetUrl);
  const client = parsed.protocol === "https:" ? https : http;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers: {
      "User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
      Accept: "*/*",
    },
  };

  const proxyReq = client.request(options, (proxyRes) => {
    console.log(`[PROXY] Response from provider: ${proxyRes.statusCode} ${targetUrl}`);

    // Follow redirects (301, 302, 303, 307, 308)
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
      if (maxRedirects <= 0) {
        console.error("[PROXY] Too many redirects");
        return res.status(502).json({ error: "Too many redirects" });
      }

      // Resolve relative redirect URLs
      const redirectUrl = new URL(proxyRes.headers.location, targetUrl).toString();
      console.log(`[PROXY] Following redirect → ${redirectUrl}`);

      // Consume the response body before following redirect
      proxyRes.resume();
      return proxyRequest(redirectUrl, req, res, maxRedirects - 1);
    }

    // Forward status and headers
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    console.error(`Proxy error: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: "Bad gateway", details: err.message });
    }
  });

  // Forward request body if any
  req.pipe(proxyReq, { end: true });
}

// =====================================================
// 1) player_api.php — main Xtream Codes API endpoint
// =====================================================
app.all("/player_api.php", (req, res) => {
  const { username, password } = extractCredentials(req);

  if (!authenticate(username, password)) {
    return res.status(401).json({ user_info: { auth: 0, status: "Disabled" } });
  }

  // Build the real provider URL, replacing credentials
  const params = new URLSearchParams(req.query);
  params.set("username", PROVIDER_USERNAME);
  params.set("password", PROVIDER_PASSWORD);

  const targetUrl = `${PROVIDER_URL}/player_api.php?${params.toString()}`;
  console.log(`[API] ${req.query.action || "info"} → ${PROVIDER_URL}`);

  proxyRequest(targetUrl, req, res);
});

// =====================================================
// 2) get.php — M3U playlist download
// =====================================================
app.all("/get.php", (req, res) => {
  console.log(`[M3U] Incoming request: ${req.method} ${req.originalUrl}`);
  const { username, password } = extractCredentials(req);

  if (!authenticate(username, password)) {
    console.log(`[M3U] Auth failed for user: ${username}`);
    return res.status(401).send("Unauthorized");
  }

  const params = new URLSearchParams(req.query);
  params.set("username", PROVIDER_USERNAME);
  params.set("password", PROVIDER_PASSWORD);

  const targetUrl = `${PROVIDER_URL}/get.php?${params.toString()}`;
  console.log(`[M3U] Proxying to: ${targetUrl}`);

  proxyRequest(targetUrl, req, res);
});

// =====================================================
// 3) xmltv.php — EPG (Electronic Program Guide)
// =====================================================
app.get("/xmltv.php", (req, res) => {
  const { username, password } = extractCredentials(req);

  if (!authenticate(username, password)) {
    return res.status(401).send("Unauthorized");
  }

  const params = new URLSearchParams(req.query);
  params.set("username", PROVIDER_USERNAME);
  params.set("password", PROVIDER_PASSWORD);

  const targetUrl = `${PROVIDER_URL}/xmltv.php?${params.toString()}`;
  console.log(`[EPG] xmltv.php → ${PROVIDER_URL}`);

  proxyRequest(targetUrl, req, res);
});

// =====================================================
// 4) Live streams: /live/username/password/streamId.ts
// =====================================================
app.get("/live/:user/:pass/:streamFile", (req, res) => {
  if (!authenticate(req.params.user, req.params.pass)) {
    return res.status(401).send("Unauthorized");
  }

  const targetUrl = `${PROVIDER_URL}/live/${PROVIDER_USERNAME}/${PROVIDER_PASSWORD}/${req.params.streamFile}`;
  console.log(`[LIVE] ${req.params.streamFile}`);

  proxyRequest(targetUrl, req, res);
});

// =====================================================
// 5) VOD movies: /movie/username/password/streamId.ext
// =====================================================
app.get("/movie/:user/:pass/:streamFile", (req, res) => {
  if (!authenticate(req.params.user, req.params.pass)) {
    return res.status(401).send("Unauthorized");
  }

  const targetUrl = `${PROVIDER_URL}/movie/${PROVIDER_USERNAME}/${PROVIDER_PASSWORD}/${req.params.streamFile}`;
  console.log(`[MOVIE] ${req.params.streamFile}`);

  proxyRequest(targetUrl, req, res);
});

// =====================================================
// 6) Series: /series/username/password/streamId.ext
// =====================================================
app.get("/series/:user/:pass/:streamFile", (req, res) => {
  if (!authenticate(req.params.user, req.params.pass)) {
    return res.status(401).send("Unauthorized");
  }

  const targetUrl = `${PROVIDER_URL}/series/${PROVIDER_USERNAME}/${PROVIDER_PASSWORD}/${req.params.streamFile}`;
  console.log(`[SERIES] ${req.params.streamFile}`);

  proxyRequest(targetUrl, req, res);
});

// =====================================================
// 7) Timeshift: /timeshift/username/password/...
// =====================================================
app.get("/timeshift/:user/:pass/:duration/:start/:streamFile", (req, res) => {
  if (!authenticate(req.params.user, req.params.pass)) {
    return res.status(401).send("Unauthorized");
  }

  const { duration, start, streamFile } = req.params;
  const targetUrl = `${PROVIDER_URL}/timeshift/${PROVIDER_USERNAME}/${PROVIDER_PASSWORD}/${duration}/${start}/${streamFile}`;
  console.log(`[TIMESHIFT] ${streamFile}`);

  proxyRequest(targetUrl, req, res);
});

// =====================================================
// 8) HLS segments for live streams (m3u8 rewriting)
// =====================================================
app.get("/live/:user/:pass/:streamId/:segment", (req, res) => {
  if (!authenticate(req.params.user, req.params.pass)) {
    return res.status(401).send("Unauthorized");
  }

  const targetUrl = `${PROVIDER_URL}/live/${PROVIDER_USERNAME}/${PROVIDER_PASSWORD}/${req.params.streamId}/${req.params.segment}`;
  proxyRequest(targetUrl, req, res);
});

// =====================================================
// Health check
// =====================================================
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    provider: PROVIDER_URL,
    timestamp: new Date().toISOString(),
  });
});

// =====================================================
// Start server
// =====================================================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n=== Magma IPTV Proxy Server ===`);
  console.log(`Listening on port ${PORT}`);
  console.log(`Provider: ${PROVIDER_URL}`);
  console.log(`Proxy credentials: ${PROXY_USERNAME} / ${PROXY_PASSWORD}`);
  console.log(`\nUsers should configure in the app:`);
  console.log(`  URL:      http://YOUR_VPS_IP:${PORT}`);
  console.log(`  Username: ${PROXY_USERNAME}`);
  console.log(`  Password: ${PROXY_PASSWORD}\n`);
});
