'use strict';

const express = require('express');

const {
  createOrderSchema,
  orderShape,
  orderUpdateSchema,
} = require('../schemas/order');

const router = express.Router();

// GET /orders
router.get('/', function listOrders(req, res) {
  res.json([orderShape]);
});

// GET /orders/:id
router.get('/:orderId', function getOrder(req, res) {
  res.json({ ...orderShape, id: req.params.orderId });
});

// POST /orders
router.post('/', function createOrder(req, res) {
  const { error } = createOrderSchema.validate(req.body);
  if (error) {
    return res
      .status(400)
      .json({ code: 'VALIDATION_ERROR', message: error.message });
  }
  const order = { ...orderShape, ...req.body, id: `ord_${Date.now()}` };
  res.status(201).json(order);
});

// PATCH /orders/:id
router.patch('/:orderId', function updateOrder(req, res) {
  const { error } = orderUpdateSchema.validate(req.body);
  if (error) {
    return res
      .status(400)
      .json({ code: 'VALIDATION_ERROR', message: error.message });
  }
  const order = { ...orderShape, ...req.body, id: req.params.orderId };
  res.json(order);
});

module.exports = router;
