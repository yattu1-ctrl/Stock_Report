import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const htmlPath = path.join(rootDir, "index.html");
const outDir = path.join(rootDir, "data");
const outPath = path.join(outDir, "technical-indicators.json");
const jsPath = path.join(outDir, "technical-indicators.js");
const localPricePath = path.join(outDir, "price-history-200d.json");
const useLocalData = process.argv.includes("--local");

const html = fs.readFileSync(htmlPath, "utf8");
const stockRowsBlock = html.match(/const stockRows = \[([\s\S]*?)\]\.map/);

if (!stockRowsBlock) {
  throw new Error("index.htmlからstockRowsを見つけられませんでした。");
}

const stocks = [];
const rowPattern = /\["([^"]+)","([^"]+)","([^"]+)",([^\]]+)\]/g;
for (const match of stockRowsBlock[1].matchAll(rowPattern)) {
  stocks.push({ name: match[1], code: match[2], sector: match[3] });
}

const uniqueStocks = [...new Map(stocks.map((row) => [row.code, row])).values()];
const localPricePayload = useLocalData ? JSON.parse(fs.readFileSync(localPricePath, "utf8")) : null;
const localPriceRows = new Map((localPricePayload?.data || []).map((row) => [String(row.code), row]));

function avg(values) {
  if (!values.length || values.some((value) => !Number.isFinite(value))) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pct(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current / previous) - 1) * 100;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function movingAverage(closes, days, offset = 0) {
  const end = closes.length - offset;
  const start = end - days;
  if (start < 0) return null;
  return avg(closes.slice(start, end));
}

function ema(values, days) {
  if (values.length < days) return null;
  const multiplier = 2 / (days + 1);
  let current = avg(values.slice(0, days));
  for (const value of values.slice(days)) {
    current = (value - current) * multiplier + current;
  }
  return current;
}

function emaSeries(values, days) {
  if (values.length < days) return values.map(() => null);
  const multiplier = 2 / (days + 1);
  const output = values.map(() => null);
  let current = avg(values.slice(0, days));
  output[days - 1] = current;
  for (let index = days; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
    output[index] = current;
  }
  return output;
}

function macdDetails(closes) {
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdSeries = closes.map((_, index) => (
    Number.isFinite(ema12[index]) && Number.isFinite(ema26[index]) ? ema12[index] - ema26[index] : null
  ));
  const validMacd = macdSeries.filter(Number.isFinite);
  const signalSeriesValid = emaSeries(validMacd, 9);
  const signalSeries = macdSeries.map(() => null);
  let validIndex = 0;
  macdSeries.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    signalSeries[index] = signalSeriesValid[validIndex];
    validIndex += 1;
  });
  const macd = macdSeries.at(-1);
  const signal = signalSeries.at(-1);
  const goldenCrossWithinBelowZero = (days) => {
    const recentStart = Math.max(1, macdSeries.length - days);
    return Number.isFinite(macd) && macd <= 0 && macdSeries.some((value, index) => {
      if (index < recentStart) return false;
      const previousMacd = macdSeries[index - 1];
      const previousSignal = signalSeries[index - 1];
      const currentSignal = signalSeries[index];
      if (![previousMacd, previousSignal, value, currentSignal].every(Number.isFinite)) return false;
      return previousMacd <= previousSignal && value > currentSignal && value <= 0;
    });
  };
  return {
    macd,
    signal,
    histogram: Number.isFinite(macd) && Number.isFinite(signal) ? macd - signal : null,
    goldenCrossWithin5BelowZero: goldenCrossWithinBelowZero(5),
    goldenCrossWithin10BelowZero: goldenCrossWithinBelowZero(10),
  };
}

function aggregateWeeklyPrices(prices) {
  const groups = new Map();
  prices.forEach((row) => {
    const date = new Date(`${row.date}T00:00:00+09:00`);
    const monday = new Date(date);
    const day = monday.getDay() || 7;
    monday.setDate(monday.getDate() - day + 1);
    const key = monday.toISOString().slice(0, 10);
    if (!groups.has(key)) {
      groups.set(key, { date: row.date, high: row.high, low: row.low, close: row.close });
      return;
    }
    const group = groups.get(key);
    group.high = Math.max(group.high, row.high);
    group.low = Math.min(group.low, row.low);
    group.close = row.close;
    group.date = row.date;
  });
  return Array.from(groups.values());
}

function rsi(closes, days = 14) {
  if (closes.length <= days) return null;
  const changes = closes.slice(-days - 1).slice(1).map((value, index) => value - closes.slice(-days - 1)[index]);
  const gains = changes.map((change) => Math.max(change, 0));
  const losses = changes.map((change) => Math.max(-change, 0));
  const avgGain = avg(gains);
  const avgLoss = avg(losses);
  if (avgGain == null || avgLoss == null) return null;
  if (avgLoss === 0) return 100;
  const relativeStrength = avgGain / avgLoss;
  return 100 - (100 / (1 + relativeStrength));
}

function zigzag(prices, depth) {
  if (prices.length < depth * 2 + 1) return null;
  const pivots = [];

  for (let index = depth; index < prices.length - depth; index++) {
    const window = prices.slice(index - depth, index + depth + 1);
    const current = prices[index];
    const high = Math.max(...window.map((row) => row.high).filter(Number.isFinite));
    const low = Math.min(...window.map((row) => row.low).filter(Number.isFinite));
    const candidates = [];

    if (Number.isFinite(current.high) && current.high === high) {
      candidates.push({ type: "high", index, date: current.date, value: current.high });
    }
    if (Number.isFinite(current.low) && current.low === low) {
      candidates.push({ type: "low", index, date: current.date, value: current.low });
    }

    for (const candidate of candidates) {
      const last = pivots.at(-1);
      if (!last) {
        pivots.push(candidate);
        continue;
      }
      if (last.type === candidate.type) {
        const shouldReplace = candidate.type === "high"
          ? candidate.value > last.value
          : candidate.value < last.value;
        if (shouldReplace) pivots[pivots.length - 1] = candidate;
      } else {
        pivots.push(candidate);
      }
    }
  }

  const pivot = pivots.at(-1);
  const currentPrice = prices.at(-1)?.close;
  if (!pivot || !Number.isFinite(currentPrice)) return null;

  const change = pct(currentPrice, pivot.value);
  let trend = "横ばい";
  if (Number.isFinite(change) && Math.abs(change) >= 1) {
    trend = pivot.type === "low" ? "上昇中" : "下降中";
  }

  const afterPivot = prices.slice(pivot.index);
  const lowAfterPivot = Math.min(...afterPivot.map((row) => row.low).filter(Number.isFinite));
  const highAfterPivot = Math.max(...afterPivot.map((row) => row.high).filter(Number.isFinite));
  const upTurnPrice = Number.isFinite(lowAfterPivot) ? lowAfterPivot * 1.01 : null;
  const downTurnPrice = Number.isFinite(highAfterPivot) ? highAfterPivot * 0.99 : null;
  const recentExtreme = trend === "上昇中"
    ? highAfterPivot
    : trend === "下降中"
      ? lowAfterPivot
      : null;
  const turnPrice = trend === "上昇中"
    ? downTurnPrice
    : trend === "下降中"
      ? upTurnPrice
      : null;

  return {
    type: pivot.type,
    date: pivot.date,
    value: pivot.value,
    change,
    trend,
    upTurnPrice,
    downTurnPrice,
    recentExtreme,
    turnPrice,
  };
}

async function fetchPrices(stock) {
  if (useLocalData) {
    const record = localPriceRows.get(String(stock.code));
    if (!record?.prices?.length) {
      return { stock, error: "No local chart data" };
    }
    const prices = record.prices.map((row) => ({
      date: row.date,
      high: row.high,
      low: row.low,
      close: row.close,
    })).filter((row) => Number.isFinite(row.close) && Number.isFinite(row.high) && Number.isFinite(row.low));
    return { stock, prices };
  }

  const symbol = `${stock.code}.T`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=2y&interval=1d&events=history`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    return { stock, error: `HTTP ${response.status}` };
  }

  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];

  if (!result || !quote || timestamps.length === 0) {
    return { stock, error: "No chart data" };
  }

  const prices = timestamps.map((timestamp, index) => ({
    date: new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(timestamp * 1000)),
    high: quote.high?.[index],
    low: quote.low?.[index],
    close: quote.close?.[index],
  })).filter((row) => Number.isFinite(row.close) && Number.isFinite(row.high) && Number.isFinite(row.low));

  return { stock, prices };
}

function indicatorsFor(stock, prices) {
  const closes = prices.map((row) => row.close);
  const currentPrice = closes.at(-1) ?? null;
  const output = {
    name: stock.name,
    code: stock.code,
    sector: stock.sector,
    currentPrice: round(currentPrice),
    date: prices.at(-1)?.date ?? null,
  };

  for (const days of [5, 10, 25, 75, 100, 200]) {
    const ma = movingAverage(closes, days);
    const previousMa = movingAverage(closes, days, 1);
    output[`ma${days}`] = round(ma);
    output[`ma${days}Slope`] = round(pct(ma, previousMa));
    output[`ma${days}Divergence`] = round(pct(currentPrice, ma));
  }

  for (const days of [5, 10, 25, 50, 100, 200]) {
    output[`priceChange${days}`] = round(pct(currentPrice, closes.at(-1 - days)));
  }

  const macdOutput = macdDetails(closes);
  output.macd = round(macdOutput.macd);
  output.macdSignal = round(macdOutput.signal);
  output.macdHistogram = round(macdOutput.histogram);
  output.macdGoldenCrossWithin5BelowZero = macdOutput.goldenCrossWithin5BelowZero;
  output.macdGoldenCrossWithin10BelowZero = macdOutput.goldenCrossWithin10BelowZero;
  const weeklyMacdOutput = macdDetails(aggregateWeeklyPrices(prices).map((row) => row.close));
  output.weeklyMacdGoldenCrossWithin5BelowZero = weeklyMacdOutput.goldenCrossWithin5BelowZero;
  output.rsi = round(rsi(closes));

  for (const depth of [7, 20]) {
    const zz = zigzag(prices, depth);
    const previousZz = prices.length > 1 ? zigzag(prices.slice(0, -1), depth) : null;
    output[`zigzag${depth}`] = zz?.trend ?? null;
    output[`zigzag${depth}Changed`] = Boolean(zz?.trend && previousZz?.trend && zz.trend !== previousZz.trend);
    output[`zigzag${depth}Change`] = round(zz?.change);
    output[`zigzag${depth}Type`] = zz?.type ?? null;
    output[`zigzag${depth}Date`] = zz?.date ?? null;
    output[`zigzag${depth}Value`] = round(zz?.value);
    output[`zigzag${depth}UpTurnPrice`] = round(zz?.upTurnPrice);
    output[`zigzag${depth}DownTurnPrice`] = round(zz?.downTurnPrice);
    output[`zigzag${depth}RecentExtreme`] = round(zz?.recentExtreme);
    output[`zigzag${depth}TurnPrice`] = round(zz?.turnPrice);
  }
  return output;
}

fs.mkdirSync(outDir, { recursive: true });

const rows = [];
const failed = [];

for (const [index, stock] of uniqueStocks.entries()) {
  const result = await fetchPrices(stock);
  if (result.error) {
    failed.push({ code: stock.code, name: stock.name, error: result.error });
    rows.push(indicatorsFor(stock, []));
    console.log(`${index + 1}/${uniqueStocks.length} ${stock.code} ${stock.name}: NG ${result.error}`);
  } else {
    rows.push(indicatorsFor(stock, result.prices));
    console.log(`${index + 1}/${uniqueStocks.length} ${stock.code} ${stock.name}: OK ${result.prices.length} rows`);
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
}

const output = {
  source: "Yahoo Finance unofficial chart API",
  fetchedAt: localPricePayload?.fetchedAt || new Date().toISOString(),
  description: "Moving averages, moving average slope, price change, MACD, MACD signal, MACD histogram, RSI, and ZigZag calculated from daily OHLC data.",
  failed,
  data: rows,
};

fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
const browserRows = output.data.map((row) => ({
  name: row.name,
  code: row.code,
  sector: row.sector,
  currentPrice: row.currentPrice,
  date: row.date,
  ma5: row.ma5,
  ma10: row.ma10,
  ma25: row.ma25,
  ma75: row.ma75,
  ma100: row.ma100,
  ma200: row.ma200,
  ma5Slope: row.ma5Slope,
  ma10Slope: row.ma10Slope,
  ma25Slope: row.ma25Slope,
  ma75Slope: row.ma75Slope,
  ma100Slope: row.ma100Slope,
  ma200Slope: row.ma200Slope,
  ma5Divergence: row.ma5Divergence,
  ma10Divergence: row.ma10Divergence,
  ma25Divergence: row.ma25Divergence,
  ma75Divergence: row.ma75Divergence,
  ma200Divergence: row.ma200Divergence,
  priceChange5: row.priceChange5,
  priceChange10: row.priceChange10,
  priceChange25: row.priceChange25,
  priceChange50: row.priceChange50,
  priceChange100: row.priceChange100,
  priceChange200: row.priceChange200,
  macd: row.macd,
  macdSignal: row.macdSignal,
  macdHistogram: row.macdHistogram,
  macdGoldenCrossWithin5BelowZero: row.macdGoldenCrossWithin5BelowZero,
  macdGoldenCrossWithin10BelowZero: row.macdGoldenCrossWithin10BelowZero,
  weeklyMacdGoldenCrossWithin5BelowZero: row.weeklyMacdGoldenCrossWithin5BelowZero,
  rsi: row.rsi,
  zigzag7: row.zigzag7,
  zigzag7Changed: row.zigzag7Changed,
  zigzag7UpTurnPrice: row.zigzag7UpTurnPrice,
  zigzag7DownTurnPrice: row.zigzag7DownTurnPrice,
  zigzag7RecentExtreme: row.zigzag7RecentExtreme,
  zigzag7TurnPrice: row.zigzag7TurnPrice,
  zigzag20: row.zigzag20,
  zigzag20Changed: row.zigzag20Changed,
  zigzag20UpTurnPrice: row.zigzag20UpTurnPrice,
  zigzag20DownTurnPrice: row.zigzag20DownTurnPrice,
  zigzag20RecentExtreme: row.zigzag20RecentExtreme,
  zigzag20TurnPrice: row.zigzag20TurnPrice,
}));
fs.writeFileSync(jsPath, [
  `window.technicalFetchedAt = ${JSON.stringify(output.fetchedAt)};`,
  `window.technicalRows = ${JSON.stringify(browserRows)};`,
  "",
].join("\n"));
console.log(`Saved ${outPath}`);
console.log(`Saved ${jsPath}`);
console.log(`Rows: ${rows.length}, Failed: ${failed.length}`);
