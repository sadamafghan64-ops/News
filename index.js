const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const express = require("express");
const axios = require("axios");
const Parser = require("rss-parser");
const pino = require("pino");
const QRCode = require("qrcode");
const fs = require("fs");

const config = require("./config.json");

const app = express();
const parser = new Parser();

const PORT = process.env.PORT || 10000;
const SESSION_DIR = "./whatsapp_sessions";
const DATA_FILE = "./posted_news.json";

let sock = null;
let channelId = null;
let isConnected = false;
let isCheckingNews = false;
let currentQR = null;
let reconnectTimer = null;
let isStarting = false;

let postedNews = [];
let initializedSources = [];

if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(
      fs.readFileSync(DATA_FILE, "utf8")
    );

    if (Array.isArray(saved)) {
      postedNews = saved;
    } else {
      postedNews = saved.postedNews || [];
      initializedSources = saved.initializedSources || [];
    }
  } catch (error) {
    console.log("Could not read saved news data.");
  }
}

// ================================
// WEB SERVER
// ================================

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>WhatsApp News Bot</title>
      </head>
      <body style="font-family:Arial;text-align:center;padding:25px">
        <h2>📰 WhatsApp News Bot</h2>
        <p>Channel: ${config.channelName}</p>
        <p>WhatsApp: ${isConnected ? "Connected ✅" : "Waiting ⏳"}</p>
        <p>News sources: ${config.newsSources.length}</p>
        <p><a href="/qr">Open WhatsApp QR Code</a></p>
        <p><a href="/health">Bot Health</a></p>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    bot: "WhatsApp News Bot",
    connected: isConnected,
    qrAvailable: Boolean(currentQR),
    channel: config.channelName,
    channelResolved: Boolean(channelId),
    postedNewsCount: postedNews.length,
    newsSources: config.newsSources.length
  });
});

// QR CODE PAGE
app.get("/qr", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (isConnected) {
    return res.send(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta http-equiv="refresh" content="10">
        </head>
        <body style="font-family:Arial;text-align:center;padding:25px">
          <h2>✅ WhatsApp Connected</h2>
          <p>WhatsApp is already connected.</p>
          <p><a href="/health">Check Bot Status</a></p>
        </body>
      </html>
    `);
  }

  if (!currentQR) {
    return res.send(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta http-equiv="refresh" content="5">
        </head>
        <body style="font-family:Arial;text-align:center;padding:25px">
          <h2>⏳ Waiting for QR Code</h2>
          <p>The bot is waiting for WhatsApp.</p>
          <p>This page refreshes automatically every 5 seconds.</p>
          <p>If the QR does not appear, check the server console.</p>
        </body>
      </html>
    `);
  }

  try {
    const qrImage = await QRCode.toDataURL(currentQR);

    res.send(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta http-equiv="refresh" content="20">
          <title>WhatsApp QR Code</title>
        </head>
        <body style="font-family:Arial;text-align:center;padding:20px">
          <h2>📱 Connect WhatsApp</h2>
          <p>Open WhatsApp on your phone.</p>
          <p>Go to Settings → Linked devices → Link a device.</p>
          <img src="${qrImage}" style="width:280px;max-width:90%;height:auto">
          <p>Scan this QR code before it expires.</p>
          <p>This page refreshes automatically.</p>
        </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send("Could not generate QR code.");
  }
});

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
  console.log("QR page endpoint: /qr");
});

// ================================
// SAVE NEWS DATA
// ================================

function savePostedNews() {
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(
      {
        postedNews,
        initializedSources
      },
      null,
      2
    )
  );
}

// ================================
// CHANNEL CONNECTION
// ================================

function getInviteCode(url) {
  const match = url.match(/channel\/([A-Za-z0-9]+)/);
  return match ? match[1] : null;
}

async function connectChannel() {
  const inviteCode = getInviteCode(config.channelLink);

  if (!inviteCode) {
    console.log("ERROR: Invalid WhatsApp channel link.");
    return;
  }

  try {
    const metadata = await sock.newsletterMetadata(
      "invite",
      inviteCode
    );

    channelId = metadata.id;

    console.log("WhatsApp channel found.");
    console.log("Channel ID:", channelId);
  } catch (error) {
    channelId = null;

    console.log(
      "Could not identify the channel:",
      error.message
    );
  }
}

// ================================
// FIND NEWS RSS FEEDS
// ================================

async function discoverFeed(sourceUrl) {
  try {
    if (/\.(rss|xml)(\?.*)?$/i.test(sourceUrl)) {
      return sourceUrl;
    }

    const response = await axios.get(sourceUrl, {
      timeout: 15000,
      headers: {
        "User-Agent": "WhatsAppNewsBot/1.0"
      }
    });

    const html = response.data;

    if (typeof html !== "string") {
      return null;
    }

    const links = [
      ...html.matchAll(/<link\b[^>]*>/gi)
    ];

    for (const result of links) {
      const tag = result[0];

      if (
        /application\/(rss\+xml|atom\+xml)/i.test(tag)
      ) {
        const href = tag.match(
          /\bhref=["']([^"']+)["']/i
        );

        if (href) {
          return new URL(href[1], sourceUrl).href;
        }
      }
    }

    if (/<rss[\s>]|<feed[\s>]|<rdf:RDF[\s>]/i.test(html)) {
      return sourceUrl;
    }

    return null;
  } catch (error) {
    console.log(
      "Feed discovery failed:",
      sourceUrl,
      error.message
    );

    return null;
  }
}

// ================================
// CLEAN NEWS TEXT
// ================================

function cleanText(text = "") {
  return String(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ================================
// PUBLISH NEWS TO CHANNEL
// ================================

async function publishNews(source, item) {
  if (!sock || !isConnected || !channelId) {
    console.log("Waiting for WhatsApp channel connection.");
    return false;
  }

  const title = cleanText(item.title || "نوی خبر");

  const description = cleanText(
    item.contentSnippet || item.summary || ""
  );

  const articleUrl = item.link || source.url;

  const message = [
    `📰 ${title}`,
    "",
    description.slice(0, 1200),
    "",
    `📌 سرچینه: ${source.name}`,
    `🔗 د خبر لینک: ${articleUrl}`,
    "",
    `📢 چینل: ${config.channelName}`
  ].filter(Boolean).join("\n");

  try {
    await sock.sendMessage(channelId, {
      text: message
    });

    console.log("News published:", title);

    return true;
  } catch (error) {
    console.log(
      "Publishing failed:",
      title,
      error.message
    );

    return false;
  }
}

// ================================
// CHECK FOR NEW NEWS
// ================================

async function checkNews() {
  if (isCheckingNews || !isConnected || !channelId) {
    return;
  }

  isCheckingNews = true;

  try {
    for (const source of config.newsSources) {
      const feedUrl = await discoverFeed(source.url);

      if (!feedUrl) {
        console.log(
          "No RSS feed discovered for:",
          source.name
        );
        continue;
      }

      try {
        const feed = await parser.parseURL(feedUrl);
        const items = feed.items || [];

        // On the first successful scan, save existing
        // articles as a baseline instead of publishing
        // every old article at once.
        if (!initializedSources.includes(source.name)) {
          for (const item of items) {
            const key = item.guid || item.link || item.title;

            if (key && !postedNews.includes(key)) {
              postedNews.push(key);
            }
          }

          initializedSources.push(source.name);
          savePostedNews();

          console.log(
            "Initial news scan completed for:",
            source.name
          );

          continue;
        }

        // Process older items first.
        for (const item of [...items].reverse()) {
          const key = item.guid || item.link || item.title;

          if (!key || postedNews.includes(key)) {
            continue;
          }

          const success = await publishNews(source, item);

          if (success) {
            postedNews.push(key);
            savePostedNews();
          } else {
            // Try again on the next check.
            break;
          }
        }
      } catch (error) {
        console.log(
          "Could not read source:",
          source.name,
          error.message
        );
      }
    }
  } catch (error) {
    console.log("News check error:", error.message);
  } finally {
    isCheckingNews = false;
  }
}

// ================================
// CONNECT WHATSAPP
// ================================

async function startWhatsApp() {
  if (isStarting) return;

  isStarting = true;

  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });

    const { state, saveCreds } =
      await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      browser: ["News Bot", "Chrome", "1.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        console.log("QR available. Open /qr in your browser.");
      }

      if (connection === "open") {
        currentQR = null;
        isConnected = true;

        console.log("WhatsApp connected successfully.");

        await connectChannel();

        if (channelId) {
          checkNews();
        }
      }

      if (connection === "close") {
        isConnected = false;
        currentQR = null;
        channelId = null;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        if (statusCode !== DisconnectReason.loggedOut) {
          console.log("WhatsApp disconnected. Reconnecting...");

          if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              isStarting = false;

              startWhatsApp().catch((error) => {
                console.log("Reconnect error:", error.message);
              });
            }, 5000);
          }
        } else {
          console.log(
            "WhatsApp logged out. Delete the old session only if you need to link again."
          );
        }
      }
    });
  } catch (error) {
    console.error("WhatsApp startup error:", error.message);
  } finally {
    isStarting = false;
  }
}

// ================================
// AUTOMATIC NEWS CHECK
// ================================

setInterval(
  checkNews,
  Math.max(1, config.checkIntervalMinutes || 5) * 60 * 1000
);

startWhatsApp().catch((error) => {
  console.error("Startup error:", error);
});
