'use strict';

const SEC_UA = process.env.SEC_USER_AGENT || 'MCPYahooEDGAR/0.3 mjtahir02@gmail.com';
const SERVER = { name: 'mcp-yahoo-edgar', version: '0.3.0' };
let companyCache = null;

function json(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, accept, mcp-protocol-version, mcp-session-id, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}
function toolText(value, summary) {
  const text = (summary ? summary + '\n\n' : '') + JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}
function toolFailure(error) {
  return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
}
function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function isoToUnix(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid date: ${value}`);
  return Math.floor(parsed / 1000);
}
async function fetchJson(url, provider, userAgent) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json,text/plain,*/*',
      'User-Agent': provider === 'SEC EDGAR' ? userAgent : 'Mozilla/5.0 MCPYahooEDGAR/0.3'
    },
    signal: AbortSignal.timeout(25000),
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`${provider} request failed: ${response.status} ${response.statusText}`);
  return response.json();
}
async function fetchText(url, userAgent) {
  const response = await fetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml,text/plain,*/*', 'User-Agent': userAgent },
    signal: AbortSignal.timeout(25000),
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`SEC EDGAR request failed: ${response.status} ${response.statusText}`);
  return response.text();
}

async function yahooChart(symbol, params) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.toUpperCase())}?${params}`;
  const payload = await fetchJson(url, 'Yahoo Finance', '');
  const err = payload?.chart?.error;
  if (err) throw new Error(`Yahoo Finance: ${err.description || err.code}`);
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(`No Yahoo Finance data returned for ${symbol}`);
  return result;
}
async function searchYahoo({ query, limit = 10 }) {
  const url = new URL('https://query2.finance.yahoo.com/v1/finance/search');
  url.searchParams.set('q', query);
  url.searchParams.set('quotesCount', String(Math.min(Math.max(limit, 1), 25)));
  url.searchParams.set('newsCount', '0');
  url.searchParams.set('enableFuzzyQuery', 'true');
  const payload = await fetchJson(url.toString(), 'Yahoo Finance', '');
  const quotes = (payload.quotes || []).slice(0, limit).map(item => ({
    symbol: item.symbol,
    name: item.longname || item.shortname || null,
    quoteType: item.quoteType || null,
    exchange: item.exchange || null,
    exchangeDisplay: item.exchDisp || null,
    sector: item.sector || null,
    industry: item.industry || null
  }));
  return toolText({ query, quotes, provider: 'Yahoo Finance (unofficial)', retrievedAt: new Date().toISOString() }, `Found ${quotes.length} symbols.`);
}
async function getQuotes({ symbols }) {
  if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length > 20) throw new Error('symbols must contain 1 to 20 entries');
  const quotes = await Promise.all(symbols.map(async raw => {
    const symbol = String(raw).trim().toUpperCase();
    const result = await yahooChart(symbol, new URLSearchParams({ interval: '1d', range: '5d', events: 'div,splits' }));
    const meta = result.meta || {};
    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const last = Math.max(0, timestamps.length - 1);
    return {
      symbol,
      name: meta.longName || meta.shortName || null,
      exchange: meta.fullExchangeName || meta.exchangeName || null,
      currency: meta.currency || null,
      marketState: meta.marketState || null,
      regularMarketPrice: finite(meta.regularMarketPrice),
      previousClose: finite(meta.chartPreviousClose ?? meta.previousClose),
      regularMarketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
      dayOpen: finite(quote.open?.[last]), dayHigh: finite(quote.high?.[last]),
      dayLow: finite(quote.low?.[last]), dayClose: finite(quote.close?.[last]),
      volume: finite(quote.volume?.[last]),
      fiftyTwoWeekHigh: finite(meta.fiftyTwoWeekHigh), fiftyTwoWeekLow: finite(meta.fiftyTwoWeekLow)
    };
  }));
  return toolText({ quotes, provider: 'Yahoo Finance chart API (unofficial)', retrievedAt: new Date().toISOString() }, `Retrieved ${quotes.length} snapshots.`);
}
async function getHistory({ symbol, period1, period2, interval = '1d', maxPoints = 500 }) {
  const allowed = new Set(['1d', '5d', '1wk', '1mo', '3mo']);
  if (!allowed.has(interval)) throw new Error('Unsupported interval');
  const params = new URLSearchParams({
    period1: String(isoToUnix(period1)),
    period2: String(period2 ? isoToUnix(period2) : Math.floor(Date.now() / 1000)),
    interval,
    events: 'div,splits,capitalGains'
  });
  const result = await yahooChart(symbol, params);
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose || [];
  const prices = timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString(), open: finite(quote.open?.[i]), high: finite(quote.high?.[i]),
    low: finite(quote.low?.[i]), close: finite(quote.close?.[i]), adjustedClose: finite(adjusted?.[i]), volume: finite(quote.volume?.[i])
  }));
  const capped = prices.slice(-Math.min(Math.max(maxPoints, 1), 2000));
  return toolText({ symbol: symbol.toUpperCase(), meta: result.meta || {}, totalPoints: prices.length, returnedPoints: capped.length, prices: capped, events: result.events || null, provider: 'Yahoo Finance chart API (unofficial)', retrievedAt: new Date().toISOString() }, `Retrieved ${capped.length} price points.`);
}

function normalize(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
async function loadCompanies() {
  if (companyCache && companyCache.expires > Date.now()) return companyCache.rows;
  const payload = await fetchJson('https://www.sec.gov/files/company_tickers.json', 'SEC EDGAR', SEC_UA);
  const rows = Object.values(payload).map(item => ({
    cik: String(item.cik_str).padStart(10, '0'), ticker: String(item.ticker || '').toUpperCase(), name: String(item.title || '')
  }));
  companyCache = { rows, expires: Date.now() + 6 * 60 * 60 * 1000 };
  return rows;
}
async function searchSec({ query, limit = 10 }) {
  const rows = await loadCompanies();
  const q = normalize(query), ticker = String(query).trim().toUpperCase();
  const companies = rows.filter(r => r.ticker.includes(ticker) || normalize(r.name).includes(q))
    .sort((a, b) => ((a.ticker === ticker || normalize(a.name) === q) ? 0 : 1) - ((b.ticker === ticker || normalize(b.name) === q) ? 0 : 1) || a.name.localeCompare(b.name))
    .slice(0, Math.min(Math.max(limit, 1), 25));
  return toolText({ query, companies, provider: 'U.S. SEC EDGAR', retrievedAt: new Date().toISOString() }, `Found ${companies.length} registrants.`);
}
async function resolveCompany(identifier) {
  const value = String(identifier).trim(), rows = await loadCompanies();
  if (/^\d{1,10}$/.test(value)) {
    const cik = value.padStart(10, '0');
    return rows.find(r => r.cik === cik) || { cik, ticker: '', name: `CIK ${cik}` };
  }
  const ticker = value.toUpperCase();
  const tickerMatch = rows.find(r => r.ticker === ticker);
  if (tickerMatch) return tickerMatch;
  const q = normalize(value);
  const exact = rows.find(r => normalize(r.name) === q);
  if (exact) return exact;
  const candidates = rows.filter(r => normalize(r.name).includes(q)).slice(0, 5);
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) throw new Error(`No SEC registrant found for “${identifier}”`);
  throw new Error(`Ambiguous company. Try a ticker or CIK: ${candidates.map(x => `${x.ticker} — ${x.name}`).join('; ')}`);
}
async function submissions(company) { return fetchJson(`https://data.sec.gov/submissions/CIK${company.cik}.json`, 'SEC EDGAR', SEC_UA); }
function recentFilings(payload) {
  const d = payload?.filings?.recent || {}, accessions = d.accessionNumber || [];
  return accessions.map((accessionNumber, i) => ({
    accessionNumber, filingDate: d.filingDate?.[i] || null, reportDate: d.reportDate?.[i] || null,
    acceptanceDateTime: d.acceptanceDateTime?.[i] || null, form: d.form?.[i] || null,
    primaryDocument: d.primaryDocument?.[i] || null, primaryDocDescription: d.primaryDocDescription?.[i] || null,
    fileNumber: d.fileNumber?.[i] || null, items: d.items?.[i] || null
  }));
}
function filingUrl(company, accession, document) {
  return `https://www.sec.gov/Archives/edgar/data/${Number(company.cik)}/${accession.replace(/-/g, '')}/${document}`;
}
async function listFilings({ identifier, forms, startDate, endDate, limit = 20 }) {
  const company = await resolveCompany(identifier), payload = await submissions(company);
  const formSet = Array.isArray(forms) && forms.length ? new Set(forms.map(x => String(x).toUpperCase())) : null;
  const filings = recentFilings(payload).filter(x => !formSet || formSet.has(String(x.form).toUpperCase()))
    .filter(x => !startDate || String(x.filingDate) >= startDate).filter(x => !endDate || String(x.filingDate) <= endDate)
    .slice(0, Math.min(Math.max(limit, 1), 200)).map(x => ({
      ...x, filingUrl: x.primaryDocument ? filingUrl(company, x.accessionNumber, x.primaryDocument) : null,
      indexUrl: `https://www.sec.gov/Archives/edgar/data/${Number(company.cik)}/${x.accessionNumber.replace(/-/g, '')}/`
    }));
  return toolText({ company: { ...company, name: payload.name || company.name }, filings, provider: 'U.S. SEC EDGAR', retrievedAt: new Date().toISOString() }, `Retrieved ${filings.length} filings.`);
}
function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&([a-z]+);/gi, (all, key) => named[key.toLowerCase()] || all)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}
function htmlToText(html) {
  return decodeEntities(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|section|article|tr|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
async function getFiling({ identifier, accessionNumber, searchTerm, startCharacter = 0, maxCharacters = 20000 }) {
  const company = await resolveCompany(identifier), payload = await submissions(company);
  const filing = recentFilings(payload).find(x => x.accessionNumber.replace(/-/g, '') === String(accessionNumber).replace(/-/g, ''));
  if (!filing?.primaryDocument) throw new Error('Accession number not found in recent SEC submissions.');
  const url = filingUrl(company, filing.accessionNumber, filing.primaryDocument);
  const text = htmlToText(await fetchText(url, SEC_UA));
  const cap = Math.min(Math.max(maxCharacters, 1000), 50000);
  if (searchTerm) {
    const lower = text.toLowerCase(), needle = String(searchTerm).toLowerCase(), excerpts = [];
    let cursor = 0;
    while (excerpts.length < 10) {
      const match = lower.indexOf(needle, cursor); if (match < 0) break;
      const start = Math.max(0, match - Math.floor(cap / 4)), end = Math.min(text.length, match + needle.length + Math.floor(cap / 4));
      excerpts.push({ start, end, text: text.slice(start, end) }); cursor = match + needle.length;
    }
    return toolText({ company, filing, url, searchTerm, matchesReturned: excerpts.length, excerpts, provider: 'U.S. SEC EDGAR', retrievedAt: new Date().toISOString() }, `Retrieved SEC filing ${accessionNumber}.`);
  }
  const start = Math.max(0, startCharacter), end = Math.min(text.length, start + cap);
  return toolText({ company, filing, url, startCharacter: start, endCharacter: end, totalCharacters: text.length, text: text.slice(start, end), provider: 'U.S. SEC EDGAR', retrievedAt: new Date().toISOString() }, `Retrieved SEC filing ${accessionNumber}.`);
}
async function getFacts({ identifier, taxonomy = 'us-gaap', concepts, forms = ['10-K', '10-Q'], limitPerConcept = 12 }) {
  const company = await resolveCompany(identifier);
  const payload = await fetchJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${company.cik}.json`, 'SEC EDGAR', SEC_UA);
  const requested = Array.isArray(concepts) && concepts.length ? concepts : ['Revenues','RevenueFromContractWithCustomerExcludingAssessedTax','NetIncomeLoss','Assets','Liabilities','StockholdersEquity','CashAndCashEquivalentsAtCarryingValue'];
  const formSet = new Set(forms.map(x => String(x).toUpperCase()));
  const facts = requested.slice(0, 30).map(concept => {
    const fact = payload?.facts?.[taxonomy]?.[concept];
    if (!fact) return { concept, found: false, units: {} };
    const units = Object.fromEntries(Object.entries(fact.units || {}).map(([unit, entries]) => [unit, entries.filter(e => !e.form || formSet.has(String(e.form).toUpperCase())).slice(-Math.min(Math.max(limitPerConcept, 1), 50))]));
    return { concept, found: true, label: fact.label, description: fact.description, units };
  });
  return toolText({ company: { ...company, name: payload.entityName || company.name }, taxonomy, facts, provider: 'U.S. SEC EDGAR', retrievedAt: new Date().toISOString() }, `Retrieved ${facts.filter(x => x.found).length} XBRL concepts.`);
}

const tools = [
  { name: 'search-market-symbols', description: 'Search Yahoo Finance for market symbols.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 } }, required: ['query'], additionalProperties: false } },
  { name: 'get-market-quotes', description: 'Retrieve current Yahoo Finance market snapshots.', inputSchema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 } }, required: ['symbols'], additionalProperties: false } },
  { name: 'get-price-history', description: 'Retrieve historical Yahoo Finance OHLCV data.', inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, period1: { type: 'string', description: 'ISO date or datetime' }, period2: { type: 'string', description: 'ISO date or datetime; defaults to now' }, interval: { type: 'string', enum: ['1d','5d','1wk','1mo','3mo'], default: '1d' }, maxPoints: { type: 'integer', minimum: 1, maximum: 2000, default: 500 } }, required: ['symbol','period1'], additionalProperties: false } },
  { name: 'search-sec-companies', description: 'Search SEC registrants and return CIKs.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 } }, required: ['query'], additionalProperties: false } },
  { name: 'list-sec-filings', description: 'List recent SEC filings for a company.', inputSchema: { type: 'object', properties: { identifier: { type: 'string', description: 'Ticker, CIK, or company name' }, forms: { type: 'array', items: { type: 'string' }, maxItems: 20 }, startDate: { type: 'string' }, endDate: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 } }, required: ['identifier'], additionalProperties: false } },
  { name: 'get-sec-filing', description: 'Retrieve bounded text or targeted excerpts from a recent SEC filing.', inputSchema: { type: 'object', properties: { identifier: { type: 'string' }, accessionNumber: { type: 'string' }, searchTerm: { type: 'string' }, startCharacter: { type: 'integer', minimum: 0, default: 0 }, maxCharacters: { type: 'integer', minimum: 1000, maximum: 50000, default: 20000 } }, required: ['identifier','accessionNumber'], additionalProperties: false } },
  { name: 'get-sec-company-facts', description: 'Retrieve standardized SEC XBRL company facts.', inputSchema: { type: 'object', properties: { identifier: { type: 'string' }, taxonomy: { type: 'string', default: 'us-gaap' }, concepts: { type: 'array', items: { type: 'string' }, maxItems: 30 }, forms: { type: 'array', items: { type: 'string' }, maxItems: 20, default: ['10-K','10-Q'] }, limitPerConcept: { type: 'integer', minimum: 1, maximum: 50, default: 12 } }, required: ['identifier'], additionalProperties: false } }
];

async function callTool(name, args) {
  switch (name) {
    case 'search-market-symbols': return searchYahoo(args || {});
    case 'get-market-quotes': return getQuotes(args || {});
    case 'get-price-history': return getHistory(args || {});
    case 'search-sec-companies': return searchSec(args || {});
    case 'list-sec-filings': return listFilings(args || {});
    case 'get-sec-filing': return getFiling(args || {});
    case 'get-sec-company-facts': return getFacts(args || {});
    default: throw new Error(`Unknown tool: ${name}`);
  }
}
async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid Request');
  const id = msg.id;
  if (msg.method === 'initialize') return rpcResult(id, { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: 'Public market data from Yahoo Finance and U.S. company filings from SEC EDGAR.' });
  if (msg.method === 'ping') return rpcResult(id, {});
  if (msg.method === 'tools/list') return rpcResult(id, { tools });
  if (msg.method === 'tools/call') {
    try { return rpcResult(id, await callTool(msg.params?.name, msg.params?.arguments || {})); }
    catch (error) { return rpcResult(id, toolFailure(error)); }
  }
  if (msg.method.startsWith('notifications/')) return undefined;
  return rpcError(id, -32601, `Method not found: ${msg.method}`);
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204);
  if (req.method === 'GET') return json(res, 405, rpcError(null, -32000, 'Use POST for MCP Streamable HTTP'), { Allow: 'POST, DELETE, OPTIONS' });
  if (req.method === 'DELETE') return json(res, 204);
  if (req.method !== 'POST') return json(res, 405, rpcError(null, -32600, 'Method not allowed'));
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return json(res, 400, rpcError(null, -32700, 'Parse error')); } }
  if (!body) return json(res, 400, rpcError(null, -32600, 'Missing JSON-RPC body'));
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map(handleMessage))).filter(Boolean);
    return responses.length ? json(res, 200, responses) : json(res, 202);
  }
  const response = await handleMessage(body);
  return response ? json(res, 200, response, { 'MCP-Protocol-Version': '2025-03-26' }) : json(res, 202);
};
