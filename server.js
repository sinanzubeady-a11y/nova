const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt'); // مكتبة التشفير

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// الاتصال بقاعدة البيانات
const db = new sqlite3.Database('./nova.db', (err) => {
if (err) console.error('خطأ في قاعدة البيانات: ', err.message);
else console.log('تم الاتصال بقاعدة بيانات NOVA بنجاح.');
});

// بناء الجداول الجديدة
db.serialize(() => {
db.run(`CREATE TABLE IF NOT EXISTS users (
id INTEGER PRIMARY KEY AUTOINCREMENT,
username TEXT,
email TEXT UNIQUE,
password TEXT,
avatar TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS messages (
id INTEGER PRIMARY KEY AUTOINCREMENT,
sender_email TEXT,
receiver_email TEXT,
message TEXT,
type TEXT,
timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
is_read INTEGER DEFAULT 0
)`);
});

// لتتبع المستخدمين المتصلين: تخزين الـ socket.id لكل إيميل
const onlineUsers = {};

io.on('connection', (socket) => {
console.log('اتصال جديد:', socket.id);

// حدث خاص لتسجيل تواجد المستخدم فور فتحه للتطبيق أو تحديثه
socket.on('user_online', (email) => {
if (email) {
socket.userEmail = email;
onlineUsers[email] = socket.id;
broadcastUsers();
}
});

// 1. تسجيل حساب جديد (Sign Up)
socket.on('register', async (data, callback) => {
const { username, email, password } = data;
try {
const hashedPassword = await bcrypt.hash(password, 10);
const defaultAvatar = 'https://api.iconify.design/lucide:user-circle.svg?color=%233b82f6';

db.run(`INSERT INTO users (username, email, password, avatar) VALUES (?, ?, ?, ?)`,
[username, email, hashedPassword, defaultAvatar], function(err) {
if (err) {
callback({ success: false, message: 'البريد الإلكتروني مستخدم مسبقاً!' });
} else {
callback({ success: true, message: 'تم إنشاء الحساب بنجاح، يمكنك تسجيل الدخول الآن.' });
broadcastUsers();
}
});
} catch (error) {
callback({ success: false, message: 'حدث خطأ في الخادم' });
}
});

// 2. تسجيل الدخول (Login)
socket.on('login', (data, callback) => {
const { email, password } = data;
db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
if (!user) {
return callback({ success: false, message: 'البريد الإلكتروني غير مسجل.' });
}
const match = await bcrypt.compare(password, user.password);
if (match) {
socket.userEmail = user.email;
onlineUsers[user.email] = socket.id;

callback({ success: true, user: { username: user.username, email: user.email, avatar: user.avatar } });
broadcastUsers();
} else {
callback({ success: false, message: 'كلمة المرور غير صحيحة.' });
}
});
});

// 3. تحديث البيانات (تلقائي عند الدخول بالـ LocalStorage)
socket.on('auth_check', (email, callback) => {
db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, user) => {
if (user) {
socket.userEmail = user.email;
onlineUsers[user.email] = socket.id;
callback({ success: true, user: { username: user.username, email: user.email, avatar: user.avatar } });
broadcastUsers();
} else {
callback({ success: false });
}
});
});

// 4. جلب كل المستخدمين (لصفحة المستخدمين)
socket.on('get_all_users', (callback) => {
db.all(`SELECT username, email, avatar FROM users`, [], (err, rows) => {
const usersWithStatus = rows.map(u => ({
...u,
online: !!onlineUsers[u.email]
}));
callback(usersWithStatus);
});
});

// 5. جلب المحادثات السابقة (لصفحة المحادثات Inbox)
socket.on('get_inbox', (email, callback) => {
db.all(`SELECT * FROM messages WHERE sender_email = ? OR receiver_email = ? ORDER BY timestamp ASC`,
[email, email], (err, rows) => {
callback(rows || []);
});
});

// 6. إرسال رسالة
socket.on('send_message', (data, callback) => {
const { sender_email, receiver_email, message, type } = data;
const isOnline = !!onlineUsers[receiver_email];

db.run(`INSERT INTO messages (sender_email, receiver_email, message, type, is_read) VALUES (?, ?, ?, ?, ?)`,
[sender_email, receiver_email, message, type, 0], function(err) {
if (!err) {
const msgObj = {
id: this.lastID,
sender_email,
receiver_email,
message,
type,
timestamp: new Date().toISOString(),
is_read: 0
};

if (isOnline) {
io.to(onlineUsers[receiver_email]).emit('receive_message', msgObj);
}
if (callback) callback(msgObj);
}
});
});

// 7. تحديث حالة القراءة (✓✓)
socket.on('mark_as_read', ({ sender_email, receiver_email }) => {
db.run(`UPDATE messages SET is_read = 1 WHERE sender_email = ? AND receiver_email = ? AND is_read = 0`,
[receiver_email, sender_email], function() {
if (this.changes > 0 && onlineUsers[receiver_email]) {
io.to(onlineUsers[receiver_email]).emit('messages_read_by_user', { read_by: sender_email });
}
});
});

// 8. الانقطاع
socket.on('disconnect', () => {
if (socket.userEmail) {
// التأكد من أن الـ socket الحالي هو نفسه المسجل لكي لا نحذف حالة مستخدم فتح تبويب جديد
if (onlineUsers[socket.userEmail] === socket.id) {
delete onlineUsers[socket.userEmail];
broadcastUsers();
}
}
});
});

function broadcastUsers() {
io.emit('users_status_changed');
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
console.log(`NOVA Server Running on http://localhost:${PORT}`);
});
