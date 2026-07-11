require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors()); // fine to leave open - only your router/portal call this API, nothing sensitive is exposed
app.use(express.json());

const ordersRouter = require('./routes/orders');
app.use('/api', ordersRouter);

app.get('/', (req, res) => res.send('NETGHWiFi backend is running.'));

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
