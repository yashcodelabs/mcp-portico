'use strict';

const express = require('express');

const router = express.Router();

// GET /health — public, no authentication.
router.get('/', function health(req, res) {
  res.json({ status: 'ok' });
});

module.exports = router;
