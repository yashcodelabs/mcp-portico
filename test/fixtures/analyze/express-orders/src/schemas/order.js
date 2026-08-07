'use strict';

/**
 * Order DTO and validation shapes used by the orders routes. The analyzer
 * infers the Order response schema from this module.
 */

const orderShape = {
  id: 'ord_1',
  customerEmail: 'buyer@example.com',
  status: 'confirmed',
  totalCents: 2500,
  items: [{ productId: 'prod_9', quantity: 1 }],
};

const createOrderSchema = {
  validate(payload) {
    if (typeof payload !== 'object' || payload === null) {
      return { error: new Error('request body must be an object') };
    }
    if (typeof payload.customerEmail !== 'string') {
      return { error: new Error('customerEmail is required') };
    }
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      return { error: new Error('items must be a non-empty array') };
    }
    return { value: payload };
  },
};

const orderUpdateSchema = {
  validate(payload) {
    if (typeof payload !== 'object' || payload === null) {
      return { error: new Error('request body must be an object') };
    }
    return { value: payload };
  },
};

module.exports = { createOrderSchema, orderShape, orderUpdateSchema };
