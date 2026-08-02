import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  mcpPorticoConfigFile,
  mcpPorticoDataDir,
  mcpPorticoHome,
  mcpPorticoLogDir,
} from '../../src/shared/config';

const ORIGINAL_OVERRIDE = process.env.MCP_PORTICO_CONFIG_HOME;

afterEach(() => {
  if (ORIGINAL_OVERRIDE === undefined) {
    delete process.env.MCP_PORTICO_CONFIG_HOME;
  } else {
    process.env.MCP_PORTICO_CONFIG_HOME = ORIGINAL_OVERRIDE;
  }
});

describe('config home', () => {
  it('defaults to ~/.config/mcp-portico', () => {
    delete process.env.MCP_PORTICO_CONFIG_HOME;
    expect(mcpPorticoHome()).toBe(path.join(os.homedir(), '.config', 'mcp-portico'));
  });

  it('honors MCP_PORTICO_CONFIG_HOME', () => {
    process.env.MCP_PORTICO_CONFIG_HOME = path.join('C:', 'tmp', 'portico-home');
    expect(mcpPorticoHome()).toBe(path.join('C:', 'tmp', 'portico-home'));
  });

  it('derives config, data, and log paths from the home directory', () => {
    process.env.MCP_PORTICO_CONFIG_HOME = path.join('C:', 'tmp', 'portico-home');
    expect(mcpPorticoConfigFile()).toBe(
      path.join('C:', 'tmp', 'portico-home', 'config.json'),
    );
    expect(mcpPorticoDataDir()).toBe(path.join('C:', 'tmp', 'portico-home', 'data'));
    expect(mcpPorticoLogDir()).toBe(path.join('C:', 'tmp', 'portico-home', 'logs'));
  });
});
