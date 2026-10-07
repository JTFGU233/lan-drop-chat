const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs-extra');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e8, // 100MB 限制仅针对消息内容，文件上传由 multer 处理
});

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'chat.db');
const CLEANUP_PLACEHOLDER = '[系统提示：该文件已被清理，释放本地空间]';

fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(DATA_DIR);

const db = new sqlite3.Database(DB_PATH);

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve(this);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows);
    });
  });
}

// === Timestamp handling ===
// Storage: messages.timestamp / favorites.created_at hold SQLite-style UTC strings
// ("YYYY-MM-DD HH:MM:SS", the same format CURRENT_TIMESTAMP produces) so ORDER BY
// stays lexicographically consistent with legacy rows.
// API contract: every timestamp sent to clients is ISO 8601 UTC with a trailing "Z"
// (e.g. "2026-05-24T08:06:27.000Z"), or null when the stored value is unparseable.
// Naive strings without a zone marker are interpreted as UTC, because SQLite's
// CURRENT_TIMESTAMP / datetime('now') are UTC.
const NAIVE_OR_ISO_TS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?)?$/i;

function parseStoredTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number' || (typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value))) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    let ms;
    if (num >= 1e11) ms = num; // epoch milliseconds
    else if (num >= 1e8) ms = num * 1000; // epoch seconds
    else if (num >= 1e6 && num < 1e7) ms = (num - 2440587.5) * 86400000; // SQLite julianday()
    else return null;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (typeof value !== 'string') return null;
  const str = value.trim();
  const m = NAIVE_OR_ISO_TS_RE.exec(str);

  if (m) {
    const [, y, mo, d, h = '0', mi = '0', sec = '0', frac = '', zone] = m;
    const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
    let epoch = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec), ms);

    if (zone && !/^(Z|UTC|GMT)$/i.test(zone)) {
      const zm = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone);
      if (zm) {
        const offsetMin = (Number(zm[2]) * 60 + Number(zm[3] || 0)) * (zm[1] === '-' ? -1 : 1);
        epoch -= offsetMin * 60000;
      }
    }

    const date = new Date(epoch);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // Last resort for other formats that carry their own zone (e.g. RFC 2822).
  const fallback = new Date(str);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function toApiTimestamp(value) {
  const date = parseStoredTimestamp(value);
  return date ? date.toISOString() : null;
}

function toDbTimestamp(date = new Date()) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeIp(value = '') {
  return String(value || '').replace('::ffff:', '');
}

// === Device identity ===
// Clients report a coarse device kind (socket auth / X-Device header); the server
// whitelists it and falls back to parsing the User-Agent. Stored per message so
// every device sees "iPhone" / "Mac" instead of a bare IP.
const DEVICE_KINDS = new Set(['iphone', 'ipad', 'android', 'android-tablet', 'mac', 'windows', 'linux', 'other']);

function resolveDevice(hint, userAgent = '') {
  const kind = String(hint || '').trim().toLowerCase();
  if (DEVICE_KINDS.has(kind)) return kind;

  const ua = String(userAgent || '');
  if (/iPhone|iPod/.test(ua)) return 'iphone';
  if (/iPad/.test(ua)) return 'ipad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'android' : 'android-tablet';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  if (/Linux|CrOS/.test(ua)) return 'linux';
  return 'other';
}

function deviceFromRequest(req) {
  return resolveDevice(req.get('X-Device'), req.get('User-Agent'));
}

function uploadPathFromUrl(fileUrl) {
  return path.join(UPLOADS_DIR, path.basename(String(fileUrl || '')));
}

async function statFileSize(fileUrl) {
  if (!fileUrl) return null;
  try {
    const stat = await fs.stat(uploadPathFromUrl(fileUrl));
    return stat.size;
  } catch {
    return null;
  }
}

// Stored names are "<timestamp>-<random>-<original name>"; strip the prefix for downloads.
function originalNameFromStored(fileUrl) {
  return path.basename(String(fileUrl || '')).replace(/^\d+-\d+-/, '') || 'download';
}

function decodeOriginalName(name) {
  return Buffer.from(name || '', 'latin1').toString('utf8');
}

function resolveMessageType(row) {
  if (row?.message_type) return row.message_type;
  if (row?.content === CLEANUP_PLACEHOLDER) return 'system';
  if (row?.file_url) return 'file';
  return 'text';
}

function buildGroupContent(count) {
  return `[图片组] ${count} 张图片`;
}

function buildFileMessageFromUpload(ip, device, file) {
  return {
    ip,
    device,
    content: `[文件] ${decodeOriginalName(file.originalname)}`,
    file_url: `/uploads/${file.filename}`,
    file_type: file.mimetype,
    message_type: 'file'
  };
}

async function initializeDatabase() {
  await runAsync(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT,
    content TEXT,
    file_url TEXT,
    file_type TEXT,
    message_type TEXT NOT NULL DEFAULT 'text',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_message_id INTEGER,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS message_group_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    sort_order INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_type TEXT NOT NULL
  )`);

  await runAsync(`CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_source_message_id ON favorites(source_message_id)`);
  await runAsync(`CREATE INDEX IF NOT EXISTS idx_message_group_items_message_id ON message_group_items(message_id, sort_order, id)`);

  const columns = await allAsync(`PRAGMA table_info(messages)`);
  const hasMessageType = columns.some((column) => column.name === 'message_type');

  if (!hasMessageType) {
    await runAsync(`ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'text'`);
  }

  if (!columns.some((column) => column.name === 'device')) {
    await runAsync(`ALTER TABLE messages ADD COLUMN device TEXT`);
  }

  await runAsync(
    `UPDATE messages
     SET message_type = 'system'
     WHERE content = ?`,
    [CLEANUP_PLACEHOLDER]
  );

  await runAsync(
    `UPDATE messages
     SET message_type = 'file'
     WHERE file_url IS NOT NULL
       AND (message_type IS NULL OR TRIM(message_type) = '' OR message_type = 'text')`
  );

  await runAsync(
    `UPDATE messages
     SET message_type = 'text'
     WHERE message_type IS NULL OR TRIM(message_type) = ''`
  );
}

async function fetchGroupItemsByMessageIds(messageIds) {
  if (!messageIds.length) {
    return new Map();
  }

  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = await allAsync(
    `SELECT id, message_id, sort_order, file_name, file_url, file_type
     FROM message_group_items
     WHERE message_id IN (${placeholders})
     ORDER BY message_id ASC, sort_order ASC, id ASC`,
    messageIds
  );

  return rows.reduce((map, row) => {
    const current = map.get(row.message_id) || [];
    current.push(row);
    map.set(row.message_id, current);
    return map;
  }, new Map());
}

async function hydrateMessages(rows) {
  const normalizedRows = rows.map((row) => ({
    ...row,
    message_type: resolveMessageType(row),
    timestamp: toApiTimestamp(row.timestamp)
  }));

  const imageGroupIds = normalizedRows
    .filter((row) => row.message_type === 'image_group')
    .map((row) => row.id);

  const groupItemsByMessageId = await fetchGroupItemsByMessageIds(imageGroupIds);

  // File sizes are read from disk (not stored), so cleaned-up files report null.
  return Promise.all(normalizedRows.map(async (row) => {
    const items = groupItemsByMessageId.get(row.id) || [];
    return {
      ...row,
      file_size: row.message_type === 'file' ? await statFileSize(row.file_url) : null,
      group_items: await Promise.all(items.map(async (item) => ({ ...item, file_size: await statFileSize(item.file_url) })))
    };
  }));
}

async function getHistoryRows() {
  const rows = await allAsync(`SELECT * FROM messages ORDER BY timestamp ASC, id ASC`);
  return hydrateMessages(rows);
}

async function removeStoredFiles(files = []) {
  await Promise.all(
    files.map((file) => {
      const filePath = file?.path || path.join(UPLOADS_DIR, file?.filename || '');
      if (!filePath) return Promise.resolve();
      return fs.remove(filePath).catch(() => {});
    })
  );
}

async function withTransaction(work) {
  await runAsync('BEGIN TRANSACTION');
  try {
    const result = await work();
    await runAsync('COMMIT');
    return result;
  } catch (error) {
    try {
      await runAsync('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback failed', rollbackError);
    }

    throw error;
  }
}

app.use(express.static('public'));
// `?download` forces a save dialog with the original file name instead of inline display.
app.use('/uploads', (req, res, next) => {
  if (req.query.download !== undefined) {
    let storedPath = req.path;
    try { storedPath = decodeURIComponent(req.path); } catch { /* keep raw path */ }
    res.attachment(originalNameFromStored(storedPath));
  }
  next();
});
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json());

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + decodeOriginalName(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: Infinity }
});

function getFavoriteRows(res) {
  db.all(
    `SELECT id, source_message_id, content, created_at
     FROM favorites
     ORDER BY created_at DESC, id DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows.map((row) => ({ ...row, created_at: toApiTimestamp(row.created_at) })));
    }
  );
}

app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  const ip = normalizeIp(req.ip);
  const fileData = buildFileMessageFromUpload(ip, deviceFromRequest(req), req.file);

  const dbTimestamp = toDbTimestamp();

  try {
    const result = await runAsync(
      `INSERT INTO messages (ip, device, content, file_url, file_type, message_type, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [fileData.ip, fileData.device, fileData.content, fileData.file_url, fileData.file_type, fileData.message_type, dbTimestamp]
    );

    const message = {
      id: result.lastID,
      ...fileData,
      file_size: req.file.size,
      timestamp: toApiTimestamp(dbTimestamp),
      group_items: []
    };

    io.emit('chat message', message);
    res.json(message);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.post('/upload/images', upload.array('files'), async (req, res) => {
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) {
    return res.status(400).json({ error: 'No image files uploaded.' });
  }

  const allImages = files.every((file) => String(file.mimetype || '').startsWith('image/'));
  if (!allImages) {
    await removeStoredFiles(files);
    return res.status(400).json({ error: 'Only image files are allowed in an image group.' });
  }

  const ip = normalizeIp(req.ip);
  const device = deviceFromRequest(req);
  const dbTimestamp = toDbTimestamp();
  const timestamp = toApiTimestamp(dbTimestamp);
  const content = buildGroupContent(files.length);

  try {
    const message = await withTransaction(async () => {
      const insert = await runAsync(
        `INSERT INTO messages (ip, device, content, file_url, file_type, message_type, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [ip, device, content, null, null, 'image_group', dbTimestamp]
      );

      const messageId = insert.lastID;
      const groupItems = [];

      for (const [index, file] of files.entries()) {
        const item = {
          message_id: messageId,
          sort_order: index,
          file_name: decodeOriginalName(file.originalname),
          file_url: `/uploads/${file.filename}`,
          file_type: file.mimetype
        };

        const itemInsert = await runAsync(
          `INSERT INTO message_group_items (message_id, sort_order, file_name, file_url, file_type)
           VALUES (?, ?, ?, ?, ?)`,
          [item.message_id, item.sort_order, item.file_name, item.file_url, item.file_type]
        );

        groupItems.push({
          id: itemInsert.lastID,
          ...item,
          file_size: file.size
        });
      }

      return {
        id: messageId,
        ip,
        device,
        content,
        file_url: null,
        file_type: null,
        file_size: null,
        message_type: 'image_group',
        timestamp,
        group_items: groupItems
      };
    });

    io.emit('chat message', message);
    res.json(message);
  } catch (error) {
    await removeStoredFiles(files);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/favorites', (req, res) => {
  getFavoriteRows(res);
});

app.post('/api/favorites', async (req, res) => {
  const sourceMessageId = Number.parseInt(req.body?.source_message_id, 10);
  const content = typeof req.body?.content === 'string' ? req.body.content : '';

  if (!Number.isInteger(sourceMessageId) || sourceMessageId <= 0) {
    return res.status(400).json({ error: 'Invalid source_message_id.' });
  }

  try {
    const row = await getAsync(
      `SELECT id, content, file_url, message_type
       FROM messages
       WHERE id = ?`,
      [sourceMessageId]
    );

    if (!row) {
      return res.status(404).json({ error: 'Source message not found.' });
    }

    if (resolveMessageType(row) !== 'text') {
      return res.status(400).json({ error: 'Only plain text messages can be favorited.' });
    }

    const favoriteContent = row.content || content;
    if (!favoriteContent.trim()) {
      return res.status(400).json({ error: 'Content is required.' });
    }

    const createdAt = toDbTimestamp();
    const insert = await runAsync(
      `INSERT INTO favorites (source_message_id, content, created_at) VALUES (?, ?, ?)`,
      [sourceMessageId, favoriteContent, createdAt]
    );

    const favorite = {
      id: insert.lastID,
      source_message_id: sourceMessageId,
      content: favoriteContent,
      created_at: toApiTimestamp(createdAt)
    };

    io.emit('favorites updated');
    res.status(201).json(favorite);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ error: 'Favorite already exists.' });
    }

    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/favorites/:id', (req, res) => {
  const favoriteId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(favoriteId) || favoriteId <= 0) {
    return res.status(400).json({ error: 'Invalid favorite id.' });
  }

  db.run(`DELETE FROM favorites WHERE id = ?`, [favoriteId], function onDelete(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Favorite not found.' });

    io.emit('favorites updated');
    res.json({ success: true });
  });
});

app.delete('/api/messages/:id', async (req, res) => {
  const messageId = parseInt(req.params.id, 10);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return res.status(400).json({ error: 'Invalid message id.' });
  }

  let filesToDelete = [];

  try {
    await withTransaction(async () => {
      const row = await getAsync(
        `SELECT id, file_url, message_type FROM messages WHERE id = ?`,
        [messageId]
      );
      if (!row) {
        const err = new Error('Message not found.');
        err.status = 404;
        throw err;
      }

      if (row.message_type === 'image_group') {
        const items = await allAsync(
          `SELECT file_url FROM message_group_items WHERE message_id = ?`,
          [messageId]
        );
        filesToDelete = items.map((it) => it.file_url).filter(Boolean);
      } else if (row.message_type === 'file' && row.file_url) {
        filesToDelete = [row.file_url];
      }

      await runAsync(`DELETE FROM message_group_items WHERE message_id = ?`, [messageId]);
      await runAsync(`DELETE FROM messages WHERE id = ?`, [messageId]);
    });

    io.emit('message deleted', { id: messageId });
    res.json({ success: true, id: messageId });

    filesToDelete.forEach((fileUrl) => {
      const basename = path.basename(fileUrl);
      const filePath = path.join(UPLOADS_DIR, basename);
      fs.remove(filePath).catch((err) => console.error('删除物理文件失败', filePath, err));
    });
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/history/clear', async (req, res) => {
  try {
    const result = await withTransaction(async () => {
      await runAsync(`DELETE FROM message_group_items`);
      return runAsync(`DELETE FROM messages`);
    });

    io.emit('history cleared');
    res.json({ success: true, deleted: result.changes || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/cleanup', async (req, res) => {
  try {
    await fs.emptyDir(UPLOADS_DIR);

    await withTransaction(async () => {
      await runAsync(
        `UPDATE messages
         SET file_url = NULL,
             file_type = NULL,
             content = ?,
             message_type = 'system'
         WHERE file_url IS NOT NULL OR message_type = 'image_group'`,
        [CLEANUP_PLACEHOLDER]
      );

      await runAsync(`DELETE FROM message_group_items`);
    });

    io.emit('system cleanup');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

io.on('connection', (socket) => {
  const ip = normalizeIp(socket.handshake.address);
  const device = resolveDevice(socket.handshake.auth?.device, socket.handshake.headers['user-agent']);

  socket.emit('whoami', { ip, device });

  getHistoryRows()
    .then((rows) => {
      socket.emit('history', rows);
    })
    .catch((error) => {
      console.error('Failed to load history', error);
    });

  socket.on('chat message', async (msgContent) => {
    if (typeof msgContent !== 'string' || !msgContent.trim()) return;

    const msgData = {
      ip,
      device,
      content: msgContent,
      file_url: null,
      file_type: null,
      message_type: 'text',
      group_items: []
    };

    const dbTimestamp = toDbTimestamp();

    try {
      const result = await runAsync(
        `INSERT INTO messages (ip, device, content, file_url, file_type, message_type, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [msgData.ip, msgData.device, msgData.content, msgData.file_url, msgData.file_type, msgData.message_type, dbTimestamp]
      );

      io.emit('chat message', {
        file_size: null,
        id: result.lastID,
        ...msgData,
        timestamp: toApiTimestamp(dbTimestamp)
      });
    } catch (error) {
      console.error('Failed to insert chat message', error);
    }
  });
});

initializeDatabase()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database', error);
    process.exit(1);
  });
