#!/usr/bin/env node

import { launch } from '../lib/launcher.js';

await launch(process.argv.slice(2));
