#!/usr/bin/env node

import { createClient } from '@hey-api/openapi-ts';

import configPromise from '../packages/platform-api-client/openapi-ts.config.mjs';

await createClient(await configPromise);
