const http = require('http');

// Capture requests sent by the AWS SDK to a fake S3-compatible endpoint
const requests = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString()
    });
    res.writeHead(200, { ETag: '"test-etag"' });
    res.end();
  });
});

let imageService;

beforeAll(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  const { port } = server.address();

  process.env.R2_ACCOUNT_ID = 'test-account';
  process.env.R2_ACCESS_KEY_ID = 'test-key-id';
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
  process.env.R2_BUCKET_NAME = 'house-hunt-images';
  process.env.R2_PUBLIC_DOMAIN = 'https://images.example.com/';
  process.env.R2_ENDPOINT = `http://127.0.0.1:${port}`;

  imageService = require('../src/image-service');
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
  requests.length = 0;
});

describe('R2 image storage', () => {
  test('storeImage uploads the buffer to the configured bucket', async () => {
    const stored = await imageService.storeImage({
      buffer: Buffer.from('image-bytes'),
      originalname: 'Photo.JPG',
      mimetype: 'image/jpeg',
      size: 11
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('PUT');
    expect(requests[0].url).toContain('/house-hunt-images/house-hunt/images/');
    expect(requests[0].url).toMatch(/\.jpg\?/);
    expect(requests[0].headers['content-type']).toBe('image/jpeg');
    expect(requests[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256/);
    expect(requests[0].body).toBe('image-bytes');

    expect(stored.provider).toBe('r2');
    expect(stored.key).toContain('house-hunt/images/');
    expect(stored.url).toBe(`https://images.example.com/${stored.key}`);
    expect(stored.filename).toBe(stored.url);
  });

  test('deleteImage removes the object using the key derived from its public URL', async () => {
    const key = 'house-hunt/images/2024/01/existing.jpg';
    await imageService.deleteImage(`https://images.example.com/${key}`);

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('DELETE');
    expect(requests[0].url).toContain(`/house-hunt-images/${key}`);
  });

  test('storeImage rejects empty file objects', async () => {
    await expect(imageService.storeImage({ originalname: 'x.jpg' })).rejects.toThrow(/buffer/i);
  });
});

describe('publicUrlFor', () => {
  test('passes through absolute URLs', () => {
    expect(imageService.publicUrlFor('https://ingatlan.com/listing.jpg')).toBe('https://ingatlan.com/listing.jpg');
  });

  test('resolves legacy local filenames against R2_PUBLIC_DOMAIN', () => {
    expect(imageService.publicUrlFor('123-456.jpg')).toBe('https://images.example.com/123-456.jpg');
  });

  test('resolves legacy /uploads paths against R2_PUBLIC_DOMAIN', () => {
    expect(imageService.publicUrlFor('/uploads/123-456.jpg')).toBe('https://images.example.com/123-456.jpg');
  });

  test('returns an empty string for missing values', () => {
    expect(imageService.publicUrlFor(null)).toBe('');
    expect(imageService.publicUrlFor(undefined)).toBe('');
  });
});
