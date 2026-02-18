const express = require('express');
const app = express();
const port = process.env.PORT || 8000;
const bodyParser = require('body-parser');
const cors = require('cors');
const cookieParser = require('cookie-parser'); // ADD THIS

// Middleware - ORDER IS IMPORTANT!
app.use(cors());
app.use(cookieParser()); // ADD THIS - Required for sessions
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Static files (if needed)
app.use('/public', express.static('public'));

// Routes
const pairRouter = require('./silamd');
app.use('/', pairRouter);

// Error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`🌐 http://localhost:${port}`);
    console.log(`👑 Admin panel: http://localhost:${port}/admin (PIN: bot0022)`);
});

module.exports = app;
