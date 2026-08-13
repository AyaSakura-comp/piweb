#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  formatGptUsage,
  getGptUsage,
  type GptUsageData,
  type GptUsageOptions,
} from '../gpt-usage.js';

export interface GptUsageCliArgs {
  asJson: boolean;
  model: string;
}

export function parseGptUsageArgs(args: string[]): GptUsageCliArgs {
  let model = 'gpt-5.5';
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--model') continue;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--model requires a value');
    model = value;
    index += 1;
  }
  return { asJson: args.includes('--json'), model };
}

export function renderGptUsageResult(usage: GptUsageData, asJson: boolean): string {
  return asJson ? JSON.stringify(usage, null, 2) : formatGptUsage(usage);
}

export async function runGptUsageCli(
  args: string[],
  options: Omit<GptUsageOptions, 'model'> = {},
): Promise<string> {
  const parsed = parseGptUsageArgs(args);
  const usage = await getGptUsage({ ...options, model: parsed.model });
  return renderGptUsageResult(usage, parsed.asJson);
}

async function main(): Promise<void> {
  try {
    console.log(await runGptUsageCli(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entryPath === import.meta.url) void main();
