import fs from 'node:fs';
import os from 'node:os';

import { describe, expect, it } from 'vitest';

import { runWeatherFulfillmentDemo } from '../../src/demo/weather-fulfillment';

describe('one-command weather fulfillment demo', () => {
  it('runs the complete MCP brief against deterministic local backends', async () => {
    const output: string[] = [];
    const before = new Set(
      fs
        .readdirSync(os.tmpdir())
        .filter((name) => name.startsWith('mcp-portico-demo-')),
    );
    const result = await runWeatherFulfillmentDemo({
      output: (line) => output.push(line),
    });
    const after = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith('mcp-portico-demo-'));

    expect(result.summary).toEqual({
      openOrders: 3,
      weatherExposedOrders: 2,
      exposedOrderValueUsd: 4080,
      exposedOrdersWithSubstituteInventory: 2,
    });
    expect(result.assessments.map((item) => [item.order.id, item.weatherRisk])).toEqual(
      [
        ['ORD-1001', 'elevated'],
        ['ORD-1002', 'normal'],
        ['ORD-1003', 'elevated'],
      ],
    );
    expect(result.assessments[0]?.substituteInventory[0]?.warehouseCity).toBe(
      'Newark, NJ',
    );
    expect(result.assessments[2]?.substituteInventory[0]?.warehouseCity).toBe(
      'Indianapolis, IN',
    );
    expect(result.joinedInsight).toContain('private fulfillment data');
    expect(output.join('\n')).toContain('Fulfillment risk summary');
    expect(output.join('\n')).toContain('Cleanup complete.');
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  }, 20_000);

  it('restores temporary environment state when setup validation fails', async () => {
    const originalPepper = process.env.MCP_PORTICO_KEY_PEPPER;
    const originalOrdersKey = process.env.ORDERS_MOCK_API_KEY;
    const originalInventoryToken = process.env.INVENTORY_MOCK_TOKEN;
    const output: string[] = [];

    await expect(
      runWeatherFulfillmentDemo({ maxOrders: 0, output: (line) => output.push(line) }),
    ).rejects.toThrow('maxOrders must be a positive integer');

    expect(process.env.MCP_PORTICO_KEY_PEPPER).toBe(originalPepper);
    expect(process.env.ORDERS_MOCK_API_KEY).toBe(originalOrdersKey);
    expect(process.env.INVENTORY_MOCK_TOKEN).toBe(originalInventoryToken);
    expect(output.at(-1)).toBe(
      'Cleanup complete. Temporary setup and local services removed.',
    );
  });

  it('answers selected questions without requiring an LLM', async () => {
    const output: string[] = [];
    const choices = ['1', '4', 'q'];
    const result = await runWeatherFulfillmentDemo({
      interactive: true,
      ask: async () => choices.shift() ?? 'q',
      output: (line) => output.push(line),
    });

    expect(result.summary.weatherExposedOrders).toBe(2);
    expect(output.join('\n')).toContain('ORD-1001 (New York, NY)');
    expect(output.join('\n')).toContain('Boston, MA: normal risk');
  }, 20_000);

  it('can route a natural-language question through an optional agent', async () => {
    const output: string[] = [];
    const choices = ['6', 'q'];
    const prompts: string[] = [];
    await runWeatherFulfillmentDemo({
      interactive: true,
      ask: async (prompt) => {
        if (prompt === 'Ask the AI agent: ') return 'Which order is most exposed?';
        return choices.shift() ?? 'q';
      },
      agent: async (prompt) => {
        prompts.push(prompt);
        return 'ORD-1003 is most exposed by order value.';
      },
      output: (line) => output.push(line),
    });

    expect(prompts).toEqual(['Which order is most exposed?']);
    expect(output.join('\n')).toContain('ORD-1003 is most exposed by order value.');
  }, 20_000);
});
