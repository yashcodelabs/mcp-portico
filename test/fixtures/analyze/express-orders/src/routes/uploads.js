'use strict';

const express = require('express');
const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const router = express.Router();

// POST /uploads — multipart file upload, requires bearer auth.
router.post('/', upload.single('file'), function createUpload(req, res) {
  if (!req.file) {
    return res
      .status(400)
      .json({ code: 'MISSING_FILE', message: 'multipart field "file" is required' });
  }
  res.status(201).json({
    id: `up_${Date.now()}`,
    filename: req.file.originalname,
    bytes: req.file.size,
  });
});

module.exports = router;
