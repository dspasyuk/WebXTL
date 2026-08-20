// Copyright (c) 2026 Denis Spasyuk. MIT License.
// Reflection merging and output generation for xrdspace.
//
// Produces a symmetry-corrected, merged HKL dataset in the SHELX five-column
// format (H K L I SIG(I)) that can be fed directly into SHELXD / SHELXT /
// SHELXS, plus a merged XDS_ASCII file, and a merging report.

import { canonicalRep } from './op-math.js';

// Reciprocal-space metrics for a unit cell (standard crystallographic math).
export function reciprocalCell(cell) {
    const rad = (x) => x * Math.PI / 180;
    const a = cell.a, b = cell.b, c = cell.c;
    const ca = Math.cos(rad(cell.alpha)), cb = Math.cos(rad(cell.beta)), cg = Math.cos(rad(cell.gamma));
    const sa = Math.sin(rad(cell.alpha)), sb = Math.sin(rad(cell.beta)), sg = Math.sin(rad(cell.gamma));
    const V = a * b * c * Math.sqrt(1 - ca * ca - cb * cb - cg * cg + 2 * ca * cb * cg);
    if (!(V > 0)) return null;
    const aS = b * c * sa / V;
    const bS = a * c * sb / V;
    const cS = a * b * sg / V;
    const cosA = (cb * cg - ca) / (sb * sg);
    const cosB = (ca * cg - cb) / (sa * sg);
    const cosG = (ca * cb - cg) / (sa * sb);
    return { aS, bS, cS, cosA, cosB, cosG };
}

// d-spacing (Angstrom) of reflection hkl for a unit cell.
export function dSpacing(h, k, l, cell) {
    const r = reciprocalCell(cell);
    if (!r) return NaN;
    const h2 = h * h * r.aS * r.aS + k * k * r.bS * r.bS + l * l * r.cS * r.cS
        + 2 * h * k * r.aS * r.bS * r.cosG
        + 2 * h * l * r.aS * r.cS * r.cosB
        + 2 * k * l * r.bS * r.cS * r.cosA;
    if (h2 <= 0) return NaN;
    return 1 / Math.sqrt(h2);
}

/**
 * Merge reflections under a Laue group (matrices acting on hkl).
 * Returns { merged: [{h,k,l,I,sig,multiplicity}], nObs, nUnique, meanMultiplicity }.
 * Weighted mean intensities (1/sigma^2 weights).
 */
export function mergeReflections(reflections, matrices, cell, options = {}) {
    const map = new Map();
    for (const r of reflections) {
        const { rep } = canonicalRep([r.h, r.k, r.l], matrices);
        const key = rep[0] + ',' + rep[1] + ',' + rep[2];
        let arr = map.get(key);
        if (!arr) { arr = []; map.set(key, arr); }
        arr.push({ I: r.I, sig: r.sig });
    }
    const merged = [];
    for (const [key, arr] of map) {
        const c1 = key.indexOf(',');
        const c2 = key.indexOf(',', c1 + 1);
        const h = parseInt(key.slice(0, c1), 10);
        const k = parseInt(key.slice(c1 + 1, c2), 10);
        const l = parseInt(key.slice(c2 + 1), 10);
        // Weighted mean intensity (1/sigma^2 weights).
        let wsum = 0, w = 0, n = arr.length, msum = 0;
        for (const o of arr) {
            if (o.sig > 0) { const wi = 1 / (o.sig * o.sig); wsum += o.I * wi; w += wi; }
            else { wsum += o.I; w += 1; }
            msum += o.I;
        }
        const I = w > 0 ? wsum / w : msum / n;
        // Combined sigma: weighted-mean sigma plus the sample scatter term
        // (standard error of the mean), so inconsistent observations inflate
        // the merged sigma (combines the weighted-mean error with the scatter).
        let sem2 = 0;
        if (n > 1) {
            const mean = msum / n;
            for (const o of arr) sem2 += (o.I - mean) * (o.I - mean);
            sem2 /= (n * (n - 1));
        }
        const sig = Math.sqrt((w > 0 ? 1 / w : 0) + sem2);
        merged.push({
            h, k, l,
            I,
            sig: Number.isFinite(sig) ? sig : 0,
            multiplicity: arr.length,
        });
    }
    // Sort by |l|, |k|, |h| ascending (SHELX-friendly ordering).
    merged.sort((a, b) => {
        const la = Math.abs(a.l), lb = Math.abs(b.l);
        if (la !== lb) return la - lb;
        const ka = Math.abs(a.k), kb = Math.abs(b.k);
        if (ka !== kb) return ka - kb;
        return Math.abs(a.h) - Math.abs(b.h) || a.h - b.h;
    });
    return {
        merged,
        nObs: reflections.length,
        nUnique: merged.length,
        meanMultiplicity: merged.length ? reflections.length / merged.length : 0,
    };
}

// Resolution limits of a reflection set for a unit cell.
export function resolutionLimits(reflections, cell) {
    let dmin = Infinity, dmax = 0;
    for (const r of reflections) {
        const d = dSpacing(r.h, r.k, r.l, cell);
        if (!Number.isFinite(d) || d <= 0) continue;
        if (d < dmin) dmin = d;
        if (d > dmax) dmax = d;
    }
    if (!Number.isFinite(dmin)) return { dmin: 0, dmax: 0 };
    return { dmin, dmax };
}

// Number of unique reflections (under the Laue group) in the resolution shell
// [dmin, dmax]. Used to compute completeness. Iterates only the indices that
// can possibly fall inside the shell (per-(h,k) analytic l-bounds) so that
// high-resolution data does not cause a full-cube scan.
export function expectedUniqueCount(cell, matrices, dmin, dmax, maxCount = 3000000) {
    const r = reciprocalCell(cell);
    if (!r) return 0;
    const aS = r.aS, bS = r.bS, cS = r.cS;
    const cosA = r.cosA, cosB = r.cosB, cosG = r.cosG;
    const Bmin = 1 / (dmax * dmax);
    const Bmax = 1 / (dmin * dmin);

    const A = cS * cS;
    const hmax = Math.ceil(Math.sqrt(Bmax) / aS) + 1;
    const kmax = Math.ceil(Math.sqrt(Bmax) / bS) + 1;

    const set = new Set();
    let total = 0;

    for (let h = -hmax; h <= hmax; h++) {
        for (let k = -kmax; k <= kmax; k++) {
            // F(l) = A*l^2 + B*l + C,  C = fixed part, B = cross term in l.
            const C = aS * aS * h * h + bS * bS * k * k + 2 * aS * bS * cosG * h * k;
            const B = 2 * cS * (aS * cosB * h + bS * cosA * k);

            // Roots of F = Bmax (outer l bounds).
            const Dmax = B * B - 4 * A * (C - Bmax);
            if (Dmax < 0) continue; // F(l) > Bmax for all l
            const sD = Math.sqrt(Dmax);
            const r1 = (-B - sD) / (2 * A);
            const r2 = (-B + sD) / (2 * A);

            // The F >= Bmin condition is automatically satisfied when F = Bmin
            // has no real roots (F stays above Bmin for every l); otherwise the
            // excluded zone is (s1, s2).
            let segs;
            const Dmin = B * B - 4 * A * (C - Bmin);
            if (Dmin < 0) {
                segs = [[r1, r2]];
            } else {
                const sD2 = Math.sqrt(Dmin);
                const s1 = (-B - sD2) / (2 * A);
                const s2 = (-B + sD2) / (2 * A);
                segs = [[r1, Math.min(r2, s1)], [Math.max(r1, s2), r2]];
            }

            for (const [l0raw, l1raw] of segs) {
                const l0 = Math.ceil(l0raw);
                const l1 = Math.floor(l1raw);
                if (l0 > l1) continue;
                total += (l1 - l0 + 1);
                if (total > maxCount) {
                    // Extreme case: fall back to a coarse volume estimate so we
                    // never scan the entire shell point by point.
                    return Math.round(estimateUniqueCount(cell, matrices, dmin, dmax));
                }
                for (let l = l0; l <= l1; l++) {
                    if (h === 0 && k === 0 && l === 0) continue;
                    const F = A * l * l + B * l + C;
                    if (F < Bmin || F > Bmax) continue;
                    const { rep } = canonicalRep([h, k, l], matrices);
                    set.add(rep[0] + ',' + rep[1] + ',' + rep[2]);
                }
            }
        }
    }
    return set.size;
}

// Coarse volume-based estimate of the number of unique reflections in the
// resolution shell (used only for pathologically large cases).
export function estimateUniqueCount(cell, matrices, dmin, dmax) {
    const r = reciprocalCell(cell);
    if (!r) return 0;
    const volRecip = Math.abs(
        r.aS * r.bS * r.cS * Math.sqrt(
            1 - r.cosA * r.cosA - r.cosB * r.cosB - r.cosG * r.cosG
            + 2 * r.cosA * r.cosB * r.cosG
        ));
    if (!(volRecip > 0)) return 0;
    const shellVol = (4 / 3) * Math.PI * (1 / (dmin * dmin * dmin) - 1 / (dmax * dmax * dmax));
    const total = Math.max(1, shellVol / volRecip);
    return total / matrices.length; // each orbit holds `order` reflections
}

// Merging statistics (R(merge), R(meas), R(pim), completeness, ...).
export function computeMergeStatistics(reflections, matrices, cell) {
    const { merged, nObs, nUnique, meanMultiplicity } = mergeReflections(reflections, matrices, cell);
    const { dmin, dmax } = resolutionLimits(reflections, cell);

    // Re-group to compute R(merge), R(pim), R(meas).
    const map = new Map();
    for (const r of reflections) {
        const { rep } = canonicalRep([r.h, r.k, r.l], matrices);
        const key = rep[0] + ',' + rep[1] + ',' + rep[2];
        let arr = map.get(key);
        if (!arr) { arr = []; map.set(key, arr); }
        arr.push(r.I);
    }
    let rMergeNum = 0, rMeasNum = 0, rPimNum = 0, denom = 0;
    let sumIsig = 0, nIsig = 0, sumI = 0;
    for (const arr of map.values()) {
        let s = 0;
        for (const v of arr) s += v;
        const mean = s / arr.length;
        let num = 0;
        for (const v of arr) { num += Math.abs(v - mean); rMergeNum += Math.abs(v - mean); denom += v; }
        const n = arr.length;
        if (n > 1) {
            rMeasNum += num * (n / (n - 1));
            rPimNum += num / Math.sqrt(n - 1);
        }
    }
    for (const m of merged) {
        sumIsig += m.sig > 0 ? Math.abs(m.I) / m.sig : 0;
        nIsig++;
        sumI += Math.abs(m.I);
    }

    let expected = 0;
    let completeness = 0;
    if (Number.isFinite(dmin) && dmin > 0) {
        expected = expectedUniqueCount(cell, matrices, dmin, dmax);
        completeness = expected ? nUnique / expected : 0;
    }

    return {
        dmin,
        dmax,
        nObs,
        nUnique,
        meanMultiplicity,
        completeness,
        rMerge: denom > 0 ? rMergeNum / denom : 0,
        rMeas: denom > 0 ? rMeasNum / denom : 0,
        rPim: denom > 0 ? rPimNum / denom : 0,
        meanIsig: nIsig ? sumIsig / nIsig : 0,
        meanI: nIsig ? sumI / nIsig : 0,
    };
}

// Write a merged dataset in SHELX five-column HKL format.
export function writeShelxHkl(merged) {
    const lines = [];
    for (const r of merged) {
        lines.push(`${String(r.h).padStart(4)}${String(r.k).padStart(4)}${String(r.l).padStart(4)}${r.I.toFixed(2).padStart(10)}${r.sig.toFixed(2).padStart(8)}`);
    }
    return lines.join('\n') + '\n';
}

// Write a merged dataset as a merged XDS_ASCII file (MERGE=TRUE).
export function writeXdsAscii(merged, header = {}) {
    const out = [];
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${pad(d.getDate())}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]}-${d.getFullYear()}`;
    out.push(`!FORMAT=XDS_ASCII    MERGE=TRUE    FRIEDEL'S_LAW=TRUE`);
    out.push(`!OUTPUT_FILE=${header.outputFile || 'structure_XDS.HKL'}        DATE=${dateStr}`);
    out.push(`!Generated by xrdspace (WebXTL)`);
    if (header.spaceGroupNumber) out.push(`!SPACE_GROUP_NUMBER=${header.spaceGroupNumber}`);
    if (header.spaceGroupName) out.push(`!SPACE_GROUP_NAME=${header.spaceGroupName}`);
    if (header.wavelength) out.push(`!X-RAY_WAVELENGTH=${header.wavelength}`);
    if (header.cell) {
        const c = header.cell;
        out.push(`!UNIT_CELL_CONSTANTS= ${c.a} ${c.b} ${c.c} ${c.alpha} ${c.beta} ${c.gamma}`);
    }
    if (header.dmin) out.push(`!INCLUDE_RESOLUTION_RANGE= ${header.dmax || 50} ${header.dmin}`);
    // In a merged XDS_ASCII file columns 6-8 hold ISIGMA(I) placeholders.
    for (const r of merged) {
        out.push(`${r.h} ${r.k} ${r.l} ${r.I.toFixed(2)} ${r.sig.toFixed(2)} 0.000 0.000 0.000 0.000 0.000 ${r.multiplicity || 1}`);
    }
    out.push('!END_OF_DATA');
    return out.join('\n') + '\n';
}

// Merging report text.
export function buildMergingReport(statistics, sgInfo, cell) {
    const fmtPct = (x) => (x * 100).toFixed(1) + ' %';
    const fmt = (x, d = 2) => (x || 0).toFixed(d);
    const out = [];
    out.push('Merging report (xrdspace)');
    out.push('======================================');
    out.push(`Space group       : ${sgInfo.hm} (No. ${sgInfo.id})`);
    out.push(`Laue group        : ${sgInfo.laue}`);
    out.push(`Bravais lattice   : ${sgInfo.centering} ${sgInfo.laue}`);
    out.push(`Cell              : ${cell.a} ${cell.b} ${cell.c}  ${cell.alpha} ${cell.beta} ${cell.gamma}`);
    out.push('');
    out.push('Merging statistics:');
    out.push(`  Resolution range : ${fmt(statistics.dmax)} - ${fmt(statistics.dmin)} A`);
    out.push(`  Total observations: ${statistics.nObs}`);
    out.push(`  Unique reflections: ${statistics.nUnique}`);
    out.push(`  Mean multiplicity: ${fmt(statistics.meanMultiplicity, 1)}`);
    out.push(`  Completeness     : ${fmtPct(statistics.completeness)}`);
    out.push(`  R(merge)         : ${fmtPct(statistics.rMerge)}`);
    out.push(`  R(meas)          : ${fmtPct(statistics.rMeas)}`);
    out.push(`  R(pim)           : ${fmtPct(statistics.rPim)}`);
    out.push(`  Mean I/sigma(I)  : ${fmt(statistics.meanIsig, 1)}`);
    out.push('');
    out.push('The merged HKL file (SHELX format) is ready for SHELXD / SHELXT / SHELXS.');
    return out.join('\n');
}
