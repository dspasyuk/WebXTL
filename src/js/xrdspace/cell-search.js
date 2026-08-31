// Copyright (c) 2026 Denis Spasyuk. MIT License.
// Unit-cell database search for xrdspace.
//
// Search the Crystallography Open Database (COD) and the RCSB Protein Data
// Bank (PDB) for structures whose unit cell matches a query cell. Matching is
// done in the Niggli-reduced cell so that different settings (axis
// permutations, unique-axis choices, obtuse/acute angle conventions) of the
// same lattice are recognised automatically.
//
//   - niggliReduce()      Krivy-Gruber 1976 Niggli cell reduction
//   - cellSettings()      distinct standard settings of a cell
//   - cellSimilarity()    reduced-cell match between two cells
//   - searchCodByCell()   search the Crystallography Open Database
//   - searchPdbByCell()   search the RCSB Protein Data Bank
//   - searchByCell()      both databases at once

import { det3 } from './op-math.js';
import { cellVolume } from './analyze.js';

const RAD = Math.PI / 180;

// --- metric tensor helpers ---

function metricTensor(cell) {
    const { a, b, c, alpha, beta, gamma } = cell;
    const ca = Math.cos(alpha * RAD), cb = Math.cos(beta * RAD), cg = Math.cos(gamma * RAD);
    // symmetric 3x3, stored as [G00,G11,G22,G01,G02,G12]
    // G00=a^2  G11=b^2  G22=c^2  G01=ab cos(gamma)  G02=ac cos(beta)  G12=bc cos(alpha)
    return [a * a, b * b, c * c, a * b * cg, a * c * cb, b * c * ca];
}

function cellFromMetric(G) {
    const a = Math.sqrt(Math.max(0, G[0]));
    const b = Math.sqrt(Math.max(0, G[1]));
    const c = Math.sqrt(Math.max(0, G[2]));
    const clamp = (x) => Math.max(-1, Math.min(1, x));
    const alpha = Math.acos(clamp(G[5] / (b * c || 1))) / RAD;
    const beta = Math.acos(clamp(G[4] / (a * c || 1))) / RAD;
    const gamma = Math.acos(clamp(G[3] / (a * b || 1))) / RAD;
    return { a, b, c, alpha, beta, gamma };
}

// --- Niggli reduction (Krivy-Gruber 1976, port of cctbx uctbx) ---

// Reduce a unit cell to its unique Niggli-reduced cell. Returns the reduced
// cell lengths/angles plus the Gruber parameters (A..F = squares and doubled
// metric products), or null when the iteration limit is exceeded.
export function niggliReduce(cell, { relativeEpsilon = 1e-5, iterationLimit = 1000 } = {}) {
    const G = metricTensor(cell);
    let a = G[0], b = G[1], c = G[2];
    let d = 2 * G[5];   // 2 b c cos(alpha)
    let e = 2 * G[4];   // 2 a c cos(beta)
    let f = 2 * G[3];   // 2 a b cos(gamma)

    const vol = cellVolume(cell);
    const eps = Math.pow(Math.max(vol, 1e-12), 1 / 3) * relativeEpsilon;
    const lt = (x, y) => x < y - eps;
    const gt = (x, y) => lt(y, x);
    const eq = (x, y) => !(lt(x, y) || lt(y, x));

    // sign analysis of (d,e,f): returns [n_zero, n_positive]
    const defTest = () => {
        let nZero = 0, nPos = 0;
        if (lt(0, d)) nPos++; else if (!lt(d, 0)) nZero++;
        if (lt(0, e)) nPos++; else if (!lt(e, 0)) nZero++;
        if (lt(0, f)) nPos++; else if (!lt(f, 0)) nZero++;
        return [nZero, nPos];
    };
    const defGt0 = () => {
        const [z, p] = defTest();
        return p === 3 || (z === 0 && p === 1);
    };

    let nIter = 0;
    let done = false;
    while (!done) {
        if (nIter >= iterationLimit) return null;
        nIter++;
        // A1: order a <= b (tie-break on |d| <= |e|)
        if (gt(a, b) || (eq(a, b) && gt(Math.abs(d), Math.abs(e)))) {
            const t = a; a = b; b = t;
            const u = d; d = e; e = u;
        }
        // A2: order b <= c (tie-break on |e| <= |f|)
        if (gt(b, c) || (eq(b, c) && gt(Math.abs(e), Math.abs(f)))) {
            const t = b; b = c; c = t;
            const u = e; e = f; f = u;
            continue;
        }
        // A3/A4: canonical signs of d,e,f
        if (defGt0()) {
            if (lt(d, 0)) d = -d;
            if (lt(e, 0)) e = -e;
            if (lt(f, 0)) f = -f;
        } else {
            d = -Math.abs(d);
            e = -Math.abs(e);
            f = -Math.abs(f);
        }
        // A5: reduce c against b
        if (gt(Math.abs(d), b) || (eq(d, b) && lt(e + e, f)) || (eq(d, -b) && lt(f, 0))) {
            if (d > 0) { c += b - d; d -= b + b; e -= f; }
            else { c += b + d; d += b + b; e += f; }
            continue;
        }
        // A6: reduce c against a
        if (gt(Math.abs(e), a) || (eq(e, a) && lt(d + d, f)) || (eq(e, -a) && lt(f, 0))) {
            if (e > 0) { c += a - e; d -= f; e -= a + a; }
            else { c += a + e; d += f; e += a + a; }
            continue;
        }
        // A7: reduce b against a
        if (gt(Math.abs(f), a) || (eq(f, a) && lt(d + d, e)) || (eq(f, -a) && lt(e, 0))) {
            if (f > 0) { b += a - f; d -= e; f -= a + a; }
            else { b += a + f; d += e; f += a + a; }
            continue;
        }
        // A8: the "obtuse all" completion step
        if (lt(d + e + f + a + b, 0)
            || (eq(d + e + f + a + b, 0) && gt(a + a + e + e + f, 0))) {
            c += a + b + d + e + f;
            d += b + b + f;
            e += a + a + f;
            continue;
        }
        done = true;
    }

    const r = cellFromMetric([a, b, c, f / 2, e / 2, d / 2]);
    return { ...r, A: a, B: b, C: c, D: d, E: e, F: f, iterations: nIter };
}

// --- standard settings of a cell ---

// All 48 signed permutation matrices (the cubic holohedry): these generate the
// standard crystallographic settings of a lattice (axis permutations, choice of
// handedness / unique axis, obtuse vs acute angle conventions).
function signedPermutationMatrices() {
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const out = [];
    for (const p of perms) {
        for (let s = 0; s < 8; s++) {
            const signs = [s & 1 ? -1 : 1, s & 2 ? -1 : 1, s & 4 ? -1 : 1];
            const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
            for (let i = 0; i < 3; i++) M[i][p[i]] = signs[i];
            if (Math.abs(det3(M)) === 1) out.push(M);
        }
    }
    return out;
}

// Apply a change-of-basis matrix M (rows = new basis vectors as integer
// combinations of the old ones) to a cell, returning the new cell parameters.
export function transformCell(cell, M) {
    const G = metricTensor(cell);
    // full symmetric product G' = M G M^T  (row-vector convention)
    const MM = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            MM[i][j] = M[i][0] * G[0] * M[j][0] + M[i][1] * G[1] * M[j][1] + M[i][2] * G[2] * M[j][2]
                + (M[i][0] * M[j][1] + M[i][1] * M[j][0]) * G[3]
                + (M[i][0] * M[j][2] + M[i][2] * M[j][0]) * G[4]
                + (M[i][1] * M[j][2] + M[i][2] * M[j][1]) * G[5];
        }
    }
    const Gp = [MM[0][0], MM[1][1], MM[2][2], MM[0][1], MM[0][2], MM[1][2]];
    return cellFromMetric(Gp);
}

// Enumerate the distinct standard settings of a cell (axis permutations and
// sign conventions). Each setting is a {a,b,c,alpha,beta,gamma} cell.
export function cellSettings(cell, { settingsLimit = 48 } = {}) {
    const seen = new Set();
    const out = [];
    const matrices = signedPermutationMatrices();
    for (const M of matrices) {
        const t = transformCell(cell, M);
        const key = [t.a, t.b, t.c, t.alpha, t.beta, t.gamma]
            .map(v => Math.round(v * 10000) / 10000).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
        if (out.length >= settingsLimit) break;
    }
    return out;
}

// --- cell similarity ---

// Compare two cells in the Niggli-reduced setting. Returns
//   { match, dLmaxPct, dAmaxDeg, reducedQuery, reducedCandidate }
// where match is 100 - (max relative length deviation in % + max angle
// deviation in degrees), i.e. 100 = identical lattice.
export function cellSimilarity(queryCell, candidateCell) {
    const q = niggliReduce(queryCell);
    const c = niggliReduce(candidateCell);
    if (!q || !c) {
        return { match: 0, dLmaxPct: Infinity, dAmaxDeg: Infinity, reducedQuery: q, reducedCandidate: c };
    }
    const Lq = [q.a, q.b, q.c], Lc = [c.a, c.b, c.c];
    const Aq = [q.alpha, q.beta, q.gamma], Ac = [c.alpha, c.beta, c.gamma];
    let dLmax = 0, dAmax = 0;
    for (let i = 0; i < 3; i++) {
        dLmax = Math.max(dLmax, Math.abs(Lq[i] - Lc[i]) / Lq[i]);
        dAmax = Math.max(dAmax, Math.abs(Aq[i] - Ac[i]));
    }
    const dLmaxPct = dLmax * 100;
    const dAmaxDeg = dAmax;
    const match = Math.max(0, Math.min(100, 100 - (dLmaxPct + dAmaxDeg)));
    return { match, dLmaxPct, dAmaxDeg, reducedQuery: q, reducedCandidate: c };
}

// Build per-setting search windows from the tolerance.
//   tolLen: relative length tolerance (fraction, default 0.01 = 1%)
//   tolAng: angle tolerance (degrees, default 1.5)
// Returns [{aMin,aMax,bMin,bMax,cMin,cMax,alphaMin,alphaMax,betaMin,betaMax,gammaMin,gammaMax}]
export function cellToleranceWindows(settings, { tolLen = 0.01, tolAng = 1.5 } = {}) {
    const clampAng = (x) => Math.max(0.01, Math.min(180 - 0.01, x));
    return settings.map(s => ({
        aMin: s.a * (1 - tolLen), aMax: s.a * (1 + tolLen),
        bMin: s.b * (1 - tolLen), bMax: s.b * (1 + tolLen),
        cMin: s.c * (1 - tolLen), cMax: s.c * (1 + tolLen),
        alphaMin: clampAng(s.alpha - tolAng), alphaMax: clampAng(s.alpha + tolAng),
        betaMin: clampAng(s.beta - tolAng), betaMax: clampAng(s.beta + tolAng),
        gammaMin: clampAng(s.gamma - tolAng), gammaMax: clampAng(s.gamma + tolAng),
    }));
}

// --- HTTP helpers ---

const COD_BASE = 'https://www.crystallography.net/cod';
const RCSB_SEARCH = 'https://search.rcsb.org/rcsbsearch/v2/query';
const RCSB_ENTRY = 'https://data.rcsb.org/rest/v1/core/entry';

async function httpJson(url, options = {}, timeoutMs = 60000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: ctrl.signal });
        if (res.status === 204) return null; // no content / empty result set
        if (!res.ok) {
            let detail = '';
            try { detail = (await res.text()).slice(0, 300); } catch (e) { /* ignore */ }
            throw new Error(`HTTP ${res.status} for ${url}${detail ? `: ${detail}` : ''}`);
        }
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

async function runConcurrent(items, concurrency, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            try { out[i] = { ok: true, value: await fn(items[i], i) }; }
            catch (e) { out[i] = { ok: false, error: e.message }; }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return out;
}

// --- COD search ---

// Search the Crystallography Open Database by unit cell. Returns a ranked list
// of matching entries. options: { tolLen, tolAng, limit }.
export async function searchCodByCell(queryCell, options = {}) {
    const tolLen = options.tolLen !== undefined ? options.tolLen : 0.01;
    const tolAng = options.tolAng !== undefined ? options.tolAng : 1.5;
    const limit = options.limit !== undefined ? options.limit : 20;
    const settings = cellSettings(queryCell);
    const windows = cellToleranceWindows(settings, { tolLen, tolAng });

    const url = (w) => `${COD_BASE}/result?format=json`
        + `&amin=${w.aMin}&amax=${w.aMax}`
        + `&bmin=${w.bMin}&bmax=${w.bMax}`
        + `&cmin=${w.cMin}&cmax=${w.cMax}`
        + `&alpmin=${w.alphaMin}&alpmax=${w.alphaMax}`
        + `&betmin=${w.betaMin}&betmax=${w.betaMax}`
        + `&gamin=${w.gammaMin}&gamax=${w.gammaMax}`;

    const raw = await runConcurrent(windows, 4, (w) => httpJson(url(w)));
    const byId = new Map();
    for (const r of raw) {
        if (!r.ok || !Array.isArray(r.value)) continue;
        for (const e of r.value) {
            const id = String(e.file);
            if (!byId.has(id)) byId.set(id, e);
        }
    }

    const results = [];
    for (const e of byId.values()) {
        const cell = {
            a: parseFloat(e.a), b: parseFloat(e.b), c: parseFloat(e.c),
            alpha: parseFloat(e.alpha), beta: parseFloat(e.beta), gamma: parseFloat(e.gamma),
        };
        if (![cell.a, cell.b, cell.c, cell.alpha, cell.beta, cell.gamma].every(Number.isFinite)) continue;
        const sim = cellSimilarity(queryCell, cell);
        results.push({
            database: 'COD',
            id: String(e.file),
            cell,
            esd: {
                a: parseFloat(e.siga) || null,
                b: parseFloat(e.sigb) || null,
                c: parseFloat(e.sigc) || null,
                alpha: parseFloat(e.sigalpha) || null,
                beta: parseFloat(e.sigbeta) || null,
                gamma: parseFloat(e.siggamma) || null,
            },
            spaceGroup: e.sgNumber ? { number: parseInt(e.sgNumber, 10), hm: e.sg || null } : null,
            formula: e.formula || null,
            chemname: e.chemname || null,
            mineral: e.mineral || null,
            title: e.title || null,
            authors: e.authors || null,
            journal: e.journal || null,
            year: e.year || null,
            doi: e.doi || null,
            match: sim.match,
            dLmaxPct: sim.dLmaxPct,
            dAmaxDeg: sim.dAmaxDeg,
        });
    }

    results.sort((x, y) => y.match - x.match || x.id.localeCompare(y.id));
    return { settings, results: results.slice(0, limit), total: results.length };
}

// --- PDB (RCSB) search ---

// Text-search node for a single attribute range.
function rangeNode(attribute, from, to) {
    return {
        type: 'terminal',
        service: 'text',
        parameters: { attribute, operator: 'range', value: { from, to } },
    };
}

function pdbSettingNode(w) {
    return {
        type: 'group',
        logical_operator: 'and',
        nodes: [
            rangeNode('cell.length_a', w.aMin, w.aMax),
            rangeNode('cell.length_b', w.bMin, w.bMax),
            rangeNode('cell.length_c', w.cMin, w.cMax),
            rangeNode('cell.angle_alpha', w.alphaMin, w.alphaMax),
            rangeNode('cell.angle_beta', w.betaMin, w.betaMax),
            rangeNode('cell.angle_gamma', w.gammaMin, w.gammaMax),
        ],
    };
}

// Search the RCSB Protein Data Bank by unit cell. Returns a ranked list of
// matching entries (experimental X-ray/NEM structures only). options:
// { tolLen, tolAng, limit, fetchCap }.
export async function searchPdbByCell(queryCell, options = {}) {
    const tolLen = options.tolLen !== undefined ? options.tolLen : 0.01;
    const tolAng = options.tolAng !== undefined ? options.tolAng : 1.5;
    const limit = options.limit !== undefined ? options.limit : 20;
    // Fetch a few more than requested so the reduced-cell ranking has room,
    // but cap the number of per-entry detail requests.
    const fetchCap = options.fetchCap !== undefined
        ? options.fetchCap
        : Math.max(limit, Math.min(100, limit * 4));
    const settings = cellSettings(queryCell);
    const windows = cellToleranceWindows(settings, { tolLen, tolAng });

    const body = {
        query: {
            type: 'group',
            logical_operator: 'or',
            nodes: windows.map(w => pdbSettingNode(w)),
        },
        return_type: 'entry',
        request_options: {
            paginate: { start: 0, rows: Math.min(fetchCap, 500) },
            results_content_type: ['experimental'],
        },
    };

    const search = await httpJson(RCSB_SEARCH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (search === null) {
        // RCSB returns 204 No Content when nothing matches.
        return { settings, results: [], total: 0 };
    }
    const ids = (search.result_set || []).map(r => r.identifier);
    const total = search.total_count != null ? search.total_count : ids.length;
    const wanted = ids.slice(0, fetchCap);

    const fetched = await runConcurrent(wanted, 6, (id) => httpJson(`${RCSB_ENTRY}/${id}`));
    const results = [];
    for (let i = 0; i < wanted.length; i++) {
        const r = fetched[i];
        if (!r.ok || !r.value) continue;
        const e = r.value;
        const cellObj = e.cell;
        if (!cellObj) continue;
        const cell = {
            a: cellObj.length_a, b: cellObj.length_b, c: cellObj.length_c,
            alpha: cellObj.angle_alpha, beta: cellObj.angle_beta, gamma: cellObj.angle_gamma,
        };
        if (![cell.a, cell.b, cell.c, cell.alpha, cell.beta, cell.gamma].every(Number.isFinite)) continue;
        const sim = cellSimilarity(queryCell, cell);
        const sym = e.symmetry || {};
        const exptl = Array.isArray(e.exptl) ? e.exptl : [];
        results.push({
            database: 'PDB',
            id: wanted[i],
            cell,
            esd: null, // PDB does not report esds on unit-cell parameters
            spaceGroup: sym.space_group_name_H_M
                ? { hm: sym.space_group_name_H_M, number: sym.Int_Tables_number || null }
                : null,
            title: (e.struct && e.struct.title) || null,
            method: exptl.length ? exptl[0].method : null,
            resolution: (e.rcsb_entry_info && e.rcsb_entry_info.resolution_combined) || null,
            match: sim.match,
            dLmaxPct: sim.dLmaxPct,
            dAmaxDeg: sim.dAmaxDeg,
        });
    }

    results.sort((x, y) => y.match - x.match || x.id.localeCompare(y.id));
    return { settings, results: results.slice(0, limit), total };
}

// --- combined search ---

// Search one or more databases by unit cell. options: { databases: ['COD','PDB'],
// tolLen, tolAng, limit, fetchCap }. Returns { queryCell, settings, results, total }.
export async function searchByCell(queryCell, options = {}) {
    const databases = options.databases || ['COD', 'PDB'];
    const tolLen = options.tolLen !== undefined ? options.tolLen : 0.01;
    const tolAng = options.tolAng !== undefined ? options.tolAng : 1.5;
    const limit = options.limit !== undefined ? options.limit : 20;

    const parts = [];
    const perDbLimit = Math.max(limit, Math.ceil(limit / databases.length));
    if (databases.includes('COD')) {
        parts.push(searchCodByCell(queryCell, { tolLen, tolAng, limit: perDbLimit, fetchCap: options.fetchCap }));
    }
    if (databases.includes('PDB')) {
        parts.push(searchPdbByCell(queryCell, { tolLen, tolAng, limit: perDbLimit, fetchCap: options.fetchCap }));
    }
    const settled = await Promise.allSettled(parts);

    const results = [];
    const errors = [];
    settled.forEach((s, i) => {
        if (s.status === 'fulfilled') results.push(...s.value.results);
        else errors.push(`${databases[i]}: ${s.reason && s.reason.message ? s.reason.message : s.reason}`);
    });

    results.sort((x, y) => y.match - x.match || (x.database + x.id).localeCompare(y.database + y.id));
    return {
        queryCell,
        databases: databases.filter(d => databases.includes(d)),
        settings: cellSettings(queryCell),
        results: results.slice(0, limit),
        total: results.length,
        errors,
    };
}
