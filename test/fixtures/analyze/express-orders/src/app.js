'use strict';

const express = require('express');

const authMiddleware = require('./middleware/auth');
const healthRouter = require('./routes/health');
const ordersRouter = require('./routes/orders');
const uploadsRouter = require('./routes/uploads');

const app = express();

app.use(express.json());

// Public routes.
app.use('/health', healthRouter);

// Protected routes: every request must carry a bearer token.
app.use('/orders', authMiddleware.requireBearerToken, ordersRouter);
app.use('/uploads', authMiddleware.requireBearerToken, uploadsRouter);

module.exports = app;
