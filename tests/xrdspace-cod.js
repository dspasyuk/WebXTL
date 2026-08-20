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
    const t0 = Date.now();
    let done = 0;
    const progress = () => {
        const el = ((Date.now() - t0) / 1000).toFixed(0);
        const pct = targets.length ? (done / targets.length * 100).toFixed(0) : 0;
        // Unbuffered write so progress is visible when stdout is piped to a file.
        fs.writeSync(1, `\r  ${done}/${targets.length} (${pct}%)  ${el}s elapsed`);
    };
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
            done++;
            if (done % 25 === 0 || done === targets.length) progress();
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
    fs.writeSync(1, '\n');
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

// Build an SVG bar chart of the PASS / NEAR / FAIL results per crystal system.
function buildSvgChart(bySys, totals) {
    const W = 900, H = 420, PL = 90, PR = 30, PT = 40, PB = 70;
    const colors = { PASS: '#2e9e4f', NEAR: '#e0a800', FAIL: '#d64545', SKIP: '#999' };
    const systems = ['triclinic', 'monoclinic', 'orthorhombic', 'tetragonal', 'trigonal', 'hexagonal', 'cubic'];
    const maxCount = Math.max(...systems.map(s => (bySys[s] ? bySys[s].total : 0)), 1);
    const innerW = W - PL - PR, innerH = H - PT - PB;
    const groupW = innerW / systems.length;
    const barW = groupW * 0.22;

    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">`);
    parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);
    parts.push(`<text x="${W/2}" y="24" text-anchor="middle" font-size="18" font-weight="bold" fill="#222">xrdspace space-group determination vs COD (${totals.total} structures)</text>`);

    // gridlines + y labels
    for (let g = 0; g <= 4; g++) {
        const v = maxCount * g / 4;
        const y = PT + innerH - innerH * g / 4;
        parts.push(`<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}" stroke="#e5e5e5" stroke-width="1"/>`);
        parts.push(`<text x="${PL-8}" y="${y+4}" text-anchor="end" font-size="11" fill="#666">${Math.round(v)}</text>`);
    }

    systems.forEach((sys, si) => {
        const b = bySys[sys] || { total: 0, pass: 0, near: 0, fail: 0, skip: 0 };
        const gx = PL + si * groupW + (groupW - 3 * barW) / 2;
        const cats = [
            ['PASS', b.pass],
            ['NEAR', b.near],
            ['FAIL', b.fail],
        ];
        cats.forEach(([label, val], ci) => {
            const h = val / maxCount * innerH;
            const x = gx + ci * (barW + 2);
            const y = PT + innerH - h;
            parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${colors[label]}" rx="2"/>`);
            if (val > 0) {
                parts.push(`<text x="${(x + barW/2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="#333" font-weight="bold">${val}</text>`);
            }
        });
        const label = sys.charAt(0).toUpperCase() + sys.slice(1);
        parts.push(`<text x="${(gx + groupW/2).toFixed(1)}" y="${H-PB+16}" text-anchor="middle" font-size="12" fill="#333">${label}</text>`);
        parts.push(`<text x="${(gx + groupW/2).toFixed(1)}" y="${H-PB+31}" text-anchor="middle" font-size="11" fill="#888">n=${b.total}</text>`);
    });

    // legend
    const lx = W/2 - 90, ly = H - 22;
    ['PASS', 'NEAR', 'FAIL'].forEach((label, i) => {
        const x = lx + i * 130;
        parts.push(`<rect x="${x}" y="${ly-10}" width="14" height="14" fill="${colors[label]}" rx="2"/>`);
        parts.push(`<text x="${x+20}" y="${ly+1}" font-size="12" fill="#333">${label}</text>`);
    });

    parts.push(`</svg>`);
    return parts.join('\n');
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

    // Persist a machine-readable report + an SVG summary chart.
    const report = { total: results.length, pass, near, fail, skip, rate: +rate.toFixed(1), bySystem: bySys };
    const reportPath = path.join(__dirname, 'xrdspace-report.json');
    const chartPath = path.join(__dirname, 'xrdspace-report.svg');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(chartPath, buildSvgChart(bySys, report));
    console.log(`Report: ${reportPath}`);
    console.log(`Chart:  ${chartPath}`);

    // Exit non-zero only when space-group determination degrades significantly
    // (the remaining FAILs are genuine pseudo-symmetry / sparse-data ambiguities).
    process.exit(rate < 90 ? 1 : 0);
}

main();
