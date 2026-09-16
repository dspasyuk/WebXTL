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

// d-spacing (Angstrom) of reflection hkl for a unit cell. `recip` is an
// optional precomputed reciprocalCell(cell) (avoids recomputing it in loops).
export function dSpacing(h, k, l, cell, recip) {
    const r = recip || reciprocalCell(cell);
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
        // Drop observations that the data reduction flagged as rejected
        // (XDS_ASCII marks them with a negative sigma); they are outliers and
        // must not enter the weighted mean.
        if (r.rejected) continue;
        arr.push({ I: r.I, sig: r.sig });
    }
    const merged = [];
    for (const [key, arr] of map) {
        if (!arr.length) continue;
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
        // Sigma of the weighted mean. The previous code ADDED the standard
        // error of the mean (the observed sample scatter) to the weighted-mean
        // variance, which double-counts the variance: for consistent data both
        // terms estimate sigma^2/n, so every merged sigma came out about
        // sqrt(2) too large. The resulting I/sigma did not match a reference
        // (XPREP on the same XDS_ASCII file), so the usual weighted-mean sigma
        // sqrt(1/sum(w)) is used instead. A global error-inflation factor can
        // still be applied downstream (SHELXL refines its weighting), but the
        // per-reflection scatter must not be added twice.
        const sig2 = w > 0 ? 1 / w : 0;
        const sig = Math.sqrt(sig2);
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
    // The maximum |h| (resp. |k|) on the reciprocal ellipsoid q <= 1/dmin^2 is
    // a/dmin (resp. b/dmin): the extent of the ellipsoid along an axis is the
    // corresponding *real-space* cell length. Bounding by 1/a* instead would
    // drop reflections whose h is compensated by l (e.g. monoclinic h/l
    // coupling), underestimating the possible-reflection count.
    const hmax = Math.ceil(cell.a / dmin) + 1;
    const kmax = Math.ceil(cell.b / dmin) + 1;

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

// Number of lattice points per (conventional) unit cell for a Bravais
// centering. A centered lattice has only 1/multiplicity of the primitive
// reflections allowed, so the expected unique count is the primitive count
// divided by this factor.
export function centeringMultiplicity(centering) {
    switch (String(centering || 'P').toUpperCase()) {
        case 'A': case 'B': case 'C': case 'I': return 2;
        case 'F': return 4;
        case 'R': return 3;
        default: return 1;
    }
}

// Resolution (A) at which the mean I/sigma(I) of the merged data falls to
// `target` (default 2). Merged reflections are binned by 1/d^2 and the crossing
// is linearly interpolated between adjacent shells. Also counts the unique
// reflections coarser than that limit (d >= cutoff). Returns
// { d, isig, nUnique } or null when no resolution shell reaches the target.
export function resolutionAtISigma(merged, cell, target = 2, nbins = 20) {
    const n = merged ? merged.length : 0;
    if (!n) return null;
    const recip = reciprocalCell(cell);
    const q = new Array(n);
    let qmin = Infinity, qmax = 0;
    for (let i = 0; i < n; i++) {
        const d = dSpacing(merged[i].h, merged[i].k, merged[i].l, cell, recip);
        const qi = d > 0 ? 1 / (d * d) : NaN;
        q[i] = qi;
        if (Number.isFinite(qi)) {
            if (qi < qmin) qmin = qi;
            if (qi > qmax) qmax = qi;
        }
    }
    if (!(qmax > qmin)) return null;

    const nb = Math.max(2, Math.min(nbins, n));
    const sum = new Float64Array(nb);
    const cnt = new Int32Array(nb);
    for (let i = 0; i < n; i++) {
        const qi = q[i];
        if (!Number.isFinite(qi)) continue;
        const r = merged[i];
        if (!(r.sig > 0)) continue;
        let b = Math.floor((qi - qmin) / (qmax - qmin) * nb);
        if (b < 0) b = 0;
        if (b >= nb) b = nb - 1;
        sum[b] += r.I / r.sig;
        cnt[b]++;
    }
    const qc = (b) => qmin + (b + 0.5) * (qmax - qmin) / nb;

    // Walk from low to high resolution; stop at the first shell whose mean
    // I/sigma drops below the target (shells with too few reflections are
    // ignored rather than treated as a drop).
    let lastGood = -1, failBin = -1;
    for (let b = 0; b < nb; b++) {
        if (cnt[b] < 3) continue;
        if (sum[b] / cnt[b] >= target) lastGood = b;
        else { failBin = b; break; }
    }
    if (lastGood === -1) return null; // even the coarsest shell is below target

    let qCut;
    if (failBin === -1) {
        qCut = qmax; // every shell is at or above the target
    } else {
        const m0 = sum[lastGood] / cnt[lastGood];
        const m1 = sum[failBin] / cnt[failBin];
        qCut = m0 !== m1
            ? qc(lastGood) + (target - m0) * (qc(failBin) - qc(lastGood)) / (m1 - m0)
            : qc(lastGood);
        qCut = Math.min(Math.max(qCut, qmin), qmax);
    }
    const dCut = 1 / Math.sqrt(qCut);
    let nUnique = 0;
    for (let i = 0; i < n; i++) {
        const qi = q[i];
        if (Number.isFinite(qi) && 1 / Math.sqrt(qi) >= dCut - 1e-9) nUnique++;
    }
    return { d: dCut, isig: target, nUnique };
}

// Per-resolution-shell merging statistics (the standard quality table). Shells
// are equal-width in 1/d^2. Each row reports the d-range, observed/unique
// counts, completeness, multiplicity, R(merge), R(meas), R(pim), mean I/sigma,
// CC(1/2) and the negative-intensity fraction.
export function resolutionShellStats(reflections, matrices, cell, options = {}) {
    const nbshell = options.shells || 10;
    const centeringMult = centeringMultiplicity(options.centering);
    const r = reciprocalCell(cell);
    const n = reflections.length;
    if (!r || !n) return [];
    const q = new Float64Array(n);
    let qmin = Infinity, qmax = 0;
    for (let i = 0; i < n; i++) {
        const d = dSpacing(reflections[i].h, reflections[i].k, reflections[i].l, cell, r);
        const qi = d > 0 ? 1 / (d * d) : NaN;
        q[i] = qi;
        if (Number.isFinite(qi)) { if (qi < qmin) qmin = qi; if (qi > qmax) qmax = qi; }
    }
    if (!(qmax > qmin)) return [];

    const groups = [];
    for (let b = 0; b < nbshell; b++) groups.push(new Map());
    for (let i = 0; i < n; i++) {
        const qi = q[i];
        if (!Number.isFinite(qi)) continue;
        let b = Math.floor((qi - qmin) / (qmax - qmin) * nbshell);
        if (b < 0) b = 0;
        if (b >= nbshell) b = nbshell - 1;
        const o = reflections[i];
        const { rep } = canonicalRep([o.h, o.k, o.l], matrices);
        const key = rep[0] + ',' + rep[1] + ',' + rep[2];
        let g = groups[b].get(key);
        if (!g) { g = { vals: [] }; groups[b].set(key, g); }
        g.vals.push(o);
    }

    const shells = [];
    for (let b = 0; b < nbshell; b++) {
        const qLo = qmin + b * (qmax - qmin) / nbshell;        // high-resolution edge
        const qHi = qmin + (b + 1) * (qmax - qmin) / nbshell;  // low-resolution edge
        const dLo = 1 / Math.sqrt(qHi);
        const dHi = 1 / Math.sqrt(qLo);
        let nObs = 0, nUnique = 0, rMergeNum = 0, rMeasNum = 0, rPimNum = 0, denom = 0;
        let sumIsig = 0, nIsig = 0, neg = 0;
        const halfA = [], halfB = [];
        for (const g of groups[b].values()) {
            const vals = g.vals, nv = vals.length;
            nObs += nv; nUnique++;
            let ws = 0, w = 0, signed = 0;
            for (const o of vals) {
                if (o.I < 0) neg++;
                signed += o.I;
                if (o.sig > 0) { const wi = 1 / (o.sig * o.sig); ws += o.I * wi; w += wi; }
                else { ws += o.I; w += 1; }
            }
            const mean = signed / nv;
            let sem2 = 0;
            if (nv > 1) { for (const o of vals) sem2 += (o.I - mean) * (o.I - mean); sem2 /= (nv * (nv - 1)); }
            const sig = Math.sqrt((w > 0 ? 1 / w : 0) + sem2);
            if (sig > 0) { sumIsig += Math.abs(mean) / sig; nIsig++; }
            let num = 0;
            for (const o of vals) { const dv = Math.abs(o.I - mean); num += dv; rMergeNum += dv; denom += o.I; }
            if (nv > 1) {
                rMeasNum += num * (nv / (nv - 1));
                rPimNum += num / Math.sqrt(nv - 1);
            }
            // CC(1/2): split the orbit's observations deterministically in half.
            if (nv >= 2) {
                let sa = 0, ca = 0, sb = 0, cb = 0;
                for (let j = 0; j < nv; j++) {
                    if (j % 2 === 0) { sa += vals[j].I; ca++; } else { sb += vals[j].I; cb++; }
                }
                if (ca && cb) { halfA.push(sa / ca); halfB.push(sb / cb); }
            }
        }
        let ccHalf = null;
        if (halfA.length >= 10) {
            const m = halfA.length;
            let ma = 0, mb = 0;
            for (let i = 0; i < m; i++) { ma += halfA[i]; mb += halfB[i]; }
            ma /= m; mb /= m;
            let sab = 0, saa = 0, sbb = 0;
            for (let i = 0; i < m; i++) {
                const da = halfA[i] - ma, db = halfB[i] - mb;
                sab += da * db; saa += da * da; sbb += db * db;
            }
            ccHalf = (saa > 0 && sbb > 0) ? sab / Math.sqrt(saa * sbb) : null;
        }
        let completeness = null;
        if (options.completeness !== false) {
            const expected = (dLo > 0 && dHi > dLo)
                ? expectedUniqueCount(cell, matrices, dLo, dHi) / centeringMult
                : 0;
            if (expected) completeness = Math.min(1, nUnique / expected);
        }
        const hasSignal = denom > 0;
        shells.push({
            dLo, dHi, nObs, nUnique, completeness,
            multiplicity: nUnique ? nObs / nUnique : 0,
            rMerge: hasSignal ? rMergeNum / denom : null,
            rMeas: hasSignal ? rMeasNum / denom : null,
            rPim: hasSignal ? rPimNum / denom : null,
            meanIsig: nIsig ? sumIsig / nIsig : 0,
            ccHalf,
            negFrac: nObs ? neg / nObs : 0,
        });
    }
    return shells;
}

// Resolution (A) at which CC(1/2) falls to `target` (default 0.30), estimated
// from the per-shell CC(1/2) and interpolated in 1/d^2 between adjacent shells.
// Also counts the unique reflections coarser than that limit.
// Returns { d, nUnique } or null when no shell reaches the target.
export function resolutionAtCCHalf(reflections, matrices, cell, target = 0.30, nbins = 10) {
    const shells = resolutionShellStats(reflections, matrices, cell, { shells: nbins, completeness: false });
    if (!shells.length) return null;
    const qc = (s) => 0.5 * (1 / (s.dLo * s.dLo) + 1 / (s.dHi * s.dHi));
    let lastGood = -1, fail = -1;
    for (let i = 0; i < shells.length; i++) {
        const s = shells[i];
        if (s.ccHalf == null || s.nUnique < 10) continue;
        if (s.ccHalf >= target) lastGood = i;
        else { fail = i; break; }
    }
    if (lastGood === -1) return null;
    let dCut;
    if (fail === -1) {
        dCut = shells[lastGood].dLo;
    } else {
        const s0 = shells[lastGood], s1 = shells[fail];
        const q0 = qc(s0), q1 = qc(s1);
        const c0 = s0.ccHalf, c1 = s1.ccHalf;
        let q = (c0 !== c1) ? q0 + (target - c0) * (q1 - q0) / (c1 - c0) : q0;
        q = Math.min(Math.max(q, q0), q1);
        dCut = 1 / Math.sqrt(q);
    }
    let nUnique = 0;
    for (let i = 0; i <= lastGood; i++) nUnique += shells[i].nUnique;
    return { d: dCut, nUnique };
}

// Diagnostic flags for the report: strong outliers ("alien" reflections,
// compared to the orbit median), a scan for hexagonal-ice rings, and a simple
// anisotropy check (resolution at I/sigma = 2 along each reciprocal axis).
const ICE_RINGS = [3.897, 3.669, 3.441, 2.671, 2.249];

export function artifactReport(reflections, matrices, cell, options = {}) {
    const r = reciprocalCell(cell);
    const outlierSigma = options.outlierSigma || 10;
    const n = reflections.length;

    // Group by Laue orbit (canonical representative).
    const groups = new Map();
    for (const o of reflections) {
        const { rep } = canonicalRep([o.h, o.k, o.l], matrices);
        const key = rep.join(',');
        let g = groups.get(key);
        if (!g) { g = { h: rep[0], k: rep[1], l: rep[2], vals: [] }; groups.set(key, g); }
        g.vals.push(o);
    }

    // Outliers: |I - median(orbit)| / sigma(I). A median reference is robust to
    // a single spike, which a mean would smear across the whole orbit.
    const outliers = [];
    let checked = 0;
    for (const g of groups.values()) {
        const vals = g.vals, nv = vals.length;
        if (nv < 2) continue;
        const sorted = vals.map(o => o.I).sort((a, b) => a - b);
        const mid = nv >> 1;
        const median = (nv % 2) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        for (const o of vals) {
            if (!(o.sig > 0)) continue;
            checked++;
            const dev = Math.abs(o.I - median) / o.sig;
            if (dev > outlierSigma) {
                const d = dSpacing(g.h, g.k, g.l, cell, r);
                outliers.push({ h: g.h, k: g.k, l: g.l, d, I: o.I, sig: o.sig, dev, n: nv });
            }
        }
    }
    outliers.sort((a, b) => b.dev - a.dev);

    // Ice-ring scan: mean |I| in a +/-0.05 A band around each ice d, versus the
    // +/-0.05-0.15 A background on either side. Run on the merged intensities:
    // symmetry averaging suppresses noise, so a coherent ring stands out.
    const mergedAll = mergeReflections(reflections, matrices, cell).merged;
    const iceRings = [];
    for (const d0 of ICE_RINGS) {
        let ringSum = 0, ringN = 0, bgSum = 0, bgN = 0;
        for (const o of mergedAll) {
            const d = dSpacing(o.h, o.k, o.l, cell, r);
            if (!(d > 0)) continue;
            const off = Math.abs(d - d0);
            if (off <= 0.05) { ringSum += Math.abs(o.I); ringN++; }
            else if (off <= 0.15) { bgSum += Math.abs(o.I); bgN++; }
        }
        const ringMean = ringN ? ringSum / ringN : 0;
        const bgMean = bgN ? bgSum / bgN : 0;
        const ratio = bgMean > 0 ? ringMean / bgMean : 0;
        iceRings.push({ d: d0, n: ringN, ringMean, bgMean, ratio, flagged: ringN >= 20 && ratio > 1.3 });
    }

    // Anisotropy: resolution at I/sigma = 2 for reflections dominated by each
    // reciprocal axis (|index| strictly larger than the other two).
    const axes = [
        { axis: 'a*', dom: (h, k, l) => Math.abs(h) > Math.abs(k) && Math.abs(h) > Math.abs(l) },
        { axis: 'b*', dom: (h, k, l) => Math.abs(k) > Math.abs(h) && Math.abs(k) > Math.abs(l) },
        { axis: 'c*', dom: (h, k, l) => Math.abs(l) > Math.abs(h) && Math.abs(l) > Math.abs(k) },
    ];
    const anisotropy = axes.map(({ axis, dom }) => {
        const sub = reflections.filter(o => dom(o.h, o.k, o.l));
        if (sub.length < 100) return { axis, d: null, n: sub.length };
        const merged = mergeReflections(sub, matrices, cell).merged;
        const cut = resolutionAtISigma(merged, cell, 2);
        return { axis, d: cut ? cut.d : null, n: sub.length };
    });
    const limits = anisotropy.map(a => a.d).filter(v => v != null);
    const anisoRatio = limits.length >= 2 ? Math.max(...limits) / Math.min(...limits) : null;

    return {
        outliers: {
            count: outliers.length,
            checked,
            frac: checked ? outliers.length / checked : 0,
            top: outliers.slice(0, 10),
        },
        iceRings,
        anisotropy,
        anisoRatio,
        anisotropic: anisoRatio != null && anisoRatio > 1.15,
    };
}

// Merging statistics (R(merge), R(meas), R(pim), completeness, ...).
// `options.centering` (P/A/B/C/I/F/R) accounts for the Bravais lattice when
// computing completeness; without it the expected unique count is that of a
// primitive lattice (about 2x too high for C/I cells, 4x for F, 3x for R).
export function computeMergeStatistics(reflections, matrices, cell, options = {}) {
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

    let expected = 0;
    let completeness = 0;
    // Completeness within the meaningful resolution limits: mean I/sigma = 1
    // and CC(1/2) = 0.30. (A 2I/sigma limit is satisfied almost trivially and is
    // not a useful quality boundary.) CC(1/2) needs the per-shell analysis, so
    // it is only computed when requested (`options.quality`).
    let dIsig1 = null, completenessIsig1 = null, nUniqueIsig1 = 0;
    let dCC30 = null, completenessCC30 = null, nUniqueCC30 = 0;
    if (Number.isFinite(dmin) && dmin > 0) {
        // expectedUniqueCount returns the primitive-lattice count; a centered
        // lattice allows only 1/multiplicity of those reflections.
        const centeringMult = centeringMultiplicity(options.centering);
        expected = expectedUniqueCount(cell, matrices, dmin, dmax) / centeringMult;
        // Completeness cannot exceed 100%; the expected count is an estimate
        // and the observed data can round just above it.
        completeness = expected ? Math.min(1, nUnique / expected) : 0;

        const atCutoff = (cut) => {
            if (!cut) return { d: null, nUnique: 0, completeness: null };
            const exp = expectedUniqueCount(cell, matrices, cut.d, dmax) / centeringMult;
            return { d: cut.d, nUnique: cut.nUnique, completeness: exp ? Math.min(1, cut.nUnique / exp) : 0 };
        };
        const c1 = atCutoff(resolutionAtISigma(merged, cell, 1));
        dIsig1 = c1.d; nUniqueIsig1 = c1.nUnique; completenessIsig1 = c1.completeness;
        if (options.quality) {
            const c3 = atCutoff(resolutionAtCCHalf(reflections, matrices, cell, 0.30));
            dCC30 = c3.d; nUniqueCC30 = c3.nUnique; completenessCC30 = c3.completeness;
        }
    }

    // Mean I/sigma is reported within the CC(1/2) = 0.30 limit when it is
    // available, so the noise-dominated outer shells do not drag it down.
    let sumIsig = 0, nIsig = 0, sumI = 0, nI = 0;
    const recip = reciprocalCell(cell);
    for (const m of merged) {
        sumI += Math.abs(m.I); nI++;
        if (dCC30 != null) {
            const d = dSpacing(m.h, m.k, m.l, cell, recip);
            if (!(d >= dCC30 - 1e-9)) continue;
        }
        if (m.sig > 0) { sumIsig += Math.abs(m.I) / m.sig; nIsig++; }
    }

    return {
        dmin,
        dmax,
        dIsig1,
        nUniqueIsig1,
        completenessIsig1,
        dCC30,
        nUniqueCC30,
        completenessCC30,
        nObs,
        nUnique,
        meanMultiplicity,
        completeness,
        rMerge: denom > 0 ? rMergeNum / denom : 0,
        rMeas: denom > 0 ? rMeasNum / denom : 0,
        rPim: denom > 0 ? rPimNum / denom : 0,
        meanIsig: nIsig ? sumIsig / nIsig : 0,
        meanI: nI ? sumI / nI : 0,
    };
}

// Write a merged dataset in SHELX five-column HKL format.
export function writeShelxHkl(merged) {
    // SHELX HKLF 4 is a FIXED-COLUMN format: h, k, l occupy 4-column fields and
    // F^2, sigma(F^2) occupy 8-column fields (columns 1-4, 5-8, 9-12, 13-20,
    // 21-28). The fields must be concatenated with no extra blanks -- a single
    // stray space shifts every subsequent column and SHELXL aborts with
    // "REFLECTION n HAS WRONG FORMAT".
    //
    // The data are rescaled by a power of ten so that the largest F^2/sigma
    // fits the 8-column field with a separating blank. Raw XDS photon counts
    // can reach 1e6: without rescaling the F^2 fills its field, so `l` and F^2
    // run together ("   016177.12") and free-format readers (SHELXT) silently
    // mis-read the record, which produced a much worse structure solution
    // (R1 0.15 and the amino N assigned as O) than the same data on a compact
    // scale (R1 0.07, correct formula). XPREP likewise rescales the data to "a
    // reasonable scale"; the overall scale is arbitrary because SHELX refines
    // it, so this changes nothing crystallographically.
    let maxV = 0;
    for (const r of merged) {
        if (r.h === 0 && r.k === 0 && r.l === 0) continue;
        const a = Math.abs(r.I), b = Math.abs(r.sig);
        if (a > maxV) maxV = a;
        if (b > maxV) maxV = b;
    }
    let scale = 1;
    while (maxV * scale >= 10000) scale /= 10;
    const fit8 = (x) => {
        x *= scale;
        let s = x.toFixed(2);
        if (s.length > 8) s = x.toFixed(1);
        if (s.length > 8) s = x.toFixed(0);
        if (s.length > 8) s = x.toExponential(0);
        return s.padStart(8);
    };
    const lines = [];
    for (const r of merged) {
        // Skip the origin reflection (0,0,0): SHELXL stops reading the HKL
        // file entirely if it is present (reports 0 reflections / NO REFLECTION
        // DATA); it derives F(000) from the UNIT instruction instead.
        if (r.h === 0 && r.k === 0 && r.l === 0) continue;
        lines.push(`${String(r.h).padStart(4)}${String(r.k).padStart(4)}${String(r.l).padStart(4)}${fit8(r.I)}${fit8(r.sig)}`);
    }
    return lines.join('\n') + '\n';
}

// XDS_ASCII header date string (e.g. 28-Aug-2026).
function xdsDateString() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]}-${d.getFullYear()}`;
}

// Write a merged dataset as a merged XDS_ASCII file (MERGE=TRUE).
export function writeXdsAscii(merged, header = {}) {
    const out = [];
    const dateStr = xdsDateString();
    out.push(`!FORMAT=XDS_ASCII    MERGE=TRUE    FRIEDEL'S_LAW=TRUE`);
    out.push(`!OUTPUT_FILE=${header.outputFile || 'structure_xds.hkl'}        DATE=${dateStr}`);
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
        // Skip the origin reflection for consistency with writeShelxHkl.
        if (r.h === 0 && r.k === 0 && r.l === 0) continue;
        out.push(`${r.h} ${r.k} ${r.l} ${r.I.toFixed(2)} ${r.sig.toFixed(2)} 0.000 0.000 0.000 0.000 0.000 ${r.multiplicity || 1}`);
    }
    out.push('!END_OF_DATA');
    return out.join('\n') + '\n';
}

// Write the full reflection set as an UNMERGED XDS_ASCII file (MERGE=FALSE).
// Every observation is kept, so redundancy and (when present) the anomalous
// signal survive. For XDS_ASCII input the original data record is copied
// verbatim, preserving the auxiliary columns (XD, YD, ZD, RLP, PEAK, CORR, PSI);
// for other formats a 12-column record is synthesized from h, k, l, I, sig.
export function writeXdsAsciiUnmerged(reflections, header = {}) {
    const out = [];
    const dateStr = xdsDateString();
    const friedel = header.friedelsLaw == null ? null : (header.friedelsLaw ? 'TRUE' : 'FALSE');
    out.push('!FORMAT=XDS_ASCII    MERGE=FALSE' + (friedel ? `    FRIEDEL'S_LAW=${friedel}` : ''));
    out.push(`!OUTPUT_FILE=${header.outputFile || 'structure_unmerged.hkl'}        DATE=${dateStr}`);
    out.push('!Generated by xrdspace (WebXTL) - UNMERGED (all observations)');
    if (header.spaceGroupNumber) out.push(`!SPACE_GROUP_NUMBER=${header.spaceGroupNumber}`);
    if (header.spaceGroupName) out.push(`!SPACE_GROUP_NAME=${header.spaceGroupName}`);
    if (header.wavelength) out.push(`!X-RAY_WAVELENGTH=${header.wavelength}`);
    if (header.cell) {
        const c = header.cell;
        out.push(`!UNIT_CELL_CONSTANTS= ${c.a} ${c.b} ${c.c} ${c.alpha} ${c.beta} ${c.gamma}`);
    }
    if (header.dmin) out.push(`!INCLUDE_RESOLUTION_RANGE= ${header.dmax || 50} ${header.dmin}`);
    const items = ['H', 'K', 'L', 'IOBS', 'SIGMA(IOBS)', 'XD', 'YD', 'ZD', 'RLP', 'PEAK', 'CORR', 'PSI'];
    out.push(`!NUMBER_OF_ITEMS_IN_EACH_DATA_RECORD=${items.length}`);
    items.forEach((name, i) => out.push(`!ITEM_${name}=${i + 1}`));
    out.push('!END_OF_HEADER');
    for (const r of reflections) {
        if (r.raw) { out.push(r.raw); continue; }
        out.push(`${r.h} ${r.k} ${r.l} ${r.I.toFixed(2)} ${r.sig.toFixed(2)} 0.000 0.000 0.000 0.000 0 0 0.00`);
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
