const { parsePrice, extractCity, calculatePriceStats, extractProperty } = require('../src/scraper');

describe('Scraper Utilities', () => {
  describe('parsePrice', () => {
    test('parses Hungarian price format with spaces', () => {
      expect(parsePrice('45 000 000 Ft')).toBe(45000000);
    });

    test('parses million shorthand', () => {
      expect(parsePrice('45M Ft')).toBe(45000000);
    });

    test('parses decimal million shorthand', () => {
      expect(parsePrice('45.5M Ft')).toBe(45500000);
    });

    test('parses Hungarian million wording and decimal comma', () => {
      expect(parsePrice('2,5 millió Ft')).toBe(2500000);
    });

    test('returns null for invalid input', () => {
      expect(parsePrice('')).toBeNull();
      expect(parsePrice(null)).toBeNull();
      expect(parsePrice(undefined)).toBeNull();
    });
  });

  describe('extractCity', () => {
    test('extracts city from comma-separated address', () => {
      const city = extractCity('Budapest, XIII. kerület');
      expect(city).toBeTruthy();
    });

    test('returns input for single location', () => {
      expect(extractCity('Debrecen')).toBe('Debrecen');
    });

    test('handles empty input', () => {
      expect(extractCity('')).toBeNull();
      expect(extractCity(null)).toBeNull();
    });
  });

  describe('calculatePriceStats', () => {
    test('calculates stats for a set of prices', () => {
      const stats = calculatePriceStats([10, 20, 30, 40, 50]);
      expect(stats.avg).toBe(30);
      expect(stats.median).toBe(30);
      expect(stats.min).toBe(10);
      expect(stats.max).toBe(50);
    });

    test('handles single price', () => {
      const stats = calculatePriceStats([100]);
      expect(stats.avg).toBe(100);
      expect(stats.median).toBe(100);
    });

    test('handles empty array', () => {
      const stats = calculatePriceStats([]);
      expect(stats.avg).toBe(0);
      expect(stats.min).toBe(0);
      expect(stats.max).toBe(0);
    });
  });

  describe('extractProperty', () => {
    test('extracts ingatlan.com listing fields and gallery data attributes', () => {
      const html = `<html><head><title>Eladó ház</title></head><body>
        <h1>Eladó családi ház</h1>
        <meta name="description" content="Short metadata description">
        <div data-details-page--moneycheck-listing-data-value='{"price":"89 000 000 Ft","Alapterület":"85 m²","Telekterület":"600 m²","Szobák":"3","address":"Szeged","description":"Complete listing description with all the details."}'></div>
        <p id="listing-description">Complete listing description<br>with all the details.</p>
        <div data-details-page--gallery-elements-value='[{"originalUrl":"https://cdn.example.test/house-large.jpg"},{"url":"https://cdn.example.test/house-2.jpg"}]'></div>
        <img src="https://cdn.example.test/logo.svg"><img data-src="https://cdn.example.test/house-3.jpg">
      </body></html>`;

      const property = extractProperty(html, 'https://ingatlan.com/12345678');

      expect(property.title).toBe('Eladó családi ház');
      expect(property.price).toBe(89000000);
      expect(property.sizeSqm).toBe(85);
      expect(property.lotSizeSqm).toBe(600);
      expect(property.rooms).toBe(3);
      expect(property.location).toBe('Szeged');
      expect(property.description).toBe('Complete listing description\nwith all the details.');
      expect(property.imageUrls).toContain('https://cdn.example.test/house-large.jpg');
      expect(property.imageUrls).not.toContain('https://cdn.example.test/logo.svg');
    });

    test('parses current ingatlan.com price and location markup', () => {
      const html = `<html><head><meta property="og:title" content="Eladó családi ház, Tápiószecső"></head><body>
        <h1><span>Tápiószecső, Pest megye</span><span>Eladó családi ház</span></h1>
        <div>118,50 millió Ft</div><div>Alapterület 150 m²</div>
        <div data-details-page--moneycheck-listing-data-value='{"priceHuf":{"amount":"11850000000","currency":"HUF"},"property":{"lotSize":662,"roomCount":3}}'></div>
      </body></html>`;

      const property = extractProperty(html, 'https://ingatlan.com/35383142');

      expect(property.price).toBe(118500000);
      expect(property.location).toBe('Tápiószecső, Pest megye');
      expect(property.city).toBe('Tápiószecső');
      expect(property.sizeSqm).toBe(150);
      expect(property.lotSizeSqm).toBe(662);
      expect(property.rooms).toBe(3);
    });

    test('uses schema.org, Open Graph, and generic Hungarian text on other hosts', () => {
      const html = `<html><head>
        <meta property="og:title" content="Otthoncentrum listing">
        <meta property="og:image" content="https://cdn.example.test/og-home.jpg">
        <script type="application/ld+json">{"@type":"Product","name":"Modern house","offers":{"@type":"Offer","price":"125000000","priceCurrency":"HUF"},"floorSize":{"value":92},"numberOfRooms":4,"image":["https://cdn.example.test/schema-home.jpg"]}</script>
      </head><body><main>Alapterület: 92 m², telekterület: 450 m², 4 szoba, 125 000 000 Ft</main></body></html>`;

      const property = extractProperty(html, 'https://otthoncentrum.hu/listing/456');

      expect(property.title).toBe('Modern house');
      expect(property.price).toBe(125000000);
      expect(property.sizeSqm).toBe(92);
      expect(property.lotSizeSqm).toBe(450);
      expect(property.rooms).toBe(4);
      expect(property.imageUrls).toEqual(expect.arrayContaining([
        'https://cdn.example.test/schema-home.jpg',
        'https://cdn.example.test/og-home.jpg',
      ]));
    });

    test('imports a saved page without a listing URL and reads its meta description', () => {
      const html = '<html><head><title>Saved house</title><meta name="description" content="A complete saved-page description."></head><body></body></html>';
      const property = extractProperty(html, null);

      expect(property.title).toBe('Saved house');
      expect(property.url).toBeNull();
      expect(property.listingId).toBeNull();
      expect(property.description).toBe('A complete saved-page description.');
    });
  });
});
