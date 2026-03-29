/**
 * Scraper service for ingatlan.com property listings.
 * Uses built-in fetch (Node 18+) and cheerio for HTML parsing.
 */
const cheerio = require('cheerio');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
  const $ = cheerio.load(html);

  // Extract listing ID from URL
  const urlMatch = url.match(/(\d+)(?:\?|$|#)/);
  const listingId = urlMatch ? urlMatch[1] : url.split('/').filter(Boolean).pop();

  // Title
  const title = $('h1.listing-title, .listing__title, h1[class*="title"]').first().text().trim()
    || $('title').text().split('|')[0].trim()
    || $('h1').first().text().trim();

  // Price
  const priceText = $('.parameter-price, .listing-price, [class*="price"]').first().text().trim()
    || $('[data-testid="price"]').text().trim();
  const priceNum = parsePrice(priceText);

  // Location / address
  const location = $('.listing-address, .parameter-location, [class*="address"], [class*="location"]').first().text().trim()
    || $('[data-testid="address"]').text().trim();
  const city = extractCity(location);

  // Size (square meters)
  let sizeSqm = null;
  const sizeText = $('[class*="area"], [class*="size"]').first().text().trim();
  const sizeMatch = sizeText.match(/([\d,\.]+)\s*m²/);
  if (sizeMatch) {
    sizeSqm = parseFloat(sizeMatch[1].replace(',', '.'));
  }

  // Number of rooms
  let rooms = null;
  const roomsText = $('[class*="room"]').first().text().trim();
  const roomsMatch = roomsText.match(/(\d+)/);
  if (roomsMatch) {
    rooms = parseInt(roomsMatch[1], 10);
  }

  // Description
  const description = $('.listing-description, [class*="description"], [class*="detail-text"]').first().text().trim();

  // Property type
  const propertyType = $('[class*="property-type"], [class*="type"]').first().text().trim() || 'house';

  // Images
  const imageUrls = [];
  $('img[src*="ingatlan"], img[class*="gallery"], img[class*="photo"], img[class*="image"], [class*="gallery"] img, picture img').each(function () {
    const src = $(this).attr('src') || $(this).attr('data-src') || $(this).attr('data-lazy-src');
    if (src && !src.includes('logo') && !src.includes('icon') && !src.includes('svg') && !imageUrls.includes(src)) {
      imageUrls.push(src.startsWith('//') ? 'https:' + src : src);
    }
  });

  // Additional parameters from parameter tables
  const parameters = {};
  $('.parameters tr, .listing-parameters tr, [class*="parameter"] tr, .parameters li, [class*="param"] li').each(function () {
    const label = $(this).find('td:first-child, .parameter-label, dt').text().trim();
    const value = $(this).find('td:last-child, .parameter-value, dd').text().trim();
    if (label && value) {
      parameters[label] = value;
    }
  });

  // Also try structured data / JSON-LD
  let structuredData = null;
  $('script[type="application/ld+json"]').each(function () {
    try {
      const json = JSON.parse($(this).html());
      if (json['@type'] === 'Product' || json['@type'] === 'RealEstateListing' || json['@type'] === 'Residence') {
        structuredData = json;
      }
    } catch (e) { /* ignore */ }
  });

  // Try to get more data from structured data
  if (structuredData) {
    if (!sizeSqm && structuredData.floorSize) {
      const m = String(structuredData.floorSize.value || structuredData.floorSize).match(/([\d,.]+)/);
      if (m) sizeSqm = parseFloat(m[1].replace(',', '.'));
    }
    if (!rooms && structuredData.numberOfRooms) {
      rooms = parseInt(structuredData.numberOfRooms, 10);
    }
    if (structuredData.image) {
      const imgs = Array.isArray(structuredData.image) ? structuredData.image : [structuredData.image];
      for (const img of imgs) {
        const imgUrl = typeof img === 'string' ? img : img.url;
        if (imgUrl && !imageUrls.includes(imgUrl)) imageUrls.push(imgUrl);
      }
    }
  }

  return {
    url,
    title: title || 'Untitled Property',
    price: priceNum,
    priceText: priceText || null,
    location: location || null,
    city: city || null,
    sizeSqm,
    rooms,
    description: description || null,
    propertyType: propertyType || null,
    listingId: listingId || null,
    imageUrls,
    parameters,
    structuredData,
  };
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
  const cleaned = text.replace(/\s/g, '').replace(/Ft|HUF|,-/gi, '').trim();

  // Handle "M Ft" format (millions)
  const mMatch = cleaned.match(/([\d,\.]+)\s*M/i);
  if (mMatch) {
    return parseFloat(mMatch[1].replace(',', '.')) * 1000000;
  }

  // Handle plain numbers
  const numStr = cleaned.replace(/[^\d,\.]/g, '');
  if (!numStr) return null;
  const num = parseFloat(numStr.replace(/\./g, '').replace(',', '.'));
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
  searchCity,
  calculatePriceStats,
  parsePrice,
  extractCity,
  fetchPage,
};
