import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const htmlPath = path.join(rootDir, "index.html");
const outDir = path.join(rootDir, "data");
const jsonPath = path.join(outDir, "price-history-200d.json");
const csvPath = path.join(outDir, "price-history-200d.csv");

const html = fs.readFileSync(htmlPath, "utf8");
const stockRowsBlock = html.match(/const stockRows = \[([\s\S]*?)\]\.map/);

if (!stockRowsBlock) {
  throw new Error("index.htmlからstockRowsを見つけられませんでした。");
}

const stockRows = [];
const rowPattern = /\["([^"]+)","([^"]+)","([^"]+)",([^\]]+)\]/g;
for (const match of stockRowsBlock[1].matchAll(rowPattern)) {
  stockRows.push({
    name: match[1],
    code: match[2],
    sector: match[3],
  });
}

const uniqueStocks = [...new Map(stockRows.map((row) => [row.code, row])).values()];

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

function toCsvCell(value) {
  if (value == null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function fetchChart(stock) {
  const symbol = `${stock.code}.T`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1y&interval=1d&events=history`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    return { stock, symbol, error: `HTTP ${response.status}` };
  }

  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];

  if (!result || !quote || timestamps.length === 0) {
    return { stock, symbol, error: "No chart data" };
  }

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
  })).filter((row) => row.close != null).slice(-200);

  return {
    stock,
    symbol,
    currency: result.meta?.currency || "JPY",
    exchangeName: result.meta?.exchangeName || "",
    regularMarketPrice: result.meta?.regularMarketPrice ?? null,
    regularMarketTime: result.meta?.regularMarketTime ? toDateString(result.meta.regularMarketTime) : null,
    rows,
  };
}

fs.mkdirSync(outDir, { recursive: true });

const fetchedAt = new Date().toISOString();
const results = [];

for (const [index, stock] of uniqueStocks.entries()) {
  const result = await fetchChart(stock);
  results.push(result);
  const status = result.error ? `NG ${result.error}` : `OK ${result.rows.length} rows`;
  console.log(`${index + 1}/${uniqueStocks.length} ${stock.code} ${stock.name}: ${status}`);
  await new Promise((resolve) => setTimeout(resolve, 80));
}

const successful = results.filter((result) => !result.error);
const failed = results.filter((result) => result.error);
const allRows = successful.flatMap((result) => result.rows);

const jsonOutput = {
  source: "Yahoo Finance unofficial chart API",
  fetchedAt,
  requestedDays: 200,
  stocks: uniqueStocks.length,
  successful: successful.length,
  failed: failed.map((result) => ({
    code: result.stock.code,
    name: result.stock.name,
    error: result.error,
  })),
  data: successful.map((result) => ({
    code: result.stock.code,
    name: result.stock.name,
    sector: result.stock.sector,
    symbol: result.symbol,
    currency: result.currency,
    exchangeName: result.exchangeName,
    regularMarketPrice: result.regularMarketPrice,
    regularMarketTime: result.regularMarketTime,
    prices: result.rows,
  })),
};

const csvHeader = ["コード", "銘柄名", "セクタ", "日付", "始値", "高値", "安値", "終値", "出来高"];
const csvRows = allRows.map((row) => [
  row.code,
  row.name,
  row.sector,
  row.date,
  row.open,
  row.high,
  row.low,
  row.close,
  row.volume,
]);

fs.writeFileSync(jsonPath, `${JSON.stringify(jsonOutput, null, 2)}\n`);
fs.writeFileSync(csvPath, [
  csvHeader.join(","),
  ...csvRows.map((row) => row.map(toCsvCell).join(",")),
].join("\n") + "\n");

console.log(`Saved ${jsonPath}`);
console.log(`Saved ${csvPath}`);
console.log(`Success: ${successful.length}, Failed: ${failed.length}, Rows: ${allRows.length}`);
