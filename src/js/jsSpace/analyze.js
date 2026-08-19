// Space-group analysis core for jsSpace.
// Implements an XPREP-style space-group determination:
//   1. unit-cell metric  -> crystal system
//   2. R(sym) merge      -> Laue class
//   3. reflection parity -> lattice centering (Bravais lattice)
//   4. systematic absences -> rank the candidate space groups

import { canonicalRep, isInvariant, phase, parseOperation, directToReciprocal, opsToReciprocalMatrices } from './op-math.js';
import { LAUE_BY_SYSTEM, LAUE_CRYSTAL_SYSTEM } from './laue.js';

// --- crystal system from unit cell ---

export function crystalSystemFromCell(cell, tolLen = 0.03, tolAng = 3.0) {
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
    if (!eqLen(a, b) && !eqLen(a, c) && !eqLen(b, c) && is90(alpha) && is90(beta) && is90(gamma)) {
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
    if (maxReflections && reflections.length > maxReflections) {
        list = reflections
            .slice()
            .sort((a, b) => (Math.abs(b.I) || 0) - (Math.abs(a.I) || 0))
            .slice(0, maxReflections);
    }
    const map = new Map();
    for (const r of list) {
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
        nObs: list.length,
    };
}

// Select the Laue class from R(sym) over all eleven Laue groups. The R-merge
// reflects the true symmetry of the data (it acts on index triples only, so it
// is independent of the unit-cell metric). We pick the highest-symmetry Laue
// class whose R(sym) is still acceptable; the metric is used afterwards only as
// a cross-check.
export function selectLaueClass(reflections, laueGroups) {
    const table = laueGroups.map(lg => {
        // For 2/m try all three settings and take the best R.
        let best = { R: Infinity, ops: null };
        for (const s of lg.settings) {
            const r = computeRSym(reflections, s.ops);
            if (r.R < best.R) { best.R = r.R; best.ops = s.ops; best.nOrbits = r.nOrbits; }
        }
        return { name: lg.name, order: lg.order, rsym: best.R, nOrbits: best.nOrbits, ops: best.ops };
    });
    table.sort((a, b) => a.rsym - b.rsym);

    // Acceptance rule: a Laue class is acceptable when its R(sym) is close to
    // the intrinsic merging R of the data (measured on the -1 group, which only
    // merges Friedel pairs). We pick the highest-symmetry acceptable class.
    const baseRow = table.find(t => t.name === '-1');
    const baseR = baseRow ? baseRow.rsym : 0;
    const cap = Math.max(0.07, 2.0 * baseR);
    const ordered = laueGroups.slice().sort((a, b) => b.order - a.order);
    let chosen = null;
    for (const lg of ordered) {
        const row = table.find(t => t.name === lg.name);
        if (row && row.rsym <= cap) { chosen = lg.name; break; }
    }
    if (!chosen) chosen = table[0].name; // fall back to the lowest R

    const chosenRow = table.find(t => t.name === chosen);
    return {
        name: chosen,
        rsym: chosenRow ? chosenRow.rsym : 0,
        order: chosenRow ? chosenRow.order : 0,
        ops: chosenRow ? chosenRow.ops : null,
        table: table.map(t => ({ name: t.name, order: t.order, rsym: t.rsym, nOrbits: t.nOrbits, chosen: t.name === chosen })),
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
    R: (h, k, l) => ((h - k + l) % 3) === 0,
};

// Restrictiveness: larger value = fewer reflections allowed = more restrictive.
const CENTERING_RANK = { P: 0, A: 3, B: 3, C: 3, I: 4, R: 5, F: 6 };

// Count "violations": reflections that are measured (I/sig above threshold) but
// forbidden by the centering condition. The correct centering has ~0.
export function detectCentering(reflections, sigThreshold = 5) {
    const results = {};
    for (const [name, cond] of Object.entries(CENTERING)) {
        let violations = 0;
        let checked = 0;
        let sumISig = 0;
        for (const r of reflections) {
            const allowed = cond(r.h, r.k, r.l);
            if (!allowed) {
                checked++;
                if (r.sig > 0 && Math.abs(r.I) / r.sig > sigThreshold) {
                    violations++;
                    sumISig += Math.abs(r.I) / r.sig;
                }
            }
        }
        results[name] = {
            centering: name,
            violations,
            checked,
            meanISig: checked ? sumISig / checked : 0,
        };
    }
    // Choose the most restrictive centering with zero significant violations.
    const zero = Object.values(results).filter(x => x.violations === 0);
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
    const opResults = conds.map(() => ({ violations: 0, absent: 0, checked: 0 }));

    const max = maxReflections ? Math.min(reflections.length, maxReflections) : reflections.length;
    for (let i = 0; i < max; i++) {
        const r = reflections[i];
        const h = [r.h, r.k, r.l];
        const sig = r.sig > 0 ? Math.abs(r.I) / r.sig : 0;
        if (sig > sigThreshold) nStrong++;
        for (let c = 0; c < conds.length; c++) {
            if (!isInvariant(conds[c].M, h)) continue;
            opResults[c].checked++;
            if (Math.abs(phase(h, conds[c].t)) > 0.05) {
                if (sig > sigThreshold) opResults[c].violations++;
                else if (sig > 0 && sig <= weakThreshold) opResults[c].absent++;
            }
        }
    }

    let violations = 0;
    let confirmedOps = 0;
    let confirmedAbsences = 0;
    for (const o of opResults) {
        violations += o.violations;
        // An op is confirmed when the data shows no significant violations and
        // at least a few reflections actually follow its absence condition.
        if (o.violations === 0 && o.absent >= 2) {
            confirmedOps++;
            confirmedAbsences += o.absent;
        }
    }
    return { violations, confirmedOps, confirmedAbsences, nStrong };
}

// --- candidate enumeration ---

// Space group number ranges per crystal system.
const SYSTEM_RANGES = {
    triclinic: [1, 2],
    monoclinic: [3, 15],
    orthorhombic: [16, 74],
    tetragonal: [75, 142],
    trigonal: [143, 167],
    hexagonal: [168, 194],
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
export function laueClassOfSg(sg, laueGroups) {
    const set = new Set();
    const I = [[-1, 0, 0], [0, -1, 0], [0, 0, -1]];
    const ops = opsToReciprocalMatrices(sg.s);
    const key = (m) => m.map(row => row.map(v => Math.round(v * 1e6) / 1e6).join(',')).join('|');
    for (const { M } of ops) set.add(key(M));
    const mul = (a, b) => {
        const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
            out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
        return out;
    };
    for (const k of [...set]) {
        const m = k.split('|').map(row => row.split(',').map(parseFloat));
        set.add(key(mul(m, I)));
    }
    for (const lg of laueGroups) {
        if (lg.opsSet.size === set.size && [...set].every(k => lg.opsSet.has(k))) return lg.name;
    }
    return null;
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

// Does a space group contain the inversion operator?
export function isCentrosymmetric(sg) {
    const I = [[-1, 0, 0], [0, -1, 0], [0, 0, -1]];
    for (const op of sg.s) {
        const parsed = parseOperation(op);
        if (!parsed) continue;
        let match = true;
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                if (Math.abs(parsed.R[i][j] - I[i][j]) > 1e-9) match = false;
            }
        }
        if (match && parsed.t.every(v => Math.abs(v - Math.round(v)) < 1e-9)) return true;
    }
    return false;
}

// --- main analysis ---

export function analyzeSpaceGroup(sgData, reflections, cell, options = {}) {
    const metric = crystalSystemFromCell(cell);
    const laueGroups = options.laueGroups; // built by caller via buildLaueGroups
    const laue = selectLaueClass(reflections, laueGroups);
    const { centering, results: centeringResults } = detectCentering(reflections, options.sigThreshold || 5);

    // The crystal system is driven by the Laue class determined from the data
    // (R-merge), not by the unit-cell metric, which can be misleading (e.g.
    // pseudo-symmetry, incorrectly indexed data).
    const crystalSystem = LAUE_CRYSTAL_SYSTEM[laue.name] || metric.system;

    // Enumerate candidates: crystal system + centering + Laue class.
    let candidates = enumerateCandidates(sgData, laueGroups, crystalSystem, centering);
    candidates = candidates.filter(c => !c.laue || c.laue === laue.name);
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
        const sc = scoreSpaceGroup(c, reflections, options.sigThreshold || 5);
        c.violations = sc.violations;
        c.confirmedOps = sc.confirmedOps;
        c.confirmedAbsences = sc.confirmedAbsences;
        c.centric = isCentrosymmetric(c);
        c.centricMatch = useCentricity ? (c.centric === centricity.centric) : 1;
    }
    candidates.sort((a, b) =>
        a.violations - b.violations ||
        b.confirmedOps - a.confirmedOps ||
        b.confirmedAbsences - a.confirmedAbsences ||
        b.centricMatch - a.centricMatch ||
        a.id - b.id);

    const best = candidates.length ? candidates[0] : null;

    return {
        cell,
        metric,
        crystalSystem,
        laue,
        centering,
        centricity,
        centeringResults,
        candidates: candidates.map(c => ({
            id: c.id,
            hm: c.hm,
            hs: c.hs,
            laue: c.laue,
            centric: c.centric,
            violations: c.violations,
            confirmedOps: c.confirmedOps,
            confirmedAbsences: c.confirmedAbsences,
        })),
        best: best ? { id: best.id, hm: best.hm, hs: best.hs } : null,
    };
}
