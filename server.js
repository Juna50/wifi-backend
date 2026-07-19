require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

// Safety net: log unexpected errors instead of letting Node silently kill
// the whole process on a transient DB hiccup (this is what was likely
// causing ERR_CONNECTION_CLOSED on requests that were otherwise fine).
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

const path = require('path');

const app = express();
app.use(cors()); // fine to leave open - only your router/portal call this API, nothing sensitive is exposed
app.use(express.json({ limit: '2mb' })); // raised from the 100kb default to fit base64 product images

const ordersRouter = require('./routes/orders');
const adminRouter = require('./routes/admin');
app.use('/api', ordersRouter);
app.use('/api', adminRouter);
app.use('/admin', express.static(path.join(__dirname, 'admin-panel')));

app.get('/', (req, res) => res.send('NETGHWiFi backend is running.'));
app.get('/healthz', (req, res) => res.status(200).json({ ok: true, ts: Date.now() })); // ping this to keep Render awake

const PORT = process.env.PORT || 3000;

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('MongoDB connected');
    app.listen(PORT, () => console.log(`NETGHWiFi backend listening on ${PORT}`));
  })
  .catch(err => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
