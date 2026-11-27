import express from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { createGroupAdminRouter } from './group-api.js';
import { createOpsRouter } from './ops-routes.js';

export const dashboardRouter = express.Router();

// Ensure JSON body parser is active for API router
dashboardRouter.use(express.json());

/**
 * Extracts and validates the operational token from request headers or query params.
 * @param {import('express').Request} req
 * @returns {string}
 */
function extractAuthToken(req) {
  const authHeader = req.headers['authorization'] || '';
  const apiKeyHeader = req.headers['x-api-key'] || '';

  if (authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  if (apiKeyHeader) {
    return String(apiKeyHeader).trim();
  }
  if (req.query && req.query.token) {
    return String(req.query.token).trim();
  }
  return '';
}

/**
 * Timing-safe Authentication Middleware for Dashboard API.
 * Validates OPS_TOKEN from Authorization header, x-api-key, or token query param.
 */
export function requireDashboardAuth(req, res, next) {
  const opsToken = config.OPS_TOKEN;
  const token = extractAuthToken(req);

  if (opsToken) {
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Missing or invalid Authorization header, x-api-key, or token query.',
      });
    }

    const expectedBuf = Buffer.from(opsToken, 'utf-8');
    const actualBuf = Buffer.from(token, 'utf-8');

    if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid operational token.',
      });
    }
    return next();
  }

  if (config.NODE_ENV === 'production') {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Dashboard operational endpoints require OPS_TOKEN in production.',
    });
  }

  return next();
}

// Apply authentication to all /dashboard/api routes except auth probe
dashboardRouter.use((req, res, next) => {
  if (req.path === '/auth/status') {
    return next();
  }
  return requireDashboardAuth(req, res, next);
});

// Auth status / probe endpoint
dashboardRouter.get('/auth/status', (req, res) => {
  const opsToken = config.OPS_TOKEN;
  const token = extractAuthToken(req);
  let hasValidToken = false;

  if (opsToken && token) {
    const expectedBuf = Buffer.from(opsToken, 'utf-8');
    const actualBuf = Buffer.from(token, 'utf-8');
    if (expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      hasValidToken = true;
    }
  } else if (!opsToken && config.NODE_ENV !== 'production') {
    hasValidToken = true;
  }

  res.status(200).json({
    success: true,
    authenticated: hasValidToken,
    requiresAuth: Boolean(opsToken) || config.NODE_ENV === 'production',
    env: config.NODE_ENV,
  });
});

// Group administrator API (inherits authentication middleware above)
dashboardRouter.use('/groups', createGroupAdminRouter());

// Core operational endpoints (overview, memory, knowledge, agents, jobs, models, security, settings, dlq, handoff, web-learn)
dashboardRouter.use('/', createOpsRouter());
