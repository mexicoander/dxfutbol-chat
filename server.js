const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const webpush = require('web-push');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  maxHttpBufferSize: 10e6 // 10MB for audio/images
});

const cors = require('cors');
app.use(cors());
app.use(express.json({ limit: '10mb' }));
// Frontend served from Vercel - no static files needed here

// ── VAPID keys for Web Push ──────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || webpush.generateVAPIDKeys().publicKey;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || webpush.generateVAPIDKeys().privateKey;

// If no env vars, generate fresh keys and log them (save these!)
if (!process.env.VAPID_PUBLIC) {
  const keys = webpush.generateVAPIDKeys();
  console.log('\n⚠️  VAPID keys not set. Generating temporary keys:');
  console.log('VAPID_PUBLIC=', keys.publicKey);
  console.log('VAPID_PRIVATE=', keys.privateKey);
  console.log('Set these as environment variables for persistent push notifications\n');
  webpush.setVapidDetails('mailto:admin@dxfutbol.app', keys.publicKey, keys.privateKey);
} else {
  webpush.setVapidDetails('mailto:admin@dxfutbol.app', VAPID_PUBLIC, VAPID_PRIVATE);
}

// ── In-memory state ──────────────────────────────────────────
const users = {};        // uid -> {name, pubkey, socketId, pushSub, online, ts}
let adminPubKey  = null;
let adminSocket  = null;
let adminPushSub = null;
const messages = {};     // uid -> [{from, iv, ct, ts, type}] last 200
const MAX_HISTORY = 200;

function addMessage(uid, msg) {
  if (!messages[uid]) messages[uid] = [];
  messages[uid].push(msg);
  if (messages[uid].length > MAX_HISTORY) messages[uid].shift();
}

// ── Push notification helper ──────────────────────────────────
async function sendPush(subscription, payload) {
  if (!subscription) return;
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (e) {
    if (e.statusCode === 410) {
      // Subscription expired - clean up
      Object.entries(users).forEach(([uid, u]) => {
        if (u.pushSub === subscription) delete users[uid].pushSub;
      });
      if (adminPushSub === subscription) adminPushSub = null;
    }
  }
}

// ── REST: get VAPID public key ────────────────────────────────
app.get('/vapid-public-key', (req, res) => {
  const keys = webpush.generateVAPIDKeys ? null : null;
  res.json({ key: process.env.VAPID_PUBLIC || VAPID_PUBLIC });
});

// ── Socket.io ────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  // ── Admin connects ──────────────────────────────────────────
  socket.on('admin_connect', ({ pubkey, name }) => {
    adminPubKey = pubkey;
    adminSocket = socket;
    socket.join('admin_room');
    console.log('Admin connected');

    // Send current user list and their histories
    const userList = {};
    Object.entries(users).forEach(([uid, u]) => {
      userList[uid] = { name: u.name, pubkey: u.pubkey, online: !!u.socketId, ts: u.ts };
    });
    socket.emit('admin_ready', {
      users: userList,
      messages: messages
    });

    // Notify all users that admin is online (so they can connect)
    socket.broadcast.emit('admin_online', { pubkey });
  });

  // ── User connects ────────────────────────────────────────────
  socket.on('user_connect', ({ uid, name, pubkey }) => {
    users[uid] = {
      ...( users[uid] || {} ),
      name, pubkey,
      socketId: socket.id,
      online: true,
      ts: Date.now()
    };
    socket.join(uid);
    console.log('User connected:', name, uid);

    // Tell user if admin is online and their key
    socket.emit('user_ready', {
      adminPubKey,
      adminOnline: !!adminSocket,
      history: messages[uid] || []
    });

    // Tell admin about this user
    if (adminSocket) {
      adminSocket.emit('user_joined', {
        uid,
        name,
        pubkey,
        online: true,
        ts: users[uid].ts,
        history: messages[uid] || []
      });
    }
  });

  // ── Message: user → admin ─────────────────────────────────
  socket.on('msg_to_admin', ({ uid, msg }) => {
    addMessage(uid, { ...msg, from: uid });

    // Forward to admin socket
    if (adminSocket) {
      adminSocket.emit('msg_from_user', { uid, msg: { ...msg, from: uid } });
    }

    // Push notification to admin if not connected
    if (!adminSocket && adminPushSub) {
      const name = users[uid]?.name || 'Usuario';
      sendPush(adminPushSub, {
        title: `Mensaje de ${name}`,
        body: msg.type === 'audio' ? '🎤 Mensaje de voz' : msg.type === 'image' ? '📷 Imagen' : '💬 Mensaje nuevo',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { uid }
      });
    }

    // Update user last activity
    if (users[uid]) users[uid].ts = Date.now();
  });

  // ── Message: admin → user ─────────────────────────────────
  socket.on('msg_to_user', ({ uid, msg }) => {
    addMessage(uid, { ...msg, from: 'admin' });

    // Forward to user socket
    io.to(uid).emit('msg_from_admin', { msg: { ...msg, from: 'admin' } });

    // Push notification to user if offline
    const user = users[uid];
    if (user && !user.socketId && user.pushSub) {
      sendPush(user.pushSub, {
        title: 'Nuevo mensaje',
        body: msg.type === 'audio' ? '🎤 Mensaje de voz' : msg.type === 'image' ? '📷 Imagen' : '💬 Tienes un mensaje',
        icon: '/icon-192.png',
        badge: '/icon-192.png'
      });
    }
  });

  // ── Typing indicator ──────────────────────────────────────
  socket.on('typing', ({ uid, to, isTyping }) => {
    if (to === 'admin') {
      if (adminSocket) adminSocket.emit('user_typing', { uid, isTyping });
    } else {
      io.to(to).emit('admin_typing', { isTyping });
    }
  });

  // ── WebRTC signaling ──────────────────────────────────────
  socket.on('call_signal', ({ to, signal, from, callType }) => {
    if (to === 'admin') {
      if (adminSocket) adminSocket.emit('call_signal', { from, signal, callType });
    } else {
      io.to(to).emit('call_signal', { from, signal, callType });
    }
  });

  // ── Push subscription ─────────────────────────────────────
  socket.on('push_subscribe', ({ uid, subscription }) => {
    if (uid === 'admin') {
      adminPushSub = subscription;
    } else if (users[uid]) {
      users[uid].pushSub = subscription;
    }
    console.log('Push subscription saved for:', uid);
  });

  // ── Disconnect ────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (adminSocket && socket.id === adminSocket.id) {
      adminSocket = null;
      console.log('Admin disconnected');
      io.emit('admin_offline');
    }
    Object.entries(users).forEach(([uid, u]) => {
      if (u.socketId === socket.id) {
        users[uid].socketId = null;
        users[uid].online = false;
        if (adminSocket) adminSocket.emit('user_offline', { uid });
        console.log('User disconnected:', u.name);
      }
    });
  });

  // ── Delete chat (admin) ───────────────────────────────────
  socket.on('delete_chat', ({ uid }) => {
    if (socket.id !== adminSocket?.id) return;
    delete messages[uid];
    socket.emit('chat_deleted', { uid });
  });

  socket.on('delete_user', ({ uid }) => {
    if (socket.id !== adminSocket?.id) return;
    delete messages[uid];
    delete users[uid];
    socket.emit('user_deleted', { uid });
  });
});

// ── Status endpoint ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    app: 'dxFutbol Chat Server',
    users: Object.keys(users).length,
    uptime: Math.round(process.uptime()) + 's'
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✅ dxFutbol Chat server running on port ${PORT}`);
  console.log(`   Local: http://localhost:${PORT}\n`);
});
