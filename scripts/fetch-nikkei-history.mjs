import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const jsonPath = path.join(rootDir, "data", "price-history-200d.json");
const jsPath = path.join(rootDir, "data", "price-history-200d.js");
const symbol = "^N225";
const stock = { code: "N225", name: "日経平均", sector: "市場指数" };

function normalizePrice(value) {
  return Number.isFinite(value) ? value : null;
}

function toDateString(timestamp) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp * 1000));
}

async function fetchChart({ range, interval, limit }) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&events=history`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];
  if (!result || !quote || timestamps.length === 0) throw new Error("No chart data");
  const rows = timestamps.map((timestamp, index) => ({
    code: stock.code,
    name: stock.name,
    sector: stock.sector,
    date: toDateString(timestamp),
    open: normalizePrice(quote.open?.[index]),
    high: normalizePrice(quote.high?.[index]),
    low: normalizePrice(quote.low?.[index]),
    close: normalizePrice(quote.close?.[index]),
    volume: normalizePrice(quote.volume?.[index]),
  })).filter((row) => row.close != null).slice(-limit);
  return {
    symbol,
    currency: result.meta?.currency || "JPY",
    exchangeName: result.meta?.exchangeName || "",
    regularMarketPrice: result.meta?.regularMarketPrice ?? null,
    regularMarketTime: result.meta?.regularMarketTime ? toDateString(result.meta.regularMarketTime) : null,
    rows,
  };
}

const payload = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const daily = await fetchChart({ range: "5y", interval: "1d", limit: payload.requestedDays || 1000 });
const monthly = await fetchChart({ range: "max", interval: "1mo", limit: payload.requestedMonths || 360 });
const record = {
  code: stock.code,
  name: stock.name,
  sector: stock.sector,
  symbol: daily.symbol,
  currency: daily.currency,
  exchangeName: daily.exchangeName,
  regularMarketPrice: daily.regularMarketPrice,
  regularMarketTime: daily.regularMarketTime,
  prices: daily.rows,
  monthlyPrices: monthly.rows,
};

payload.data = (payload.data || []).filter((row) => row.code !== stock.code).concat(record);
payload.indexes = Array.from(new Set([...(payload.indexes || []), stock.code]));
payload.fetchedAt = new Date().toISOString();
fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);

const browserDailyRows = Object.fromEntries(payload.data.map((item) => [
  item.code,
  item.prices.map((row) => ({
    d: row.date,
    o: row.open,
    h: row.high,
    l: row.low,
    c: row.close,
    v: row.volume,
  })),
]));
const browserMonthlyRows = Object.fromEntries(payload.data.map((item) => [
  item.code,
  (item.monthlyPrices || []).map((row) => ({
    d: row.date,
    o: row.open,
    h: row.high,
    l: row.low,
    c: row.close,
    v: row.volume,
  })),
]));
fs.writeFileSync(jsPath, [
  `window.priceHistoryFetchedAt = ${JSON.stringify(payload.fetchedAt)};`,
  `window.priceHistoryScheduledFetchTime = ${JSON.stringify(payload.scheduledFetchTime || "平日 15:30")};`,
  `window.priceHistoryRows = ${JSON.stringify(browserDailyRows)};`,
  `window.priceHistoryMonthlyRows = ${JSON.stringify(browserMonthlyRows)};`,
  "",
].join("\n"));

console.log(`Saved Nikkei history: daily ${daily.rows.length}, monthly ${monthly.rows.length}`);
