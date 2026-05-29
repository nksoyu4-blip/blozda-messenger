const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

['uploads', 'uploads/avatars', 'uploads/voice', 'uploads/files', 'uploads/groups'].forEach(d => {
  const p = path.join(__dirname, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let f = 'files';
    if (file.fieldname === 'avatar') f = 'avatars';
    else if (file.fieldname === 'voice') f = 'voice';
    else if (file.fieldname === 'group_avatar') f = 'groups';
    cb(null, path.join(__dirname, 'uploads', f));
  },
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

const users = new Map();
const messages = [];
const groups = new Map();
const friendRequests = [];
const JWT_SECRET = 'blozda-secret';

// ====== AUTH ======
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ error: 'Fill all fields' });
  if (users.has(username)) return res.json({ error: 'User exists' });
  const user = { id: uuidv4(), username, password: await bcrypt.hash(password, 10), avatar: null, status: 'offline', contacts: [], groups: [], socketId: null };
  users.set(username, user);
  const token = jwt.sign({ username, id: user.id }, JWT_SECRET);
  res.json({ token, user: { id: user.id, username, avatar: null } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users.get(username);
  if (!user || !(await bcrypt.compare(password, user.password))) return res.json({ error: 'Invalid credentials' });
  const token = jwt.sign({ username, id: user.id }, JWT_SECRET);
  res.json({ token, user: { id: user.id, username, avatar: user.avatar } });
});

app.get('/api/verify', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ error: 'No token' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    const u = users.get(d.username);
    if (!u) return res.json({ error: 'User not found' });
    res.json({ user: { id: u.id, username: u.username, avatar: u.avatar } });
  } catch { res.json({ error: 'Invalid token' }); }
});

// ====== UPLOADS ======
app.post('/api/avatar', upload.single('avatar'), (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ error: 'No token' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    const u = users.get(d.username);
    if (!u) return res.json({ error: 'Not found' });
    u.avatar = '/uploads/avatars/' + req.file.filename;
    res.json({ avatar: u.avatar });
  } catch { res.json({ error: 'Error' }); }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.json({ error: 'No file' });
  res.json({ url: '/uploads/files/' + req.file.filename, name: req.file.originalname, size: req.file.size, type: req.file.mimetype });
});

app.post('/api/voice', upload.single('voice'), (req, res) => {
  if (!req.file) return res.json({ error: 'No file' });
  res.json({ url: '/uploads/voice/' + req.file.filename, duration: req.body.duration || '0:00' });
});

// ====== FRIENDS ======
app.post('/api/friends/request', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ error: 'No token' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    const target = users.get(req.body.to);
    if (!target) return res.json({ error: 'User not found' });
    const exist = friendRequests.find(r => r.from === d.username && r.to === req.body.to && r.status === 'pending');
    if (exist) return res.json({ error: 'Already sent' });
    const reqq = { id: uuidv4(), from: d.username, to: req.body.to, status: 'pending', createdAt: new Date().toISOString() };
    friendRequests.push(reqq);
    if (target.socketId) io.to(target.socketId).emit('friendRequest', reqq);
    res.json({ success: true });
  } catch { res.json({ error: 'Error' }); }
});

app.post('/api/friends/accept', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ error: 'No token' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    const reqq = friendRequests.find(r => r.id === req.body.requestId);
    if (!reqq || reqq.to !== d.username) return res.json({ error: 'Not found' });
    reqq.status = 'accepted';
    const u1 = users.get(d.username), u2 = users.get(reqq.from);
    if (!u1.contacts.includes(reqq.from)) u1.contacts.push(reqq.from);
    if (!u2.contacts.includes(d.username)) u2.contacts.push(d.username);
    if (u2.socketId) io.to(u2.socketId).emit('friendAccepted', { username: d.username });
    res.json({ success: true });
  } catch { res.json({ error: 'Error' }); }
});

app.post('/api/friends/reject', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ error: 'No token' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    const reqq = friendRequests.find(r => r.id === req.body.requestId);
    if (reqq) reqq.status = 'rejected';
    res.json({ success: true });
  } catch { res.json({ error: 'Error' }); }
});

app.get('/api/friends/requests', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json([]);
  try {
    const d = jwt.verify(token, JWT_SECRET);
    const incoming = friendRequests.filter(r => r.to === d.username && r.status === 'pending');
    const outgoing = friendRequests.filter(r => r.from === d.username && r.status === 'pending');
    res.json({ incoming, outgoing });
  } catch { res.json([]); }
});

// ====== GROUPS ======
app.post('/api/groups', upload.single('group_avatar'), (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ error: 'No token' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    const { name, members } = req.body;
    const memberList = members ? JSON.parse(members) : [];
    const group = {
      id: uuidv4(),
      name,
      avatar: req.file ? '/uploads/groups/' + req.file.filename : null,
      creator: d.username,
      members: [d.username, ...memberList],
      createdAt: new Date().toISOString()
    };
    groups.set(group.id, group);
    const u = users.get(d.username);
    u.groups.push(group.id);
    memberList.forEach(m => {
      const mu = users.get(m);
      if (mu) mu.groups.push(group.id);
      if (mu && mu.socketId) io.to(mu.socketId).emit('groupCreated', group);
    });
    res.json(group);
  } catch { res.json({ error: 'Error' }); }
});

app.get('/api/groups', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json([]);
  try {
    const d = jwt.verify(token, JWT_SECRET);
    const u = users.get(d.username);
    const gs = u.groups.map(id => groups.get(id)).filter(Boolean);
    res.json(gs);
  } catch { res.json([]); }
});

app.get('/api/groups/:id/messages', (req, res) => {
  const msgs = messages.filter(m => m.to === req.params.id && m.isGroup).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  res.json(msgs);
});

// ====== CONTACTS ======
app.post('/api/contacts', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ error: 'No token' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    const u = users.get(d.username);
    const c = users.get(req.body.contactUsername);
    if (!c) return res.json({ error: 'Not found' });
    if (!u.contacts.includes(req.body.contactUsername)) u.contacts.push(req.body.contactUsername);
    res.json({ success: true });
  } catch { res.json({ error: 'Error' }); }
});

app.get('/api/contacts', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json([]);
  try {
    const d = jwt.verify(token, JWT_SECRET);
    const u = users.get(d.username);
    res.json(u.contacts.map(cn => { const c = users.get(cn); return c ? { username: c.username, avatar: c.avatar, status: c.status } : null; }).filter(Boolean));
  } catch { res.json([]); }
});

app.get('/api/users/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const r = [];
  users.forEach(u => { if (u.username.toLowerCase().includes(q)) r.push({ username: u.username, avatar: u.avatar, status: u.status }); });
  res.json(r);
});

app.get('/api/messages/:username', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json([]);
  try {
    const d = jwt.verify(token, JWT_SECRET);
    const msgs = messages.filter(m => !m.isGroup && ((m.from === d.username && m.to === req.params.username) || (m.from === req.params.username && m.to === d.username))).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json(msgs);
  } catch { res.json([]); }
});

// ====== SOCKET.IO ======
io.on('connection', (socket) => {
  socket.on('authenticate', ({ token }) => {
    try {
      const d = jwt.verify(token, JWT_SECRET);
      const u = users.get(d.username);
      if (!u) return;
      socket.userId = u.id;
      socket.username = u.username;
      u.status = 'online';
      u.socketId = socket.id;
      socket.join(u.id);
      u.groups.forEach(gid => socket.join('group:' + gid));
      io.emit('userStatus', { username: u.username, status: 'online' });
    } catch { }
  });

  socket.on('sendMessage', (data) => {
    if (!socket.username) return;
    const msg = { id: uuidv4(), from: socket.username, to: data.to, message: data.message, type: data.type || 'text', fileData: data.fileData || null, timestamp: new Date().toISOString(), read: false, isGroup: data.isGroup || false };
    messages.push(msg);
    if (data.isGroup) {
      socket.to('group:' + data.to).emit('newMessage', msg);
    } else {
      const toU = users.get(data.to);
      if (toU && toU.socketId) io.to(toU.socketId).emit('newMessage', msg);
    }
    socket.emit('messageSent', msg);
  });

  socket.on('markAsRead', ({ from }) => {
    messages.forEach(m => { if (m.from === from && m.to === socket.username && !m.read) m.read = true; });
    const fu = users.get(from);
    if (fu && fu.socketId) io.to(fu.socketId).emit('messagesRead', { by: socket.username });
  });

  socket.on('typing', ({ to }) => {
    const tu = users.get(to);
    if (tu && tu.socketId) io.to(tu.socketId).emit('userTyping', { from: socket.username });
  });

  socket.on('stopTyping', ({ to }) => {
    const tu = users.get(to);
    if (tu && tu.socketId) io.to(tu.socketId).emit('userStoppedTyping', { from: socket.username });
  });

  // CALLS
  socket.on('callOffer', ({ to, offer }) => {
    const tu = users.get(to);
    if (tu && tu.socketId) io.to(tu.socketId).emit('callOffer', { from: socket.username, offer });
  });
  socket.on('callAnswer', ({ to, answer }) => {
    const tu = users.get(to);
    if (tu && tu.socketId) io.to(tu.socketId).emit('callAnswer', { answer });
  });
  socket.on('callCandidate', ({ to, candidate }) => {
    const tu = users.get(to);
    if (tu && tu.socketId) io.to(tu.socketId).emit('callCandidate', { candidate });
  });
  socket.on('callEnd', ({ to }) => {
    const tu = users.get(to);
    if (tu && tu.socketId) io.to(tu.socketId).emit('callEnd');
  });

  socket.on('disconnect', () => {
    if (!socket.username) return;
    const u = users.get(socket.username);
    if (u) { u.status = 'offline'; u.socketId = null; io.emit('userStatus', { username: socket.username, status: 'offline' }); }
  });
});

server.listen(3000, () => console.log('http://localhost:3000'));