#!/usr/bin/env node

import { Command, InvalidArgumentError } from 'commander';

import { DEFAULT_AUTH_MODE, parseAuthMode } from '../auth/binding';
import { envName, PACKAGE_NAME, PRODUCT_NAME, PRODUCT_VERSION } from '../shared/brand';
import { formatCliError, toExitCode } from '../shared/errors';
import { startServer } from './serve';

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidArgumentError(
      `expected an integer between 0 and 65535, got "${value}"`,
    );
  }
  return port;
}

function envOrDefault(name: string, fallback: string): string {
  return process.env[envName(name)] ?? fallback;
}

async function runServe(
  host: string,
  port: number,
  authModeValue: string | undefined,
): Promise<void> {
  const authMode = parseAuthMode(authModeValue);
  const running = await startServer({ host, port, authMode });
  console.log(
    `${PRODUCT_NAME} listening on http://${host}:${running.port} (auth mode: ${authMode})`,
  );
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      void running.close().then(() => resolve());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

const program = new Command();

program
  .name(PACKAGE_NAME)
  .description(`${PRODUCT_NAME} - a generic, multi-tenant MCP frontend for HTTP APIs`)
  .version(PRODUCT_VERSION);

program
  .command('serve')
  .description('Start the MCP Portico HTTP server (Phase 1: health endpoint only)')
  .option(
    '--host <host>',
    'interface to bind (default 127.0.0.1)',
    envOrDefault('HOST', '127.0.0.1'),
  )
  .option(
    '--port <port>',
    'port to bind (default 3000)',
    parsePort,
    Number(envOrDefault('PORT', '3000')),
  )
  .option(
    '--auth-mode <mode>',
    `Portico client auth mode (default ${DEFAULT_AUTH_MODE})`,
    envOrDefault('AUTH_MODE', DEFAULT_AUTH_MODE),
  )
  .action(async (options: { host: string; port: number; authMode: string }) => {
    try {
      await runServe(options.host, options.port, options.authMode);
    } catch (error) {
      console.error(formatCliError(error));
      process.exitCode = toExitCode(error);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(formatCliError(error));
  process.exitCode = toExitCode(error);
});
