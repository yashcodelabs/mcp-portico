import { describe, expect, it } from 'vitest';

import {
  BIN_NAME,
  CONFIG_HOME_DIR,
  ENV_PREFIX,
  HEADER_PREFIX,
  PACKAGE_NAME,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  SERVER_NAME,
  envName,
  headerName,
} from '../../src/shared/brand';

describe('brand identity', () => {
  it('uses the MCP Portico product identity', () => {
    expect(PRODUCT_NAME).toBe('MCP Portico');
    expect(PACKAGE_NAME).toBe('mcp-portico');
    expect(BIN_NAME).toBe('mcp-portico');
    expect(SERVER_NAME).toBe('mcp-portico');
    expect(PRODUCT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('uses the MCP_PORTICO_ environment prefix', () => {
    expect(ENV_PREFIX).toBe('MCP_PORTICO_');
    expect(envName('BASE_URL')).toBe('MCP_PORTICO_BASE_URL');
    expect(envName('AUTH_MODE')).toBe('MCP_PORTICO_AUTH_MODE');
  });

  it('uses the x-mcp-portico- header prefix', () => {
    expect(HEADER_PREFIX).toBe('x-mcp-portico-');
    expect(headerName('tenant')).toBe('x-mcp-portico-tenant');
  });

  it('uses ~/.config/mcp-portico as the config home name', () => {
    expect(CONFIG_HOME_DIR).toBe('mcp-portico');
  });
});
