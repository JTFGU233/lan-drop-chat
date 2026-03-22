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

// 确保目录存在
fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(DATA_DIR);

// 初始化 SQLite
const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT,
    content TEXT,
    file_url TEXT,
    file_type TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_message_id INTEGER,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_source_message_id ON favorites(source_message_id)`);
});

// Multer 配置：直接落盘，不使用内存缓冲
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: Infinity } // 取消单文件大小限制
});

app.use(express.static('public'));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json());

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

// API: 文件上传
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');
  
  const ip = req.ip.replace('::ffff:', '');
  const fileData = {
    ip: ip,
    content: `[文件] ${req.file.originalname}`,
    file_url: `/uploads/${req.file.filename}`,
    file_type: req.file.mimetype
  };

  db.run(
    `INSERT INTO messages (ip, content, file_url, file_type) VALUES (?, ?, ?, ?)`,
    [fileData.ip, fileData.content, fileData.file_url, fileData.file_type],
    function(err) {
      if (err) return res.status(500).send(err.message);
      const msg = { id: this.lastID, ...fileData, timestamp: new Date() };
      io.emit('chat message', msg);
      res.json(msg);
    }
  );
});

app.get('/api/favorites', (req, res) => {
  getFavoriteRows(res);
});

app.post('/api/favorites', (req, res) => {
  const sourceMessageId = Number.parseInt(req.body?.source_message_id, 10);
  const content = typeof req.body?.content === 'string' ? req.body.content : '';

  if (!Number.isInteger(sourceMessageId) || sourceMessageId <= 0) {
    return res.status(400).json({ error: 'Invalid source_message_id.' });
  }

  db.get(
    `SELECT id, content, file_url
     FROM messages
     WHERE id = ?`,
    [sourceMessageId],
    (lookupErr, row) => {
      if (lookupErr) return res.status(500).json({ error: lookupErr.message });
      if (!row) return res.status(404).json({ error: 'Source message not found.' });
      if (row.file_url || row.content === CLEANUP_PLACEHOLDER) {
        return res.status(400).json({ error: 'Only plain text messages can be favorited.' });
      }

      const favoriteContent = row.content || content;
      if (!favoriteContent.trim()) {
        return res.status(400).json({ error: 'Content is required.' });
      }

      db.run(
        `INSERT INTO favorites (source_message_id, content) VALUES (?, ?)`,
        [sourceMessageId, favoriteContent],
        function(insertErr) {
          if (insertErr) {
            if (insertErr.code === 'SQLITE_CONSTRAINT') {
              return res.status(409).json({ error: 'Favorite already exists.' });
            }

            return res.status(500).json({ error: insertErr.message });
          }

          const favorite = {
            id: this.lastID,
            source_message_id: sourceMessageId,
            content: favoriteContent,
            created_at: new Date().toISOString()
          };

          io.emit('favorites updated');
          res.status(201).json(favorite);
        }
      );
    }
  );
});

app.delete('/api/favorites/:id', (req, res) => {
  const favoriteId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(favoriteId) || favoriteId <= 0) {
    return res.status(400).json({ error: 'Invalid favorite id.' });
  }

  db.run(`DELETE FROM favorites WHERE id = ?`, [favoriteId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Favorite not found.' });

    io.emit('favorites updated');
    res.json({ success: true });
  });
});

app.post('/api/history/clear', (req, res) => {
  db.run(`DELETE FROM messages`, function(err) {
    if (err) return res.status(500).json({ error: err.message });

    io.emit('history cleared');
    res.json({ success: true, deleted: this.changes || 0 });
  });
});

// API: 清理物理文件
app.post('/api/cleanup', async (req, res) => {
  try {
    // 1. 物理层：清空 uploads 文件夹
    await fs.emptyDir(UPLOADS_DIR);

    // 2. 数据层：更新数据库记录
    db.run(
      `UPDATE messages SET file_url = NULL, content = ? WHERE file_url IS NOT NULL`,
      [CLEANUP_PLACEHOLDER],
      function(err) {
        if (err) throw err;
        // 3. UI 层：后端广播清理指令
        io.emit('system cleanup');
        res.json({ success: true });
      }
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Socket.io 事件处理
io.on('connection', (socket) => {
  const ip = socket.handshake.address.replace('::ffff:', '');
  
  // 新连接拉取历史记录
  db.all("SELECT * FROM messages ORDER BY timestamp ASC", (err, rows) => {
    if (!err) socket.emit('history', rows);
  });

  socket.on('chat message', (msgContent) => {
    const msgData = {
      ip: ip,
      content: msgContent,
      file_url: null,
      file_type: null
    };

    db.run(
      `INSERT INTO messages (ip, content, file_url, file_type) VALUES (?, ?, ?, ?)`,
      [msgData.ip, msgData.content, msgData.file_url, msgData.file_type],
      function(err) {
        if (!err) {
          io.emit('chat message', { id: this.lastID, ...msgData, timestamp: new Date() });
        }
      }
    );
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
