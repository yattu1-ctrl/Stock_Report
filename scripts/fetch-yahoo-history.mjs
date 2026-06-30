import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const htmlPath = path.join(rootDir, "index.html");
const outDir = path.join(rootDir, "data");
const jsonPath = path.join(outDir, "price-history-200d.json");
const csvPath = path.join(outDir, "price-history-200d.csv");
const jsPath = path.join(outDir, "price-history-200d.js");
const requestedDailyRows = 1000;
const requestedMonthlyMonths = 360;

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

async function fetchChart(stock, { range, interval, limit }) {
  const symbol = `${stock.code}.T`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}&events=history`;
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
  })).filter((row) => row.close != null).slice(-limit);

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
  const daily = await fetchChart(stock, { range: "5y", interval: "1d", limit: requestedDailyRows });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const monthly = await fetchChart(stock, { range: "max", interval: "1mo", limit: requestedMonthlyMonths });
  results.push({ stock, daily, monthly });
  const dailyStatus = daily.error ? `D NG ${daily.error}` : `D OK ${daily.rows.length}`;
  const monthlyStatus = monthly.error ? `M NG ${monthly.error}` : `M OK ${monthly.rows.length}`;
  console.log(`${index + 1}/${uniqueStocks.length} ${stock.code} ${stock.name}: ${dailyStatus}, ${monthlyStatus}`);
  await new Promise((resolve) => setTimeout(resolve, 80));
}

const successful = results.filter((result) => !result.daily.error);
const failed = results.filter((result) => result.daily.error);
const allRows = successful.flatMap((result) => result.daily.rows);

const jsonOutput = {
  source: "Yahoo Finance unofficial chart API",
  fetchedAt,
  requestedDays: requestedDailyRows,
  requestedMonths: requestedMonthlyMonths,
  stocks: uniqueStocks.length,
  successful: successful.length,
  failed: failed.map((result) => ({
    code: result.stock.code,
    name: result.stock.name,
    error: result.daily.error,
  })),
  data: successful.map((result) => ({
    code: result.stock.code,
    name: result.stock.name,
    sector: result.stock.sector,
    symbol: result.daily.symbol,
    currency: result.daily.currency,
    exchangeName: result.daily.exchangeName,
    regularMarketPrice: result.daily.regularMarketPrice,
    regularMarketTime: result.daily.regularMarketTime,
    prices: result.daily.rows,
    monthlyPrices: result.monthly.error ? [] : result.monthly.rows,
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
const browserDailyRows = Object.fromEntries(jsonOutput.data.map((stock) => [
  stock.code,
  stock.prices.map((row) => ({
    d: row.date,
    o: row.open,
    h: row.high,
    l: row.low,
    c: row.close,
    v: row.volume,
  })),
]));
const browserMonthlyRows = Object.fromEntries(jsonOutput.data.map((stock) => [
  stock.code,
  stock.monthlyPrices.map((row) => ({
    d: row.date,
    o: row.open,
    h: row.high,
    l: row.low,
    c: row.close,
    v: row.volume,
  })),
]));
fs.writeFileSync(jsPath, [
  `window.priceHistoryFetchedAt = ${JSON.stringify(jsonOutput.fetchedAt)};`,
  `window.priceHistoryRows = ${JSON.stringify(browserDailyRows)};`,
  `window.priceHistoryMonthlyRows = ${JSON.stringify(browserMonthlyRows)};`,
  "",
].join("\n"));

console.log(`Saved ${jsonPath}`);
console.log(`Saved ${csvPath}`);
console.log(`Saved ${jsPath}`);
console.log(`Success: ${successful.length}, Failed: ${failed.length}, Rows: ${allRows.length}`);
