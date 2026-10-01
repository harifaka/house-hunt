/**
 * Scraper service for ingatlan.com property listings.
 * Uses built-in fetch (Node 18+) and cheerio for HTML parsing.
 */
const cheerio = require('cheerio');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SITE_EXTRACTORS = new Map();

class HeuristicExtractor {
  extract($, url) {
    const structuredData = readJsonLd($);
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const parameters = readParameters($);
    const structured = getStructuredFields(structuredData);
    const metadata = readOpenGraph($);
    const title = metadata.title || $('h1').first().text().trim() || $('title').text().split('|')[0].trim();
    const location = findLabeledText(bodyText, /(?:hely|lokáció|cím|location|address)\s*(?::|-)?\s*([^|;]{3,100})/i);
    const priceText = findPrice(bodyText);
    const areaText = findLabeledMeasure(bodyText, /(?:alapterület|lakóterület|floor\s*area|living\s*area)/i);
    const lotText = findLabeledMeasure(bodyText, /(?:telekterület|telek\s*mérete|lot\s*size|plot\s*size)/i);
    const roomsText = findLabeledNumber(bodyText, /(?:szobák?|szobás|number\s*of\s*rooms)/i);

    return {
      url,
      title: structured.name || title || 'Untitled Property',
      price: structured.price ?? parsePrice(priceText || metadata.description),
      priceText: priceText || (structured.price != null ? String(structured.price) : null),
      location: structured.location || location || null,
      city: extractCity(structured.location || location),
      sizeSqm: structured.sizeSqm ?? parseArea(areaText) ?? findAnyArea(bodyText),
      lotSizeSqm: structured.lotSizeSqm ?? parseArea(lotText),
      rooms: structured.rooms ?? parseRooms(roomsText) ?? findAnyRooms(bodyText),
      description: structured.description || metadata.description || null,
      propertyType: structured.propertyType || null,
      listingId: getListingId(url),
      imageUrls: collectImageUrls($, structuredData, metadata.image),
      parameters,
      structuredData,
    };
  }
}

class IngatlanComExtractor extends HeuristicExtractor {
  extract($, url) {
    const result = super.extract($, url);
    const listingData = readDataJson($, '[data-details-page--moneycheck-listing-data-value]');
    const galleryData = readDataJson($, '[data-details-page--gallery-elements-value]');
    const listing = getStructuredFields(listingData);
    const embeddedImages = collectUrlsFromGallery(galleryData);

    result.title = listing.name || result.title;
    result.price = listing.price ?? result.price;
    result.priceText = listing.price != null ? String(listing.price) : result.priceText;
    result.location = listing.location || result.location;
    result.city = extractCity(result.location);
    result.sizeSqm = listing.sizeSqm ?? result.sizeSqm;
    result.lotSizeSqm = listing.lotSizeSqm ?? result.lotSizeSqm;
    result.rooms = listing.rooms ?? result.rooms;
    result.imageUrls = [...new Set([...embeddedImages, ...result.imageUrls])];
    result.parameters = { ...result.parameters, ...readLabeledFields(listingData) };
    result.structuredData = listingData || result.structuredData;
    return result;
  }
}

function registerExtractor(hostname, extractor) {
  SITE_EXTRACTORS.set(hostname.toLowerCase(), extractor);
}

registerExtractor('ingatlan.com', new IngatlanComExtractor());

function getExtractor(url) {
  const hostname = new URL(url).hostname.toLowerCase();
  for (const [domain, extractor] of SITE_EXTRACTORS) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return extractor;
  }
  return new HeuristicExtractor();
}

/**
 * Fetch HTML from a URL with a browser-like user agent.
 */
async function fetchPage(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
  }
  return resp.text();
}

/**
 * Scrape a single property listing from ingatlan.com.
 * Extracts title, price, location, size, rooms, description, images, and other details.
 */
async function scrapeProperty(url) {
  const html = await fetchPage(url);
  return extractProperty(html, url);
}

function extractProperty(html, url) {
  const $ = cheerio.load(html);
  return getExtractor(url).extract($, url);
}

function readOpenGraph($) {
  const get = (property) => $(`meta[property="og:${property}"]`).attr('content')
    || $(`meta[name="og:${property}"]`).attr('content')
    || null;
  return { title: get('title'), description: get('description'), image: get('image') };
}

function readJsonLd($) {
  const documents = [];
  $('script[type="application/ld+json"]').each(function () {
    try { documents.push(JSON.parse($(this).text())); } catch (_error) { /* Ignore invalid JSON-LD. */ }
  });
  return documents.length ? documents : null;
}

function readDataJson($, selector) {
  const attribute = selector.match(/^\[([^\]]+)\]/)?.[1];
  const raw = attribute ? $(selector).first().attr(attribute) : null;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_error) { return null; }
}

function getStructuredFields(data) {
  const fields = { name: null, price: null, location: null, sizeSqm: null, lotSizeSqm: null, rooms: null, description: null, propertyType: null };
  const visit = (value, parentKey = '') => {
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, parentKey));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      const normalized = normalizeKey(key);
      const scalar = typeof item === 'object' && item !== null
        ? item.value ?? item.name ?? item.text ?? item.url
        : item;
      if (fields.name == null && /^(name|headline|title|titletext)$/.test(normalized) && typeof scalar === 'string') fields.name = scalar;
      if (fields.location == null && /^(address|location|addresslocality|formattedaddress)$/.test(normalized)) fields.location = typeof scalar === 'string' ? scalar : formatAddress(item);
      if (fields.price == null && /^(price|pricevalue|amount|vetelar|ar)$/.test(normalized)) fields.price = parsePrice(scalar);
      if (fields.sizeSqm == null && /^(floorsize|floorarea|livingarea|alapterulet|size|areainSqm|aream2)$/.test(normalized)) fields.sizeSqm = parseArea(scalar);
      if (fields.lotSizeSqm == null && /^(lotsize|plotsize|telekterulet|telekm2)$/.test(normalized)) fields.lotSizeSqm = parseArea(scalar);
      if (fields.rooms == null && /^(numberofrooms|rooms|roomcount|szobak|szobaszam)$/.test(normalized)) fields.rooms = parseRooms(scalar);
      if (fields.description == null && normalized === 'description' && typeof scalar === 'string') fields.description = scalar;
      if (fields.propertyType == null && /^(propertytype|realestatetype)$/.test(normalized) && typeof scalar === 'string') fields.propertyType = scalar;
      visit(item, key);
    }
    if (value['@type'] === 'Offer' && fields.price == null) fields.price = parsePrice(value.price);
    if (value.address && fields.location == null) fields.location = formatAddress(value.address);
  };
  visit(data);
  return fields;
}

function normalizeKey(value) {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function formatAddress(address) {
  if (typeof address === 'string') return address;
  if (!address || typeof address !== 'object') return null;
  return [address.streetAddress, address.addressLocality, address.addressRegion].filter(Boolean).join(', ') || null;
}

function readParameters($) {
  const parameters = {};
  $('tr, dt, li, [class*="parameter"], [class*="feature"]').each(function () {
    const text = $(this).text().replace(/\s+/g, ' ').trim();
    const cells = $(this).children('th, td, dd').map((_, node) => $(node).text().trim()).get();
    if (cells.length >= 2 && cells[0] && cells[cells.length - 1]) parameters[cells[0]] = cells[cells.length - 1];
    else if ($(this).is('dt') && text) parameters[text] = $(this).next('dd').text().trim();
  });
  return parameters;
}

function readLabeledFields(data) {
  const result = {};
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const label = value.label || value.name || value.title || value.key;
    const content = value.value ?? value.valueText ?? value.content;
    if (typeof label === 'string' && content != null) result[label] = String(content);
    Object.values(value).forEach(visit);
  };
  visit(data);
  return result;
}

function findLabeledText(text, pattern) {
  const match = text.match(pattern);
  return match ? match[1].trim() : null;
}

function findLabeledMeasure(text, labelPattern) {
  const match = text.match(new RegExp(`${labelPattern.source}[^\\d]{0,24}(\\d+(?:[.,]\\d+)?)\\s*(?:m2|m²|nm|négyzetméter)?`, 'i'));
  return match ? match[1] : null;
}

function findLabeledNumber(text, labelPattern) {
  const match = text.match(new RegExp(`${labelPattern.source}[^\\d]{0,16}(\\d+(?:[.,]\\d+)?)`, 'i'));
  return match ? match[1] : null;
}

function findAnyArea(text) {
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(?:m2|m²|nm|négyzetméter)\b/i);
  return match ? Number(match[1].replace(',', '.')) : null;
}

function findAnyRooms(text) {
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(?:szoba|szobás|fél\s+szoba)\b/i);
  return match ? Number(match[1].replace(',', '.')) : null;
}

function findPrice(text) {
  const match = text.match(/\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d+)?\s*(?:M\s*Ft|millió\s*Ft|Ft|HUF)|\d+(?:[.,]\d+)?\s*(?:M\s*Ft|millió\s*Ft|Ft|HUF)/i);
  return match ? match[0].trim() : null;
}

function parseArea(value) {
  if (value == null) return null;
  const match = String(value).match(/\d+(?:[.,]\d+)?/);
  return match ? Number(match[0].replace(',', '.')) : null;
}

function parseRooms(value) {
  if (value == null) return null;
  const match = String(value).match(/\d+(?:[.,]\d+)?/);
  return match ? Number(match[0].replace(',', '.')) : null;
}

function collectImageUrls($, structuredData, ogImage) {
  const images = [];
  $('img, picture source').each(function () {
    const candidates = [$(this).attr('data-src'), $(this).attr('data-lazy-src'), $(this).attr('src')];
    const srcset = $(this).attr('srcset');
    if (srcset) candidates.push(srcset.split(',').map(item => item.trim().split(/\s+/)[0]).pop());
    candidates.forEach(url => addImageUrl(images, url));
  });
  collectUrlsFromGallery(structuredData).forEach(url => addImageUrl(images, url));
  addImageUrl(images, ogImage);
  return [...new Set(images)];
}

function collectUrlsFromGallery(data) {
  const urls = [];
  const preferred = /original|full|high.?res|large|高清/i;
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value === 'string') {
      if (isPropertyImage(value)) urls.push(value);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const entries = Object.entries(value);
    for (const [key, item] of entries) {
      if (typeof item === 'string' && /^(url|src|image|images|imageurl|href|sourceurl|original(?:url)?|full(?:url)?|large(?:url)?|highresolution(?:url)?)$/i.test(key)) {
        if (preferred.test(key)) urls.unshift(item);
        else urls.push(item);
      } else if (item && typeof item === 'object') visit(item);
    }
  };
  visit(data);
  return [...new Set(urls.filter(isPropertyImage))];
}

function addImageUrl(images, value) {
  if (typeof value !== 'string' || !isPropertyImage(value)) return;
  const url = value.startsWith('//') ? `https:${value}` : value;
  if (!images.includes(url)) images.push(url);
}

function isPropertyImage(value) {
  return /^(https?:)?\/\//i.test(value)
    && !/\.(?:svg)(?:[?#]|$)/i.test(value)
    && !/(?:logo|icon|banner|avatar|placeholder)/i.test(value);
}

function getListingId(url) {
  const match = url.match(/(\d+)(?:\?|$|#)/);
  return match ? match[1] : url.split('/').filter(Boolean).pop() || null;
}

/**
 * Search for properties in a city on ingatlan.com.
 * Returns an array of listing URLs and basic info.
 */
async function searchCity(cityName, maxPages) {
  const maxP = maxPages || 1;
  const slug = cityName.toLowerCase().replace(/\s+/g, '-').replace(/[áà]/g, 'a').replace(/[éè]/g, 'e')
    .replace(/[íì]/g, 'i').replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u')
    .replace(/ő/g, 'o').replace(/ű/g, 'u');

  const results = [];

  for (let page = 1; page <= maxP; page++) {
    const searchUrl = `https://ingatlan.com/lista/elado+haz+${slug}${page > 1 ? '?page=' + page : ''}`;
    try {
      const html = await fetchPage(searchUrl);
      const $ = cheerio.load(html);

      // Extract listing cards
      $('[class*="listing"], [class*="result"] a[href*="/"], .listing-card, a.listing').each(function () {
        const link = $(this).attr('href') || $(this).find('a').first().attr('href');
        if (!link || !link.includes('/')) return;

        const fullUrl = link.startsWith('http') ? link : 'https://ingatlan.com' + link;
        const itemPrice = $(this).find('[class*="price"]').first().text().trim();
        const itemTitle = $(this).find('[class*="title"], h2, h3').first().text().trim();
        const itemLocation = $(this).find('[class*="address"], [class*="location"]').first().text().trim();

        let isIngatlanUrl = false;
        try {
          const parsed = new URL(fullUrl);
          isIngatlanUrl = parsed.hostname === 'ingatlan.com' || parsed.hostname === 'www.ingatlan.com';
        } catch { /* ignore invalid URLs */ }

        if (isIngatlanUrl && !results.some(r => r.url === fullUrl)) {
          results.push({
            url: fullUrl,
            title: itemTitle || null,
            priceText: itemPrice || null,
            price: parsePrice(itemPrice),
            location: itemLocation || null,
          });
        }
      });
    } catch (err) {
      console.error(`Error searching page ${page} for ${cityName}:`, err.message);
    }
  }

  return results;
}

/**
 * Parse a Hungarian price string to a number.
 * Handles formats like "45 000 000 Ft", "45M Ft", etc.
 */
function parsePrice(text) {
  if (!text) return null;
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  const source = String(text).trim();

  const mMatch = source.match(/([\d.,]+)\s*(?:M|millió)\s*(?:Ft|HUF)?/i);
  if (mMatch) {
    return parseFloat(mMatch[1].replace(',', '.')) * 1000000;
  }

  const numStr = source.replace(/[^\d,.]/g, '');
  if (!numStr) return null;
  const lastSeparator = Math.max(numStr.lastIndexOf('.'), numStr.lastIndexOf(','));
  const decimalDigits = lastSeparator < 0 ? 0 : numStr.length - lastSeparator - 1;
  const normalized = decimalDigits > 0 && decimalDigits < 3
    ? `${numStr.slice(0, lastSeparator).replace(/[.,]/g, '')}.${numStr.slice(lastSeparator + 1)}`
    : numStr.replace(/[.,]/g, '');
  const num = parseFloat(normalized);
  return isNaN(num) ? null : num;
}

/**
 * Extract city name from a location string.
 */
function extractCity(location) {
  if (!location) return null;
  // Hungarian addresses typically have city at beginning or after district
  const parts = location.split(',').map(p => p.trim());
  // Return first meaningful part
  for (const part of parts) {
    const clean = part.replace(/^\d+\.?\s*ker\.?/i, '').trim();
    if (clean && clean.length > 1) return clean;
  }
  return parts[0] || null;
}

/**
 * Calculate average and median from an array of numbers.
 */
function calculatePriceStats(prices) {
  const valid = prices.filter(p => p != null && !isNaN(p) && p > 0);
  if (valid.length === 0) return { avg: 0, median: 0, count: 0, min: 0, max: 0 };

  const sorted = [...valid].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = Math.round(sum / sorted.length);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];

  return {
    avg,
    median,
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

module.exports = {
  scrapeProperty,
  extractProperty,
  searchCity,
  calculatePriceStats,
  parsePrice,
  extractCity,
  fetchPage,
  HeuristicExtractor,
  IngatlanComExtractor,
  registerExtractor,
};
