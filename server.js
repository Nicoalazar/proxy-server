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

  // Forward important client headers, override User-Agent
  const forwardHeaders = {};
  const headersToForward = [
    "accept", "accept-encoding", "accept-language",
    "range", "if-range", "if-none-match", "if-modified-since",
    "connection", "cache-control",
  ];
  for (const h of headersToForward) {
    if (req.headers[h]) forwardHeaders[h] = req.headers[h];
  }
  // Always use Magma Player UA (provider may filter by this)
  forwardHeaders["user-agent"] = "Magma Player/10";
  if (!forwardHeaders["accept"]) forwardHeaders["accept"] = "*/*";

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers: forwardHeaders,
  };

  const proxyReq = client.request(options, (proxyRes) => {
    console.log(`[PROXY] ${proxyRes.statusCode} ${parsed.pathname}`);

    // Follow redirects (301, 302, 303, 307, 308)
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
      if (maxRedirects <= 0) {
        console.error("[PROXY] Too many redirects");
        return res.status(502).json({ error: "Too many redirects" });
      }

      const redirectUrl = new URL(proxyRes.headers.location, targetUrl).toString();
      console.log(`[PROXY] Redirect → ${redirectUrl}`);
      proxyRes.resume();
      return proxyRequest(redirectUrl, req, res, maxRedirects - 1);
    }

    // Clean up headers before forwarding to client
    const responseHeaders = { ...proxyRes.headers };
    // Remove headers that could conflict with proxy
    delete responseHeaders["transfer-encoding"];
    delete responseHeaders["content-security-policy"];

    res.writeHead(proxyRes.statusCode, responseHeaders);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    console.error(`[PROXY] Error: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: "Bad gateway", details: err.message });
    }
  });

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
// 2) get.php — Generate M3U from JSON API
//    The provider doesn't have /get.php, so we build
//    the M3U playlist from player_api.php responses
// =====================================================
app.all("/get.php", (req, res) => {
  console.log(`[M3U] Incoming request: ${req.method} ${req.originalUrl}`);
  const { username, password } = extractCredentials(req);

  if (!authenticate(username, password)) {
    return res.status(401).send("Unauthorized");
  }

  const proxyUser = PROXY_USERNAME;
  const proxyPass = PROXY_PASSWORD;

  // Fetch categories and streams from provider's JSON API
  const categoriesUrl = `${PROVIDER_URL}/player_api.php?username=${PROVIDER_USERNAME}&password=${PROVIDER_PASSWORD}&action=get_live_categories`;
  const streamsUrl = `${PROVIDER_URL}/player_api.php?username=${PROVIDER_USERNAME}&password=${PROVIDER_PASSWORD}&action=get_live_streams`;

  console.log(`[M3U] Fetching categories and streams from provider...`);

  Promise.all([fetchJson(categoriesUrl), fetchJson(streamsUrl)])
    .then(([categories, streams]) => {
      console.log(`[M3U] Got ${categories.length} categories, ${streams.length} streams`);

      // Build category lookup map
      const categoryMap = {};
      for (const cat of categories) {
        const catId = cat.category_id || cat.id || cat.a;
        const catName = cat.category_name || cat.name || cat.b;
        if (catId && catName) {
          categoryMap[catId] = catName;
        }
      }

      // Determine the proxy's own base URL from the incoming request
      const proto = req.headers["x-forwarded-proto"] || req.protocol;
      const host = req.headers["host"];
      const proxyBaseUrl = `${proto}://${host}`;

      // Build M3U content
      let m3u = "#EXTM3U\n";

      for (const stream of streams) {
        const id = stream.stream_id || stream.id || stream.a;
        const name = stream.name || stream.b || stream.stream_name || "Unknown";
        const icon = stream.stream_icon || stream.img || stream.c || "";
        const catId = stream.category_id || stream.category || "";
        const catName = categoryMap[catId] || "Uncategorized";
        const ext = stream.container_extension || "ts";

        // Build EXTINF line
        m3u += `#EXTINF:-1 tvg-id="${id}" tvg-name="${name}" tvg-logo="${icon}" group-title="${catName}",${name}\n`;

        // Stream URL pointing to THIS proxy
        m3u += `${proxyBaseUrl}/live/${proxyUser}/${proxyPass}/${id}.${ext}\n`;
      }

      res.set("Content-Type", "audio/mpegurl");
      res.set("Content-Disposition", 'attachment; filename="playlist.m3u"');
      res.send(m3u);
    })
    .catch((err) => {
      console.error(`[M3U] Error generating playlist: ${err.message}`);
      res.status(502).json({ error: "Failed to generate M3U", details: err.message });
    });
});

// --- Helper: fetch JSON from a URL ---
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent": "Magma Player/10",
        Accept: "application/json",
      },
    };

    const req = client.request(options, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return fetchJson(new URL(res.headers.location, url).toString()).then(resolve).catch(reject);
      }

      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON from provider (HTTP ${res.statusCode}): ${data.substring(0, 200)}`));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

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
