#!/usr/bin/env node

const { writeFileSync } = require('fs');
const { platform, arch } = process;
const file = 'turbo-cache-key.json';
const str = JSON.stringify({ platform, arch });
console.log(`Generating cache key: ${str}`);
writeFileSync(file, str);
