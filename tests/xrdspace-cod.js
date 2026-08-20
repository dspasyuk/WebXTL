#!/usr/bin/env node
// Copyright (c) 2026 Denis Spasyuk. MIT License.
// xrdspace validation against real Crystallography Open Database (COD) data.
//
// Downloads each curated COD entry's .hkl reflection file (cached in
// HKLs/cod/), runs the xrdspace space-group determination with the entry's
// unit cell, and checks that the determined space group matches the
// published one.
//
// Usage:
//   node tests/xrdspace-cod.js            # all entries
//   node tests/xrdspace-cod.js 1100908    # a specific entry

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeHkl } from '../src/js/xrdspace/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'HKLs', 'cod');
const COD_BASE = 'https://www.crystallography.net/cod';

const picks = JSON.parse(fs.readFileSync(path.join(__dirname, 'cod-picks.json'), 'utf8'));

async function fetchHkl(pick) {
    const cache = path.join(CACHE_DIR, `${pick.id}.hkl`);
    if (fs.existsSync(cache)) return fs.readFileSync(cache, 'utf8');
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const res = await fetch(`${COD_BASE}/${pick.id}.hkl`);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${pick.id}`);
    const text = await res.text();
    fs.writeFileSync(cache, text, 'utf8');
    return text;
}

function cellFromPick(p) {
    const [a, b, c, alpha, beta, gamma] = p.cell;
    return { a, b, c, alpha, beta, gamma };
}

async function runOne(pick) {
    const text = await fetchHkl(pick);
    const result = analyzeHkl(text, { cell: cellFromPick(pick) });
    const determined = result.ok && result.best ? result.best.id : null;
    // Is the expected group among the zero-violation candidates?
    const near = result.ok && result.candidates.some(c => c.id === pick.sgNumber && c.violations === 0);
    return { determined, near, result };
}

async function main() {
    const args = process.argv.slice(2);
    const only = args[0];
    const targets = only ? picks.filter(p => p.id === only) : picks;
    if (!targets.length) {
        console.error(`No COD entry found for: ${only}`);
        process.exit(1);
    }

    let pass = 0, near = 0, fail = 0;
    console.log('xrdspace validation against COD');
    console.log('===============================');
    for (const p of targets) {
        try {
            const { determined, near: isNear, result } = await runOne(p);
            const expected = p.sgNumber;
            let status;
            if (determined === expected) { status = 'PASS'; pass++; }
            else if (isNear) { status = 'NEAR'; near++; }
            else { status = 'FAIL'; fail++; }
            const detail = result.ok && result.best
                ? `${result.best.hm} (No. ${determined})`
                : (result.error || 'error');
            console.log(`  [${status}] ${p.id}  expected ${expected} (${p.sg})  got ${detail}`);
        } catch (e) {
            fail++;
            console.log(`  [FAIL] ${p.id}  error: ${e.message}`);
        }
    }
    console.log('===============================');
    console.log(`PASS: ${pass}  NEAR: ${near}  FAIL: ${fail}  (of ${targets.length})`);
    process.exit(fail > 0 ? 1 : 0);
}

main();
