const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('./database');

// --- Configuration ---

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const ALLOWED_MIME_TYPES = /^image\/(jpeg|png|gif|webp|bmp|svg\+xml)$/;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// --- Multer setup ---

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// --- imgbb upload ---

/**
 * Upload an image to imgbb cloud storage.
 * Returns the public URL of the uploaded image.
 */
async function uploadToImgbb(filePath, apiKey) {
  const imageBuffer = fs.readFileSync(filePath);
  const base64Image = imageBuffer.toString('base64');

  const formData = new URLSearchParams();
  formData.append('key', apiKey);
  formData.append('image', base64Image);

  const response = await fetch('https://api.imgbb.com/1/upload', {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`imgbb upload failed (HTTP ${response.status}): ${text}`);
  }

  const data = await response.json();
  if (!data.success || !data.data || !data.data.url) {
    throw new Error('imgbb upload returned unexpected response');
  }

  return {
    url: data.data.url,
    deleteUrl: data.data.delete_url || null,
    thumbUrl: data.data.thumb ? data.data.thumb.url : data.data.url
  };
}

// --- Image storage provider ---

/**
 * Get the current image storage configuration from settings.
 */
async function getImageStorageConfig() {
  const db = await getDb();
  try {
    const providerRow = await db.prepare("SELECT value FROM settings WHERE key = 'image_storage_provider'").get();
    const apiKeyRow = await db.prepare("SELECT value FROM settings WHERE key = 'imgbb_api_key'").get();
    return {
      provider: (providerRow && providerRow.value) || 'local',
      imgbbApiKey: (apiKeyRow && apiKeyRow.value) || ''
    };
  } finally {
    await db.close();
  }
}

/**
 * Store an uploaded image using the configured provider.
 * If imgbb is configured and has a valid API key, uploads to imgbb.
 * Otherwise, uses local storage (file already on disk from multer).
 *
 * @param {object} file - multer file object (has .path, .filename, etc.)
 * @returns {object} { filename, url, provider }
 */
async function storeImage(file) {
  const config = await getImageStorageConfig();

  if (config.provider === 'imgbb' && config.imgbbApiKey) {
    try {
      const result = await uploadToImgbb(file.path, config.imgbbApiKey);
      // Keep local copy as backup
      return {
        filename: file.filename,
        url: result.url,
        thumbUrl: result.thumbUrl,
        provider: 'imgbb'
      };
    } catch (err) {
      // Fall back to local on imgbb failure
      console.error('[image-service] imgbb upload failed, falling back to local:', err.message);
      return {
        filename: file.filename,
        url: '/uploads/' + file.filename,
        thumbUrl: '/uploads/' + file.filename,
        provider: 'local'
      };
    }
  }

  return {
    filename: file.filename,
    url: '/uploads/' + file.filename,
    thumbUrl: '/uploads/' + file.filename,
    provider: 'local'
  };
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
    // Multer or other upload error
    return res.status(400).json({ error: 'Upload failed: ' + err.message });
  }
  next();
}

module.exports = {
  upload,
  storeImage,
  getImageStorageConfig,
  uploadToImgbb,
  handleUploadError,
  UPLOADS_DIR,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE
};
