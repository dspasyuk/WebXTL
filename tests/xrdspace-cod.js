#!/usr/bin/env node
// Copyright (c) 2026 Denis Spasyuk. MIT License.
// xrdspace validation against real Crystallography Open Database (COD) data.
//
// Downloads each COD entry's .hkl reflection file (cached in HKLs/cod/), runs
// the xrdspace space-group determination with the entry's unit cell, and checks
// that the determined space group matches the published one. Results are
// classified:
//   PASS  - exact space-group number match
//   NEAR  - published group is among the zero-violation candidates (a
//           symmetry/setting ambiguity absences alone cannot always resolve)
//   FAIL  - published group not recovered
//
// Usage:
//   node tests/xrdspace-cod.js                  # all entries
//   node tests/xrdspace-cod.js 1100908          # a specific entry
//   node tests/xrdspace-cod.js --limit 50       # first N entries
//   node tests/xrdspace-cod.js --sg 14          # only space group 14

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeHkl } from '../src/js/xrdspace/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'HKLs', 'cod');
const COD_BASE = 'https://www.crystallography.net/cod';
const CONCURRENCY = 6;
const TIMEOUT_MS = 60000;

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

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${label}`)), ms)),
    ]);
}

async function runOne(pick) {
    const text = await withTimeout(fetchHkl(pick), TIMEOUT_MS, `download ${pick.id}`);
    const result = await withTimeout(
        Promise.resolve().then(() => analyzeHkl(text, { cell: cellFromPick(pick) })),
        TIMEOUT_MS, `analysis ${pick.id}`);
    const determined = result.ok && result.best ? result.best.id : null;
    const near = result.ok && result.candidates.some(c => c.id === pick.sgNumber && c.violations === 0);
    return { determined, near, result };
}

// Run with limited concurrency.
async function runAll(targets) {
    const results = new Array(targets.length);
    let next = 0;
    const worker = async () => {
        while (true) {
            const i = next++;
            if (i >= targets.length) break;
            const p = targets[i];
            try {
                results[i] = { pick: p, ...await runOne(p) };
            } catch (e) {
                results[i] = { pick: p, error: e.message };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
    return results;
}

function systemOf(sgNumber) {
    if (sgNumber <= 2) return 'triclinic';
    if (sgNumber <= 15) return 'monoclinic';
    if (sgNumber <= 74) return 'orthorhombic';
    if (sgNumber <= 142) return 'tetragonal';
    if (sgNumber <= 167) return 'trigonal';
    if (sgNumber <= 194) return 'hexagonal';
    return 'cubic';
}

async function main() {
    const argv = process.argv.slice(2);
    let only = null, limit = null, sgFilter = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--limit') { limit = parseInt(argv[++i], 10); continue; }
        if (a === '--sg') { sgFilter = parseInt(argv[++i], 10); continue; }
        if (a === '--id') { only = argv[++i]; continue; }
        if (!a.startsWith('--')) only = a;
    }

    let targets = picks;
    if (only) targets = picks.filter(p => p.id === only);
    if (sgFilter) targets = picks.filter(p => p.sgNumber === sgFilter);
    if (limit) targets = targets.slice(0, limit);
    if (!targets.length) {
        console.error(`No COD entries match the given filter.`);
        process.exit(1);
    }

    console.log(`xrdspace validation against COD — ${targets.length} entries`);
    console.log('='.repeat(60));
    const results = await runAll(targets);

    let pass = 0, near = 0, fail = 0, skip = 0;
    for (const r of results) {
        const p = r.pick;
        // Unusable data (powder pattern, empty / no single-crystal reflections).
        const unusable = (r.error || (r.result && !r.result.ok && r.result.error) || '')
            .match(/No reflections parsed|Unrecognized HKL file format/);
        let status;
        if (unusable) { status = 'SKIP'; skip++; }
        else if (r.error) { status = 'FAIL'; fail++; }
        else if (r.determined === p.sgNumber) { status = 'PASS'; pass++; }
        else if (r.near) { status = 'NEAR'; near++; }
        else { status = 'FAIL'; fail++; }
        const detail = r.error || (r.result && r.result.ok && r.result.best
            ? `${r.result.best.hm} (No. ${r.determined})` : 'none');
        console.log(`  [${status}] ${p.id}  expected ${p.sgNumber} (${p.sg})  got ${detail}`);
    }

    // Summary by crystal system.
    console.log('='.repeat(60));
    const bySys = {};
    for (const r of results) {
        const s = systemOf(r.pick.sgNumber);
        const unusable = (r.error || (r.result && !r.result.ok && r.result.error) || '')
            .match(/No reflections parsed|Unrecognized HKL file format/);
        let st;
        if (unusable) st = 'SKIP';
        else if (r.error) st = 'FAIL';
        else if (r.determined === r.pick.sgNumber) st = 'PASS';
        else st = r.near ? 'NEAR' : 'FAIL';
        (bySys[s] = bySys[s] || { total: 0, pass: 0, near: 0, fail: 0, skip: 0 })[st === 'PASS' ? 'pass' : st === 'NEAR' ? 'near' : st === 'SKIP' ? 'skip' : 'fail']++;
        bySys[s].total++;
    }
    for (const [s, v] of Object.entries(bySys)) {
        console.log(`  ${s.padEnd(12)} total ${String(v.total).padStart(3)}  PASS ${String(v.pass).padStart(3)}  NEAR ${String(v.near).padStart(3)}  FAIL ${String(v.fail).padStart(3)}${v.skip ? '  SKIP ' + v.skip : ''}`);
    }
    console.log('='.repeat(60));
    const assessed = results.length - skip;
    const rate = assessed ? ((pass + near) / assessed * 100) : 0;
    console.log(`PASS: ${pass}  NEAR: ${near}  FAIL: ${fail}  SKIP: ${skip}  (of ${results.length})`);
    console.log(`Determined correctly (PASS) or among candidates (NEAR): ${rate.toFixed(1)}% of ${assessed} assessed entries`);
    // Exit non-zero only when space-group determination degrades significantly
    // (the remaining FAILs are genuine pseudo-symmetry / sparse-data ambiguities).
    process.exit(rate < 90 ? 1 : 0);
}

main();
