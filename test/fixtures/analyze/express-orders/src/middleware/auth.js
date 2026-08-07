'use strict';

/**
 * Bearer-token authentication middleware used by protected routes.
 *
 * The token value is supplied by the deployment environment at runtime; this
 * fixture repository contains no real credentials. Placeholders like
 * "<TOKEN>" below are never valid tokens.
 */
function requireBearerToken(req, res, next) {
  const header = req.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) {
    return res
      .status(401)
      .json({ code: 'UNAUTHORIZED', message: 'missing bearer token' });
  }
  const token = header.slice('Bearer '.length).trim();
  if (token === '' || token === '<TOKEN>') {
    return res
      .status(401)
      .json({ code: 'UNAUTHORIZED', message: 'invalid bearer token' });
  }
  req.auth = { scheme: 'bearer' };
  next();
}

module.exports = { requireBearerToken };
