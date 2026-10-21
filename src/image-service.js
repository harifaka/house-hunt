/**
 * Image storage backed by a Cloudflare R2 bucket (S3-compatible API).
 *
 * Uploads are held in memory by multer and streamed straight to R2, so the
 * container never touches the local filesystem. Public URLs are derived from
 * R2_PUBLIC_DOMAIN (an R2 public bucket domain or a custom domain).
 */

const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const ALLOWED_MIME_TYPES = /^image\/(jpeg|png|gif|webp|bmp|svg\+xml)$/;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const DEFAULT_OBJECT_KEY_PREFIX = 'house-hunt/images';

let cachedClient = null;
let cachedClientSignature = '';

function getR2Config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME;
  const publicDomain = process.env.R2_PUBLIC_DOMAIN;

  const missing = [
    ['R2_ACCOUNT_ID', accountId],
    ['R2_ACCESS_KEY_ID', accessKeyId],
    ['R2_SECRET_ACCESS_KEY', secretAccessKey],
    ['R2_BUCKET_NAME', bucketName]
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Cloudflare R2 is not configured. Missing environment variable(s): ${missing.join(', ')}. ` +
      'Set them in your environment (see .env.example) before uploading images.'
    );
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketName,
    publicDomain: normalizeDomain(publicDomain),
    endpoint: process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`
  };
}

function isR2Configured() {
  try {
    getR2Config();
    return true;
  } catch {
    return false;
  }
}

function normalizeDomain(domain) {
  if (!domain) return '';
  const trimmed = String(domain).trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function getR2Client() {
  const config = getR2Config();
  const signature = `${config.endpoint}|${config.accessKeyId}|${config.secretAccessKey}`;
  if (!cachedClient || cachedClientSignature !== signature) {
    cachedClient = new S3Client({
      region: 'auto',
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      },
      // R2 requires path-style addressing for bucket-scoped requests.
      forcePathStyle: true,
      // R2 does not implement the new default flexible checksums.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED'
    });
    cachedClientSignature = signature;
  }
  return cachedClient;
}

// --- Multer (memory storage) ---

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// --- URL helpers ---

/**
 * Build the public URL for an object key or a value already stored in the
 * database (legacy local filenames, absolute URLs, or an R2 key).
 */
function publicUrlFor(fileNameOrKey) {
  if (!fileNameOrKey) return '';
  const value = String(fileNameOrKey);
  if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value;

  const key = value.replace(/^\/+/, '').replace(/^uploads\//, '');
  // Never require full R2 credentials just to render a URL.
  const publicDomain = normalizeDomain(process.env.R2_PUBLIC_DOMAIN);

  if (!publicDomain) {
    // Local development without R2_PUBLIC_DOMAIN: keep the old relative path.
    return `/uploads/${key}`;
  }
  if (value.startsWith('/uploads/')) {
    return `${publicDomain}/${key}`;
  }
  return `${publicDomain}/${value.replace(/^\/+/, '')}`;
}

function buildObjectKey(originalName) {
  const extension = path.extname(originalName || '').toLowerCase();
  const prefix = process.env.R2_OBJECT_KEY_PREFIX || DEFAULT_OBJECT_KEY_PREFIX;
  const date = new Date();
  const folder = `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${prefix}/${folder}/${crypto.randomUUID()}${extension}`;
}

/**
 * Upload an in-memory image buffer to R2.
 *
 * @param {object} file - multer file object (memory storage: has .buffer)
 * @param {object} [options]
 * @param {string} [options.key] - explicit object key
 * @returns {Promise<{key: string, filename: string, url: string, thumbUrl: string, provider: string, size: number}>}
 */
async function storeImage(file, options = {}) {
  if (!file || !file.buffer) {
    throw new Error('No image buffer received (multer must use memory storage)');
  }

  const config = getR2Config();
  const key = options.key || buildObjectKey(file.originalname);
  const contentType = file.mimetype || 'application/octet-stream';

  await getR2Client().send(new PutObjectCommand({
    Bucket: config.bucketName,
    Key: key,
    Body: file.buffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable'
  }));

  const url = config.publicDomain ? `${config.publicDomain}/${key}` : `/uploads/${path.basename(key)}`;

  return {
    key,
    filename: url,
    url,
    thumbUrl: url,
    provider: 'r2',
    size: file.size
  };
}

/**
 * Delete an object from R2. Accepts an R2 key, a public URL, or a legacy
 * `/uploads/<name>` path. Failures are swallowed by callers when best-effort.
 */
async function deleteImage(fileNameOrUrl) {
  if (!fileNameOrUrl) return false;

  const config = getR2Config();
  const key = objectKeyFrom(fileNameOrUrl, config.publicDomain);

  await getR2Client().send(new DeleteObjectCommand({
    Bucket: config.bucketName,
    Key: key
  }));
  return true;
}

function objectKeyFrom(fileNameOrUrl, publicDomain) {
  const value = String(fileNameOrUrl);

  if (publicDomain && value.startsWith(publicDomain + '/')) {
    return value.slice(publicDomain.length + 1);
  }

  if (/^https?:\/\//i.test(value)) {
    return new URL(value).pathname.replace(/^\/+/, '');
  }

  return value.replace(/^\/+/, '').replace(/^uploads\//, '');
}

/**
 * Express middleware to handle multer errors gracefully.
 * Use after upload.single() or upload.array() calls.
 */
function handleUploadError(err, req, res, next) {
  if (err) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 10 MB.' });
    }
    if (err.message === 'Only image files are allowed') {
      return res.status(400).json({ error: err.message });
    }
    return res.status(400).json({ error: 'Upload failed: ' + err.message });
  }
  next();
}

module.exports = {
  upload,
  storeImage,
  deleteImage,
  publicUrlFor,
  getR2Config,
  isR2Configured,
  handleUploadError,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE
};
