import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import * as cheerio from "cheerio";
import express from "express";

const PORT = process.env.PORT || 3000;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7",
  "Cache-Control": "no-cache",
};

const TIMEOUT_MS = 15000;

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

async function scrapeTheBlock() {
  const html = await fetchPage("https://www.theblock.co/latest-crypto-news");
  const $ = cheerio.load(html);
  const articles = [];
  $("a").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().trim();
    if (href.includes("/post/") && text.length > 20 && text.length < 300 && !href.includes("/press-releases/")) {
      const url = href.startsWith("http") ? href : `https://www.theblock.co${href}`;
      if (!articles.some(a => a.url === url)) articles.push({ titulo: text.substring(0, 200), url, fonte: "The Block" });
    }
  });
  return articles.slice(0, 25);
}

async function scrapeCoinDesk() {
  const html = await fetchPage("https://www.coindesk.com/latest-crypto-news");
  const $ = cheerio.load(html);
  const articles = [];
  $('a[href*="/markets/"], a[href*="/business/"], a[href*="/tech/"], a[href*="/policy/"], a[href*="/news/"], a[href*="/finance/"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().trim();
    if (text.length > 25 && text.length < 300 && !href.includes("/author/") && !href.includes("/tag/") && !href.includes("/price/")) {
      const url = href.startsWith("http") ? href : `https://www.coindesk.com${href}`;
      if (!articles.some(a => a.url === url)) articles.push({ titulo: text.substring(0, 200), url, fonte: "CoinDesk" });
    }
  });
  return articles.slice(0, 25);
}

async function scrapeCoinTelegraph() {
  const articles = [];
  for (const [base, label] of [["https://cointelegraph.com", "CoinTelegraph"], ["https://br.cointelegraph.com", "CoinTelegraph Brasil"]]) {
    try {
      const html = await fetchPage(base + "/");
      const $ = cheerio.load(html);
      $("a").each((_, el) => {
        const href = $(el).attr("href") || "";
        const text = $(el).text().trim();
        if ((href.includes("/news/") || href.includes("/markets/")) && text.length > 25 && text.length < 300 && !href.includes("/author/") && !href.includes("/tag/")) {
          const url = href.startsWith("http") ? href : `${base}${href}`;
          if (!articles.some(a => a.url === url)) articles.push({ titulo: text.substring(0, 200), url, fonte: label });
        }
      });
    } catch (e) { console.error(`${label} error:`, e.message); }
  }
  return articles.slice(0, 30);
}

async function scrapePortalDoBitcoin() {
  const html = await fetchPage("https://portaldobitcoin.uol.com.br/");
  const $ = cheerio.load(html);
  const articles = [];
  $("a").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().trim();
    if (href.includes("portaldobitcoin.uol.com.br/") && text.length > 25 && text.length < 300 && !href.endsWith("/") && !href.includes("/category/") && !href.includes("/tag/") && !href.includes("/author/") && !href.includes("#")) {
      if (!articles.some(a => a.url === href)) articles.push({ titulo: text.substring(0, 200), url: href, fonte: "Portal do Bitcoin" });
    }
  });
  return articles.slice(0, 20);
}

async function fetchArticleContent(url) {
  const html = await fetchPage(url);
  const $ = cheerio.load(html);
  $("nav, footer, script, style, iframe, .ad, .sidebar, .related, header").remove();
  let content = "";
  for (const sel of ["article", '[class*="article-body"]', '[class*="post-content"]', "main"]) {
    const el = $(sel);
    if (el.length && el.text().trim().length > 200) { content = el.text().trim(); break; }
  }
  if (!content) content = $("body").text().trim();
  content = content.replace(/\s+/g, " ").substring(0, 5000);
  const title = $("title").text().trim() || $("h1").first().text().trim();
  return { title, content, url };
}

function createServer() {
  const server = new McpServer({ name: "crypto-news", version: "1.0.0" });

  server.tool(
    "get_crypto_news",
    "Busca manchetes recentes de noticias cripto do The Block, CoinDesk, CoinTelegraph e Portal do Bitcoin.",
    {
      sources: z.array(z.enum(["theblock", "coindesk", "cointelegraph", "portaldobitcoin", "all"])).default(["all"]),
      max_per_source: z.number().min(1).max(25).default(15),
    },
    async ({ sources, max_per_source }) => {
      const useAll = sources.includes("all");
      const results = {};
      const errors = [];
      const tasks = [];

      if (useAll || sources.includes("theblock"))
        tasks.push(scrapeTheBlock().then(a => { results.theblock = a.slice(0, max_per_source); }).catch(e => { errors.push(`The Block: ${e.message}`); results.theblock = []; }));
      if (useAll || sources.includes("coindesk"))
        tasks.push(scrapeCoinDesk().then(a => { results.coindesk = a.slice(0, max_per_source); }).catch(e => { errors.push(`CoinDesk: ${e.message}`); results.coindesk = []; }));
      if (useAll || sources.includes("cointelegraph"))
        tasks.push(scrapeCoinTelegraph().then(a => { results.cointelegraph = a.slice(0, max_per_source); }).catch(e => { errors.push(`CoinTelegraph: ${e.message}`); results.cointelegraph = []; }));
      if (useAll || sources.includes("portaldobitcoin"))
        tasks.push(scrapePortalDoBitcoin().then(a => { results.portaldobitcoin = a.slice(0, max_per_source); }).catch(e => { errors.push(`Portal do Bitcoin: ${e.message}`); results.portaldobitcoin = []; }));

      await Promise.all(tasks);

      let output = "";
      const names = { theblock: "The Block", coindesk: "CoinDesk", cointelegraph: "CoinTelegraph", portaldobitcoin: "Portal do Bitcoin" };
      for (const [src, arts] of Object.entries(results)) {
        output += `\n=== ${names[src]} (${arts.length} noticias) ===\n\n`;
        if (!arts.length) output += "Nenhuma noticia encontrada ou erro na coleta.\n";
        else arts.forEach((a, i) => { output += `${i + 1}. ${a.titulo}\n   ${a.url}\n   Fonte: ${a.fonte}\n\n`; });
      }
      if (errors.length) output += `\n--- Erros ---\n${errors.join("\n")}\n`;
      const total = Object.values(results).reduce((s, a) => s + a.length, 0);
      output += `\nTotal: ${total} noticias de ${Object.keys(results).length} fontes`;
      return { content: [{ type: "text", text: output }] };
    }
  );

  server.tool(
    "read_article",
    "Le o conteudo completo de um artigo a partir da URL.",
    { url: z.string().url() },
    async ({ url }) => {
      try {
        const art = await fetchArticleContent(url);
        return { content: [{ type: "text", text: `Titulo: ${art.title}\nURL: ${art.url}\n\n${art.content}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Erro: ${e.message}` }], isError: true };
      }
    }
  );

  return server;
}

// ─── Express + SSE ───────────────────────────────────────────────────────────

const app = express();
const transports = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => { delete transports[transport.sessionId]; });
  const server = createServer();
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(400).json({ error: "Session not found" });
  await transport.handlePostMessage(req, res);
});

app.get("/health", (_, res) => {
  res.json({ status: "ok", name: "crypto-news-mcp", sessions: Object.keys(transports).length });
});

app.get("/", (_, res) => {
  res.json({ name: "crypto-news-mcp", endpoints: { sse: "/sse", messages: "/messages", health: "/health" } });
});

app.listen(PORT, () => {
  console.log(`crypto-news-mcp running on port ${PORT}`);
});
