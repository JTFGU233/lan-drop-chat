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

const PORT = 3000;
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

function normalizeIp(value = '') {
  return String(value || '').replace('::ffff:', '');
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

function buildFileMessageFromUpload(ip, file) {
  return {
    ip,
    content: `[文件] ${file.originalname}`,
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
    message_type: resolveMessageType(row)
  }));

  const imageGroupIds = normalizedRows
    .filter((row) => row.message_type === 'image_group')
    .map((row) => row.id);

  const groupItemsByMessageId = await fetchGroupItemsByMessageIds(imageGroupIds);

  return normalizedRows.map((row) => ({
    ...row,
    group_items: groupItemsByMessageId.get(row.id) || []
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
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json());

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname);
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
      res.json(rows);
    }
  );
}

app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  const ip = normalizeIp(req.ip);
  const fileData = buildFileMessageFromUpload(ip, req.file);

  try {
    const result = await runAsync(
      `INSERT INTO messages (ip, content, file_url, file_type, message_type)
       VALUES (?, ?, ?, ?, ?)`,
      [fileData.ip, fileData.content, fileData.file_url, fileData.file_type, fileData.message_type]
    );

    const message = {
      id: result.lastID,
      ...fileData,
      timestamp: new Date().toISOString(),
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
  const timestamp = new Date().toISOString();
  const content = buildGroupContent(files.length);

  try {
    const message = await withTransaction(async () => {
      const insert = await runAsync(
        `INSERT INTO messages (ip, content, file_url, file_type, message_type)
         VALUES (?, ?, ?, ?, ?)`,
        [ip, content, null, null, 'image_group']
      );

      const messageId = insert.lastID;
      const groupItems = [];

      for (const [index, file] of files.entries()) {
        const item = {
          message_id: messageId,
          sort_order: index,
          file_name: file.originalname,
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
          ...item
        });
      }

      return {
        id: messageId,
        ip,
        content,
        file_url: null,
        file_type: null,
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

    const insert = await runAsync(
      `INSERT INTO favorites (source_message_id, content) VALUES (?, ?)`,
      [sourceMessageId, favoriteContent]
    );

    const favorite = {
      id: insert.lastID,
      source_message_id: sourceMessageId,
      content: favoriteContent,
      created_at: new Date().toISOString()
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

  getHistoryRows()
    .then((rows) => {
      socket.emit('history', rows);
    })
    .catch((error) => {
      console.error('Failed to load history', error);
    });

  socket.on('chat message', async (msgContent) => {
    const msgData = {
      ip,
      content: msgContent,
      file_url: null,
      file_type: null,
      message_type: 'text',
      group_items: []
    };

    try {
      const result = await runAsync(
        `INSERT INTO messages (ip, content, file_url, file_type, message_type)
         VALUES (?, ?, ?, ?, ?)`,
        [msgData.ip, msgData.content, msgData.file_url, msgData.file_type, msgData.message_type]
      );

      io.emit('chat message', {
        id: result.lastID,
        ...msgData,
        timestamp: new Date().toISOString()
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
