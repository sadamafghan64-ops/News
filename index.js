const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const express = require("express");
const axios = require("axios");
const Parser = require("rss-parser");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const config = require("./config.json");

const app = express();
const parser = new Parser();

const PORT = process.env.PORT || 10000;
const SESSION_DIR = "./whatsapp_sessions";
const DATA_FILE = "./posted_news.json";

let sock;
let channelId = null;
let isConnected = false;
let isCheckingNews = false;

let postedNews = fs.existsSync(DATA_FILE)
  ? JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
  : [];

app.get("/", (req, res) => {
  res.send(`
    <h2>WhatsApp News Bot</h2>
    <p>Channel: ${config.channelName}</p>
    <p>WhatsApp: ${isConnected ? "Connected" : "Waiting"}</p>
    <p>News sources: ${config.newsSources.length}</p>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    bot: "WhatsApp News Bot",
    connected: isConnected,
    channel: config.channelName,
    channelResolved: Boolean(channelId),
    postedNewsCount: postedNews.length
  });
});

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});

function savePostedNews() {
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(postedNews, null, 2)
  );
}

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

    if (
      /<rss[\s>]|<feed[\s>]|<rdf:RDF[\s>]/i.test(html)
    ) {
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

function cleanText(text = "") {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

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
    `📢 زموږ چینل: ${config.channelName}`
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

        for (const item of [...feed.items].reverse()) {
          const key = item.guid || item.link || item.title;

          if (!key || postedNews.includes(key)) {
            continue;
          }

          const success = await publishNews(source, item);

          if (success) {
            postedNews.push(key);
            savePostedNews();
          } else {
            // Stop this source if publishing fails.
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

async function startWhatsApp() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  const { state, saveCreds } =
    await useMultiFileAuthState(SESSION_DIR);

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    browser: ["News Bot", "Chrome", "1.0.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      isConnected = true;
      console.log("WhatsApp connected.");

      await connectChannel();

      if (channelId) {
        checkNews();
      }
    }

    if (connection === "close") {
      isConnected = false;
      channelId = null;

      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      if (statusCode !== DisconnectReason.loggedOut) {
        console.log("Reconnecting to WhatsApp...");

        setTimeout(startWhatsApp, 5000);
      } else {
        console.log(
          "WhatsApp logged out. Re-link the device."
        );
      }
    }
  });
}

setInterval(
  checkNews,
  Math.max(1, config.checkIntervalMinutes || 5) * 60 * 1000
);

startWhatsApp().catch((error) => {
  console.error("Startup error:", error);
});
