// Copyright (c) 2026 Denis Spasyuk. MIT License.
// Space-group analysis core for xrdspace.
// Implements an XPREP-style space-group determination:
//   1. unit-cell metric  -> crystal system
//   2. R(sym) merge      -> Laue class
//   3. reflection parity -> lattice centering (Bravais lattice)
//   4. systematic absences -> rank the candidate space groups

import { canonicalRep, isInvariant, phase, parseOperation, directToReciprocal, opsToReciprocalMatrices } from './op-math.js';
import { LAUE_BY_SYSTEM, LAUE_CRYSTAL_SYSTEM } from './laue.js';

// --- crystal system from unit cell ---

export function crystalSystemFromCell(cell, tolLen = 0.005, tolAng = 1.0) {
    const { a, b, c, alpha, beta, gamma } = cell;
    const eqLen = (x, y) => Math.abs(x - y) <= tolLen * Math.max(Math.abs(x), Math.abs(y));
    const is90 = (x) => Math.abs(x - 90) <= tolAng;
    const is120 = (x) => Math.abs(x - 120) <= tolAng;

    if (eqLen(a, b) && eqLen(b, c) && is90(alpha) && is90(beta) && is90(gamma)) {
        return { system: 'cubic', uniqueAxis: null };
    }
    if (eqLen(a, b) && is90(alpha) && is90(beta) && is90(gamma)) {
        return { system: 'tetragonal', uniqueAxis: null };
    }
    if (eqLen(a, b) && is90(alpha) && is90(beta) && is120(gamma)) {
        return { system: 'hexagonal', uniqueAxis: null };
    }
    if (eqLen(a, b) && eqLen(b, c) && Math.abs(alpha - beta) <= tolAng && Math.abs(beta - gamma) <= tolAng && !is90(alpha)) {
        return { system: 'trigonal', uniqueAxis: null }; // rhombohedral setting
    }
    // Orthorhombic: all angles 90. Pseudo-symmetric lengths (e.g. a ~ c) are
    // still orthorhombic once the stricter tetragonal/cubic tests failed.
    if (is90(alpha) && is90(beta) && is90(gamma)) {
        return { system: 'orthorhombic', uniqueAxis: null };
    }
    // monoclinic: exactly one angle differs from 90
    const not90 = [];
    if (!is90(alpha)) not90.push('a');
    if (!is90(beta)) not90.push('b');
    if (!is90(gamma)) not90.push('c');
    if (not90.length === 1) {
        return { system: 'monoclinic', uniqueAxis: not90[0] };
    }
    return { system: 'triclinic', uniqueAxis: null };
}

// --- R(sym) merge ---

// Compute R(sym) = sum|I - <I>| / sum I over orbits of the given reciprocal
// matrices. `maxReflections` limits the data used (strong reflections first).
export function computeRSym(reflections, matrices, maxReflections = 30000) {
    let list = reflections;
    let limit = reflections.length;
    if (maxReflections && reflections.length > maxReflections) {
        // Copy once, sort in place by |I|, and only use the strongest ones.
        list = reflections.slice();
        list.sort((a, b) => (Math.abs(b.I) || 0) - (Math.abs(a.I) || 0));
        limit = maxReflections;
    }
    const map = new Map();
    for (let i = 0; i < limit; i++) {
        const r = list[i];
        const { rep } = canonicalRep([r.h, r.k, r.l], matrices);
        const key = rep[0] + ',' + rep[1] + ',' + rep[2];
        let grp = map.get(key);
        if (!grp) { grp = []; map.set(key, grp); }
        grp.push(r.I);
    }
    let num = 0, den = 0;
    for (const vals of map.values()) {
        let sum = 0;
        for (const v of vals) sum += v;
        const mean = sum / vals.length;
        for (const v of vals) num += Math.abs(v - mean);
        den += sum;
    }
    return {
        R: den > 0 ? num / den : 0,
        nOrbits: map.size,
        nObs: limit,
    };
}

// Select the Laue class from R(sym). The unit-cell metric fixes the crystal
// system, which constrains the allowed Laue classes (e.g. a tetragonal cell
// cannot be mmm). Among the metric-compatible Laue classes we pick the
// highest-symmetry one whose R(sym) is close to the intrinsic merging R of the
// data (measured on -1). If none fit, fall back to a lower-symmetry class
// (pseudo-symmetry, wrongly indexed / guessed cells).
export function selectLaueClass(reflections, laueGroups, metricSystem) {
    const table = [];
    for (const lg of laueGroups) {
        // For 2/m try all three settings and take the best R.
        let best = { R: Infinity, ops: null };
        for (const s of lg.settings) {
            const r = computeRSym(reflections, s.ops);
            if (r.R < best.R) { best.R = r.R; best.ops = s.ops; best.nOrbits = r.nOrbits; }
        }
        table.push({ name: lg.name, order: lg.order, rsym: best.R, nOrbits: best.nOrbits, ops: best.ops });
    }

    const baseRow = table.find(t => t.name === '-1');
    const baseR = baseRow ? baseRow.rsym : 0;
    const cap = Math.max(0.07, 2.0 * baseR);

    const compatible = LAUE_BY_SYSTEM[metricSystem] || [];
    const orderedCompat = [];
    for (const n of compatible) {
        const row = table.find(t => t.name === n);
        if (row) orderedCompat.push(row);
    }
    orderedCompat.sort((a, b) => b.order - a.order);

    let chosen = null;
    // 1) metric-compatible Laue classes
    for (const row of orderedCompat) {
        if (row.rsym <= cap) { chosen = row.name; break; }
    }
    // 2) fall back to any Laue class (data demands lower symmetry)
    if (!chosen) {
        const orderedAll = laueGroups.slice().sort((a, b) => b.order - a.order);
        for (const lg of orderedAll) {
            const row = table.find(t => t.name === lg.name);
            if (row && row.rsym <= cap) { chosen = lg.name; break; }
        }
    }
    // 3) lowest R overall
    if (!chosen) chosen = table[0].name;

    const chosenRow = table.find(t => t.name === chosen);
    const tableOut = [];
    for (const t of table) {
        tableOut.push({ name: t.name, order: t.order, rsym: t.rsym, nOrbits: t.nOrbits, chosen: t.name === chosen });
    }
    return {
        name: chosen,
        rsym: chosenRow ? chosenRow.rsym : 0,
        order: chosenRow ? chosenRow.order : 0,
        ops: chosenRow ? chosenRow.ops : null,
        table: tableOut,
    };
}

// --- lattice centering ---

// Centering conditions. Each entry maps a reflection index to true when the
// reflection is allowed (i.e. not systematically absent due to centering).
const CENTERING = {
    P: (h, k, l) => true,
    C: (h, k, l) => (h + k) % 2 === 0,
    A: (h, k, l) => (k + l) % 2 === 0,
    B: (h, k, l) => (h + l) % 2 === 0,
    I: (h, k, l) => (h + k + l) % 2 === 0,
    F: (h, k, l) => (h % 2 === 0 && k % 2 === 0 && l % 2 === 0) || (h % 2 !== 0 && k % 2 !== 0 && l % 2 !== 0),
    R: (h, k, l) => ((-h + k + l) % 3 + 3) % 3 === 0,
};

// Restrictiveness: larger value = fewer reflections allowed = more restrictive.
const CENTERING_RANK = { P: 0, A: 3, B: 3, C: 3, I: 4, R: 5, F: 6 };

// Count "violations": reflections that are measured (I/sig above threshold) but
// forbidden by the centering condition. The correct centering has ~0. A
// centering is also rejected when its forbidden reflections are present-but-weak
// in large numbers (for the true centering they are simply absent from the data).
export function detectCentering(reflections, sigThreshold = 5) {
    const results = {};
    for (const [name, cond] of Object.entries(CENTERING)) {
        let violations = 0;
        let weak = 0;
        let checked = 0;
        let sumISig = 0;
        for (const r of reflections) {
            const allowed = cond(r.h, r.k, r.l);
            if (!allowed) {
                checked++;
                if (r.sig > 0) {
                    const isig = Math.abs(r.I) / r.sig;
                    if (isig > sigThreshold) violations++;
                    else if (isig > 0) weak++;
                } else {
                    // No sigma available (e.g. some COD files): any present
                    // forbidden reflection is evidence the centering is wrong.
                    violations++;
                }
            }
        }
        results[name] = {
            centering: name,
            violations,
            weak,
            checked,
            meanISig: checked ? sumISig / checked : 0,
        };
    }
    // Choose the most restrictive centering with no significant violations and
    // no meaningful weak-forbidden presence.
    const zero = [];
    for (const x of Object.values(results)) {
        if (x.violations === 0 && x.weak <= Math.max(5, 0.15 * x.checked)) zero.push(x);
    }
    const pool = zero.length ? zero : Object.values(results);
    pool.sort((a, b) => {
        const dr = CENTERING_RANK[b.centering] - CENTERING_RANK[a.centering];
        if (dr !== 0) return dr;
        return a.violations - b.violations || a.meanISig - b.meanISig;
    });
    return { centering: pool[0].centering, results };
}

// --- systematic absences ---

// Build the list of "conditional" ops for a space group: ops (R|t) with a
// non-lattice translation, which impose reflection conditions.
function conditionalOps(sg) {
    const out = [];
    for (const op of sg.s) {
        const parsed = parseOperation(op);
        if (!parsed) continue;
        const isLattice = parsed.t.every(v => Math.abs(v - Math.round(v)) < 1e-9);
        if (isLattice) continue; // centering translations handled separately
        out.push({
            M: directToReciprocal(parsed.R),
            t: parsed.t,
            opString: op,
        });
    }
    return out;
}

// Which coordinate axes (0=h,1=k,2=l) are invariant under reciprocal matrix M
// (i.e. the screw/glide acts on the other coordinates only). Used to enumerate
// the reflections that should be systematically absent.
function invariantAxes(M) {
    const e = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const axes = [];
    for (let i = 0; i < 3; i++) {
        if (isInvariant(M, e[i])) axes.push(i);
    }
    return axes;
}

// Score a space group against the observed reflections by checking its
// systematic-absence conditions op by op. An SG is consistent when no strong
// reflection violates a condition; among consistent SGs we prefer the one that
// confirms the most genuinely-observed absences (i.e. the most restrictive
// space group still compatible with the data).
export function scoreSpaceGroup(sg, reflections, sigThreshold = 5, maxReflections = 120000) {
    const conds = conditionalOps(sg);
    if (!conds.length) {
        return { violations: 0, confirmedOps: 0, confirmedAbsences: 0, nStrong: 0 };
    }
    const weakThreshold = 3;
    let nStrong = 0;
    const opResults = [];
    for (let i = 0; i < conds.length; i++) opResults.push({ violations: 0, weakAbsent: 0, allowed: 0, checked: 0 });

    const max = maxReflections ? Math.min(reflections.length, maxReflections) : reflections.length;
    // Index bounds of the data (for detecting reflections missing from it).
    let hmin = Infinity, hmax = -Infinity, kmin = Infinity, kmax = -Infinity, lmin = Infinity, lmax = -Infinity;
    const present = new Set();
    for (let i = 0; i < max; i++) {
        const r = reflections[i];
        const h = [r.h, r.k, r.l];
        if (Math.abs(r.h) > hmax) hmax = Math.abs(r.h);
        if (Math.abs(r.k) > kmax) kmax = Math.abs(r.k);
        if (Math.abs(r.l) > lmax) lmax = Math.abs(r.l);
        if (Math.abs(r.h) < hmin) hmin = Math.abs(r.h);
        if (Math.abs(r.k) < kmin) kmin = Math.abs(r.k);
        if (Math.abs(r.l) < lmin) lmin = Math.abs(r.l);
        present.add(r.h + ',' + r.k + ',' + r.l);
        const sig = r.sig > 0 ? Math.abs(r.I) / r.sig : 0;
        if (sig > sigThreshold) nStrong++;
        for (let c = 0; c < conds.length; c++) {
            if (!isInvariant(conds[c].M, h)) continue;
            opResults[c].checked++;
            if (Math.abs(phase(h, conds[c].t)) > 0.05) {
                // Forbidden reflection (should be systematically absent).
                if (sig > sigThreshold) opResults[c].violations++;
                else if (sig > 0 && sig <= weakThreshold) opResults[c].weakAbsent++;
            } else {
                opResults[c].allowed++;
            }
        }
    }

    // Count forbidden reflections that are absent from the dataset entirely.
    // This is typical of pre-merged data (e.g. COD), where systematically
    // absent reflections are simply not listed.
    for (let c = 0; c < conds.length; c++) {
        if (opResults[c].violations > 0) continue;
        const axes = invariantAxes(conds[c].M);
        let missing = 0;
        if (axes.length === 1) {
            const ax = axes[0];
            const bounds = [[hmin, hmax], [kmin, kmax], [lmin, lmax]][ax];
            for (let v = bounds[0]; v <= bounds[1]; v++) {
                const h = [0, 0, 0];
                h[ax] = v;
                if (v === 0) continue;
                if (Math.abs(phase(h, conds[c].t)) <= 0.05) continue; // allowed
                if (!present.has(h.join(','))) missing++;
            }
        } else if (axes.length === 2) {
            const a1 = axes[0], a2 = axes[1];
            const b1 = [[hmin, hmax], [kmin, kmax], [lmin, lmax]][a1];
            const b2 = [[hmin, hmax], [kmin, kmax], [lmin, lmax]][a2];
            for (let v1 = b1[0]; v1 <= b1[1]; v1++) {
                for (let v2 = b2[0]; v2 <= b2[1]; v2++) {
                    if (v1 === 0 && v2 === 0) continue;
                    const h = [0, 0, 0];
                    h[a1] = v1;
                    h[a2] = v2;
                    if (Math.abs(phase(h, conds[c].t)) <= 0.05) continue;
                    if (!present.has(h.join(','))) missing++;
                }
            }
        }
        opResults[c].missing = missing;
    }

    let violations = 0;
    let confirmedOps = 0;
    let confirmedAbsences = 0;
    for (const o of opResults) {
        violations += o.violations;
        // An op is confirmed when the data shows no significant violations, the
        // axial/planar series is actually measured (allowed reflections present),
        // and the forbidden reflections are either weak or absent from the data.
        const evidence = o.weakAbsent + (o.missing || 0);
        if (o.violations === 0 && o.allowed >= 1 && evidence >= 2) {
            confirmedOps++;
            confirmedAbsences += evidence;
        }
    }
    return { violations, confirmedOps, confirmedAbsences, nStrong };
}

// --- candidate enumeration ---

// Space group number ranges per crystal system. A hexagonal metric can host
// both trigonal (143-167, hexagonal setting) and hexagonal (168-194) groups.
const SYSTEM_RANGES = {
    triclinic: [1, 2],
    monoclinic: [3, 15],
    orthorhombic: [16, 74],
    tetragonal: [75, 142],
    trigonal: [143, 167],
    hexagonal: [143, 194],
    cubic: [195, 230],
};

export function enumerateCandidates(sgData, laueGroups, crystalSystem, centering) {
    const [lo, hi] = SYSTEM_RANGES[crystalSystem] || [1, 230];
    const map = new Map(); // id -> first entry
    for (const g of sgData) {
        if (g.id < lo || g.id > hi) continue;
        const c = (g.hm || ' ')[0].toUpperCase();
        if (c !== centering) continue;
        if (!map.has(g.id)) map.set(g.id, g);
    }
    const candidates = [];
    for (const g of map.values()) {
        // Re-check Laue class (matches the crystal system + tetragonal/trigonal
        // /hexagonal/cubic low-vs-high distinction).
        const lc = laueClassOfSg(g, laueGroups);
        candidates.push({ ...g, laue: lc });
    }
    return candidates;
}

// Laue class of a space group (computed from its ops + inversion closure).
// Laue class of a space group, determined robustly from its crystal system
// (space group number range) and point-group order (number of general positions
// divided by the lattice-centering multiplicity). This avoids failures caused by
// conjugate settings (e.g. P -3 1 m vs P -3 m 1) whose symmetry matrices differ.
export function laueClassOfSg(sg, laueGroups) {
    const cent = (sg.hm || ' ')[0].toUpperCase();
    const mult = { P: 1, A: 2, B: 2, C: 2, I: 2, F: 4, R: 3 }[cent] || 1;
    const pgOrder = Math.round((sg.s ? sg.s.length : 0) / mult);
    const laueOrder = isCentrosymmetric(sg) ? pgOrder : 2 * pgOrder;
    const id = sg.id;
    let system;
    if (id <= 2) system = 'triclinic';
    else if (id <= 15) system = 'monoclinic';
    else if (id <= 74) system = 'orthorhombic';
    else if (id <= 142) system = 'tetragonal';
    else if (id <= 167) system = 'trigonal';
    else if (id <= 194) system = 'hexagonal';
    else system = 'cubic';
    const map = {
        triclinic: { 2: '-1' },
        monoclinic: { 4: '2/m' },
        orthorhombic: { 8: 'mmm' },
        tetragonal: { 8: '4/m', 16: '4/mmm' },
        trigonal: { 6: '-3', 12: '-3m' },
        hexagonal: { 12: '6/m', 24: '6/mmm' },
        cubic: { 24: 'm-3', 48: 'm-3m' },
    };
    return (map[system] && map[system][laueOrder]) || null;
}

// --- intensity statistics (centrosymmetry) ---

// Wilson-style test using the mean of |E^2 - 1|, where E^2 = I / <I>.
// Centrosymmetric crystals give <|E^2 - 1|> ~ 0.968, acentric ~ 0.736.
// Returns { centric, acentric, score }.
export function estimateCentricity(reflections) {
    let sum = 0;
    for (const r of reflections) sum += Math.abs(r.I);
    const mean = sum / Math.max(1, reflections.length);
    if (mean <= 0) return { centric: false, acentric: false, score: 0 };
    let s = 0;
    for (const r of reflections) {
        const e2 = Math.abs(r.I) / mean;
        s += Math.abs(e2 - 1);
    }
    const score = s / reflections.length;
    return {
        centric: score > 0.85,
        acentric: score < 0.78,
        score,
    };
}

// Does a space group contain the inversion operator? Any op with R = -I
// (regardless of its translation — the inversion may sit at a non-origin point).
export function isCentrosymmetric(sg) {
    const mI = [[-1, 0, 0], [0, -1, 0], [0, 0, -1]];
    for (const op of sg.s) {
        const parsed = parseOperation(op);
        if (!parsed) continue;
        let match = true;
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                if (Math.abs(parsed.R[i][j] - mI[i][j]) > 1e-9) match = false;
            }
        }
        if (match) return true;
    }
    return false;
}

// --- main analysis ---

export function analyzeSpaceGroup(sgData, reflections, cell, options = {}) {
    const metric = crystalSystemFromCell(cell);
    const laueGroups = options.laueGroups; // built by caller via buildLaueGroups
    const laue = selectLaueClass(reflections, laueGroups, metric.system);
    const { centering, results: centeringResults } = detectCentering(reflections, options.sigThreshold || 5);

    // The crystal system normally comes from the unit-cell metric (reliable for
    // real cells). But if the data (Laue class) demands a LOWER symmetry than
    // the metric suggests (pseudo-symmetry, wrongly indexed / guessed cells),
    // the crystal system follows the Laue class instead.
    const laueCompatible = (LAUE_BY_SYSTEM[metric.system] || []).includes(laue.name);
    const crystalSystem = laueCompatible ? metric.system : (LAUE_CRYSTAL_SYSTEM[laue.name] || metric.system);

    // Enumerate candidates: crystal system + centering. The R-merge Laue class
    // is a strong hint, but on partial data it can under-detect higher symmetry
    // (e.g. -3 instead of -3m). We therefore score candidates from ALL
    // metric-compatible Laue classes and let the systematic absences pick the
    // right one; the selected Laue is used as a tie-breaker only.
    const compatibleLaues = LAUE_BY_SYSTEM[crystalSystem] || [];
    let candidates = enumerateCandidates(sgData, laueGroups, crystalSystem, centering);
    const kept = [];
    for (const c of candidates) {
        if (!c.laue || compatibleLaues.includes(c.laue)) kept.push(c);
    }
    candidates = kept;
    if (!candidates.length) {
        // Relax: just crystal system + centering.
        candidates = enumerateCandidates(sgData, laueGroups, crystalSystem, centering);
    }

    // Score candidates by systematic absences. Prefer fewest violations, then
    // the most confirmed absences (most restrictive compatible space group),
    // then the space group whose centrosymmetry matches the intensity data.
    const centricity = estimateCentricity(reflections);
    const useCentricity = centricity.centric || centricity.acentric;
    for (const c of candidates) {
        // Score every setting of this space group number (e.g. P 1 21/c 1 vs
        // P 1 21/n 1 vs P 1 21/a 1 are all No. 14) and keep the best.
        const settings = [];
        for (const g of sgData) if (g.id === c.id) settings.push(g);
        let bestSc = null;
        for (const s of settings.length ? settings : [c]) {
            const sc = scoreSpaceGroup(s, reflections, options.sigThreshold || 5);
            if (!bestSc || sc.violations < bestSc.violations ||
                (sc.violations === bestSc.violations && sc.confirmedOps > bestSc.confirmedOps)) {
                bestSc = sc;
            }
        }
        c.violations = bestSc.violations;
        c.confirmedOps = bestSc.confirmedOps;
        c.confirmedAbsences = bestSc.confirmedAbsences;
        c.centric = isCentrosymmetric(c);
        c.centricMatch = useCentricity ? (c.centric === centricity.centric) : 1;
        // Prefer candidates in the R-merge-selected Laue class on a tie.
        c.laueMatch = c.laue === laue.name ? 1 : 0;
    }
    candidates.sort((a, b) =>
        a.violations - b.violations ||
        b.confirmedOps - a.confirmedOps ||
        b.confirmedAbsences - a.confirmedAbsences ||
        b.laueMatch - a.laueMatch ||
        b.centricMatch - a.centricMatch ||
        a.id - b.id);

    const best = candidates.length ? candidates[0] : null;

    const candidatesOut = [];
    for (const c of candidates) {
        candidatesOut.push({
            id: c.id,
            hm: c.hm,
            hs: c.hs,
            laue: c.laue,
            centric: c.centric,
            violations: c.violations,
            confirmedOps: c.confirmedOps,
            confirmedAbsences: c.confirmedAbsences,
        });
    }

    return {
        cell,
        metric,
        crystalSystem,
        laue,
        centering,
        centricity,
        centeringResults,
        candidates: candidatesOut,
        best: best ? { id: best.id, hm: best.hm, hs: best.hs } : null,
    };
}
