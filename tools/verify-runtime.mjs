#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const expectedNode = manifest.engines.node;
const actualNode = process.versions.node;
const expectedPnpm = manifest.engines.pnpm;
const userAgent = process.env.npm_config_user_agent ?? '';
const actualPnpm = userAgent.match(/pnpm\/([^\s]+)/)?.[1];

if (actualNode !== expectedNode) {
  console.error(`Node.js ${expectedNode} is required; current runtime is ${actualNode}.`);
  process.exitCode = 1;
}
if (actualPnpm !== expectedPnpm) {
  console.error(`pnpm ${expectedPnpm} is required; current package-manager agent is ${userAgent}.`);
  process.exitCode = 1;
}
if (process.exitCode === undefined) {
  console.log(`Verified Node.js ${actualNode} and pnpm ${actualPnpm}.`);
}
