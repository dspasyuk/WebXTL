// Copyright (c) 2026 Denis Spasyuk. MIT License.
// Offline PDB unit-cell / space-group lookup for xrdspace.
//
// The full PDB is far too big (and too slow) to query on every run, so the
// unit-cell + space-group data of every PDB entry is pre-downloaded into a
// single JSON table (data/pdb-cells.json, built by scripts/build-pdb-table.js).
// This module loads that table and validates a determined space group against
// it without any network access:
//
//   - buildPdbLookupTable()   build a lookup table from raw rows
//   - loadPdbLookup()         load the JSON table (cached)
//   - searchPdbLookup()       entries whose Niggli-reduced cell matches
//   - validateSpaceGroupAgainstPdb()  verdict vs the table
//
// Matching is done in the Niggli-reduced cell so that different settings (axis
// permutations, unique-axis choices, obtuse/acute conventions) of the same
// lattice are recognised automatically — exactly like the COD/PDB cell search
// (cell-search.js). The table entries are pre-sorted by the reduced a-length so
// a query only scans a narrow length window.

import fs from 'node:fs';

import { niggliReduce } from './cell-search.js';

// Enantiomorphic space-group pairs: indistinguishable from the diffraction
// pattern alone (need anomalous scattering to tell apart). A determined space
// group whose enantiomorph appears in the PDB for the matching cell is reported
// as AMBIGUOUS rather than MISMATCH.
const ENANTIOMORPH = {
    76: 78, 78: 76,       // P 41 / P 43
    91: 95, 95: 91,       // P 41 22 / P 43 22
    92: 96, 96: 92,       // P 41 21 2 / P 43 21 2
    144: 145, 145: 144,   // P 31 / P 32
    151: 153, 153: 151,   // P 31 1 2 / P 32 1 2
    152: 154, 154: 152,   // P 31 2 1 / P 32 2 1
    169: 170, 170: 169,   // P 61 / P 65
    171: 172, 172: 171,   // P 62 / P 64
    178: 179, 179: 178,   // P 61 22 / P 65 22
    180: 181, 181: 180,   // P 62 22 / P 64 22
    212: 213, 213: 212,   // P 43 32 / P 41 32
};

function round1(v, dp) {
    const f = Math.pow(10, dp);
    return Math.round(v * f) / f;
}

// Round a cell to a compact storage array [a,b,c,alpha,beta,gamma].
function roundCell(cell, lenDp = 3, angDp = 2) {
    return [
        round1(cell.a, lenDp), round1(cell.b, lenDp), round1(cell.c, lenDp),
        round1(cell.alpha, angDp), round1(cell.beta, angDp), round1(cell.gamma, angDp),
    ];
}

function cellFromArray(arr) {
    return { a: arr[0], b: arr[1], c: arr[2], alpha: arr[3], beta: arr[4], gamma: arr[5] };
}

// Build the lookup-table entry list from raw rows
//   { id, cell: {a,b,c,alpha,beta,gamma} | [a,b,c,alpha,beta,gamma], sg, hm }
// Each entry stores the original cell and the Niggli-reduced cell (both rounded
// to a compact precision), and the list is sorted by the reduced a-length so a
// query can pre-filter with a binary search. Rows without a valid cell or a
// valid space-group number (1..230) are skipped.
export function buildPdbLookupTable(rows) {
    const entries = [];
    for (const r of rows) {
        const c = Array.isArray(r.cell) ? cellFromArray(r.cell) : r.cell;
        if (!c) continue;
        if (![c.a, c.b, c.c, c.alpha, c.beta, c.gamma].every(v => Number.isFinite(v) && v > 0)) continue;
        const sg = typeof r.sg === 'number' ? r.sg : parseInt(r.sg, 10);
        if (!Number.isFinite(sg) || sg < 1 || sg > 230) continue;
        const red = niggliReduce(c);
        if (!red) continue;
        entries.push({
            id: String(r.id),
            cell: roundCell(c),
            red: roundCell(red),
            sg,
            hm: r.hm || null,
        });
    }
    entries.sort((a, b) =>
        a.red[0] - b.red[0] || a.red[1] - b.red[1] || a.red[2] - b.red[2] || a.id.localeCompare(b.id));
    return entries;
}

// Load (and cache) a lookup table from its JSON file. The file is either a bare
// array of entries or an object with an `entries` array.
const lookupCache = new Map();
export function loadPdbLookup(filePath) {
    if (lookupCache.has(filePath)) return lookupCache.get(filePath);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const entries = Array.isArray(raw) ? raw : raw.entries;
    if (!Array.isArray(entries)) throw new Error('Invalid PDB lookup table (no entries array).');
    const table = { entries, meta: raw && !Array.isArray(raw) ? raw : { count: entries.length } };
    lookupCache.set(filePath, table);
    return table;
}

function lowerBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].red[0] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
}

function upperBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].red[0] <= x) lo = mid + 1; else hi = mid;
    }
    return lo;
}

// Entries whose Niggli-reduced cell matches `cell` within the tolerances.
//   tolLen: relative length tolerance (fraction, default 0.01 = 1%)
//   tolAng: angle tolerance (degrees, default 1.5)
// The reduced a-length pre-filter uses a binary search; b/c/angles are checked
// in the (usually small) surviving window.
export function searchPdbLookup(table, cell, { tolLen = 0.01, tolAng = 1.5, limit = 200 } = {}) {
    const entries = Array.isArray(table) ? table : table.entries;
    if (!Array.isArray(entries) || !entries.length) return [];
    const q = niggliReduce(cell);
    if (!q) return [];
    const aMin = q.a * (1 - tolLen);
    const aMax = q.a * (1 + tolLen);
    const lo = lowerBound(entries, aMin);
    const hi = upperBound(entries, aMax);
    const out = [];
    for (let i = lo; i < hi && out.length < limit; i++) {
        const e = entries[i];
        const r = e.red;
        if (Math.abs(q.b - r[1]) > tolLen * q.b) continue;
        if (Math.abs(q.c - r[2]) > tolLen * q.c) continue;
        if (Math.abs(q.alpha - r[3]) > tolAng) continue;
        if (Math.abs(q.beta - r[4]) > tolAng) continue;
        if (Math.abs(q.gamma - r[5]) > tolAng) continue;
        out.push(e);
    }
    return out;
}

// Validate a determined space group number `sgId` against the lookup table for
// the unit cell `cell`. Returns
//   { queryCell, reducedQuery, matches, total, sgNumbers, sgCounts,
//     determinedSg, enantiomorphOf, verdict }
// verdict: 'verified' | 'mismatch' | 'enantiomorph' | 'none'.
export function validateSpaceGroupAgainstPdb(table, cell, sgId, options = {}) {
    const tolLen = options.tolLen !== undefined ? options.tolLen : 0.01;
    const tolAng = options.tolAng !== undefined ? options.tolAng : 1.5;
    const matches = searchPdbLookup(table, cell, {
        tolLen, tolAng,
        limit: options.limit !== undefined ? options.limit : 200,
    });

    const sgNumbers = [...new Set(matches.map(m => m.sg))].sort((a, b) => a - b);
    const counts = new Map();
    for (const m of matches) counts.set(m.sg, (counts.get(m.sg) || 0) + 1);
    const sgCounts = [];
    for (const [sg, count] of counts) {
        const m = matches.find(x => x.sg === sg);
        sgCounts.push({ sg, hm: m ? m.hm : null, count });
    }
    sgCounts.sort((a, b) => b.count - a.count || a.sg - b.sg);

    let verdict;
    let enantiomorphOf = null;
    if (!matches.length) {
        verdict = 'none';
    } else if (sgNumbers.includes(sgId)) {
        verdict = 'verified';
    } else if (ENANTIOMORPH[sgId] && sgNumbers.includes(ENANTIOMORPH[sgId])) {
        verdict = 'enantiomorph';
        enantiomorphOf = ENANTIOMORPH[sgId];
    } else {
        verdict = 'mismatch';
    }

    return {
        queryCell: cell,
        reducedQuery: niggliReduce(cell),
        matches: matches.slice(0, options.reportLimit !== undefined ? options.reportLimit : 10),
        total: matches.length,
        sgNumbers,
        sgCounts,
        determinedSg: sgId,
        enantiomorphOf,
        verdict,
    };
}
