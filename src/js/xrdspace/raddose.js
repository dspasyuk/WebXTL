// Copyright (c) 2026 Denis Spasyuk. MIT License.
// RADDOSE-style beam-damage analysis for xrdspace.
//
// Radiation damage during a rotation experiment attenuates the diffracted
// intensity. For a single-pass scan the cumulative dose at the moment a
// reflection is recorded is proportional to its rotation angle (PSI), so the
// reflections recorded late in the scan are weaker than those recorded early.
//
// Following Pantelides et al. (Acta Cryst. D65, 1010-1022, 2009) the damage
// is quantified per resolution shell by the ratio of the mean intensity
// recorded in the LATE part of the scan to that recorded in the EARLY part:
//
//     R(d) = <I>_late / <I>_early
//
// R = 1 means no damage; R < 1 means the data decayed over the course of the
// scan, and R falls with resolution (high-resolution reflections are damaged
// faster). The ratios are normalised so the least-damaged shell is 1.0, and
// ln(R) is regressed against 1/d^2 to give the decay constant.
//
// The dose coordinate is the rotation angle, not a physical absorbed dose:
// converting the decay constant to e-/A^2 (or Gy) requires the beam flux /
// current, which is not stored in an HKL file. Results are therefore reported
// in units of rotation angle (degrees) with that assumption stated.

import { dSpacing, reciprocalCell } from './merge.js';

// Unwrap a rotation angle (PSI, degrees) to a cumulative dose position in
// [0, totalRotation). Falls back to a 360-degree rotation when the scan
// geometry does not carry a total rotation.
function doseOf(psi, geometry) {
    if (!Number.isFinite(psi)) return NaN;
    const total = (geometry && Number.isFinite(geometry.totalRotation) && geometry.totalRotation > 0)
        ? geometry.totalRotation : 360;
    const start = (geometry && Number.isFinite(geometry.startAngle)) ? geometry.startAngle : 0;
    const x = (psi - start) % total;
    return x < 0 ? x + total : x;
}

// Weighted linear regression of y on x with per-point weights w.
// Returns { slope, intercept, r2, n }.
function weightedLinReg(xs, ys, ws) {
    const n = xs.length;
    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
    for (let i = 0; i < n; i++) {
        const w = ws[i] || 0;
        sw += w;
        swx += w * xs[i];
        swy += w * ys[i];
        swxx += w * xs[i] * xs[i];
        swxy += w * xs[i] * ys[i];
    }
    if (n < 2 || sw <= 0) return { slope: NaN, intercept: NaN, r2: NaN, n };
    const denom = sw * swxx - swx * swx;
    if (Math.abs(denom) < 1e-12) return { slope: NaN, intercept: NaN, r2: NaN, n };
    const slope = (sw * swxy - swx * swy) / denom;
    const intercept = (swy - slope * swx) / sw;
    let sse = 0, sst = 0, ybar = swy / sw;
    for (let i = 0; i < n; i++) {
        const w = ws[i] || 0;
        const yhat = intercept + slope * xs[i];
        sse += w * (ys[i] - yhat) * (ys[i] - yhat);
        sst += w * (ys[i] - ybar) * (ys[i] - ybar);
    }
    const r2 = sst > 0 ? 1 - sse / sst : NaN;
    return { slope, intercept, r2, n };
}

// Resolution shells (equal-width in 1/d^2) of the reflections that carry a dose.
function resolutionShells(rows, cell, nshells) {
    const recip = reciprocalCell(cell);
    let qmin = Infinity, qmax = -Infinity;
    for (const x of rows) {
        const d = dSpacing(x.h, x.k, x.l, cell, recip);
        if (!Number.isFinite(d) || d <= 0) continue;
        x.q = 1 / (d * d);
        if (x.q < qmin) qmin = x.q;
        if (x.q > qmax) qmax = x.q;
    }
    if (!Number.isFinite(qmin)) return [];
    if (qmax - qmin < 1e-12) qmax = qmin + 1e-9;
    const width = (qmax - qmin) / nshells;
    const shells = Array.from({ length: nshells }, (_, i) => ({
        qLo: qmin + i * width,
        qHi: qmin + (i + 1) * width,
        dLo: 1 / Math.sqrt(qmin + (i + 1) * width),   // low-resolution edge (large d)
        dHi: 1 / Math.sqrt(qmin + i * width),          // high-resolution edge (small d)
    }));
    for (const x of rows) {
        let b = Math.floor((x.q - qmin) / width);
        if (b >= nshells) b = nshells - 1;
        if (b < 0) b = 0;
        x.shell = b;
    }
    return shells;
}

/**
 * RADDOSE-style beam-damage analysis over unmerged observations.
 *
 * reflections: [{ h, k, l, I, sig, psi?, rejected? }]
 * cell:        { a, b, c, alpha, beta, gamma }
 * geometry:    { startAngle, oscRange, nFrames, totalRotation } (from the parser)
 * options:
 *   minIsig    - minimum I/sigma for an observation to enter the analysis (default 2)
 *   earlyFrac  - fraction of the rotation counted as "early" (default 0.25)
 *   lateFrac   - fraction of the rotation counted as "late"  (default 0.25)
 *   shells     - number of resolution shells (default 10)
 *
 * Returns an object; see `usable`/`reason` when the data does not support the
 * analysis (e.g. no per-observation rotation angle).
 */
export function analyzeBeamDamage(reflections, cell, geometry, options = {}) {
    const minIsig = options.minIsig ?? 2;
    const earlyFrac = options.earlyFrac ?? 0.25;
    const lateFrac = options.lateFrac ?? 0.25;
    const nshells = options.shells ?? 10;

    const totalRotation = (geometry && Number.isFinite(geometry.totalRotation) && geometry.totalRotation > 0)
        ? geometry.totalRotation : 360;
    const startAngle = (geometry && Number.isFinite(geometry.startAngle)) ? geometry.startAngle : 0;

    // Usable observations: not rejected, carrying a rotation angle, and above
    // the I/sigma threshold.
    const rows = [];
    for (const r of reflections) {
        if (r.rejected) continue;
        const dose = doseOf(r.psi, geometry);
        if (!Number.isFinite(dose)) continue;
        const isig = r.sig > 0 ? Math.abs(r.I) / r.sig : Infinity;
        if (isig < minIsig) continue;
        rows.push({ h: r.h, k: r.k, l: r.l, I: r.I, sig: r.sig, dose });
    }

    if (rows.length < 100) {
        return {
            usable: false,
            reason: rows.length === 0
                ? 'no per-observation rotation angle (PSI) in the input'
                : `too few usable observations (${rows.length}) for a damage analysis`,
            totalRotation, startAngle, nObs: rows.length,
        };
    }

    // Dose range actually covered by the data.
    let dmin = Infinity, dmax = -Infinity;
    for (const x of rows) { if (x.dose < dmin) dmin = x.dose; if (x.dose > dmax) dmax = x.dose; }
    const span = Math.max(dmax - dmin, 1e-9);
    const earlyHi = dmin + earlyFrac * span;   // [dmin, earlyHi)  -> early
    const lateLo = dmax - lateFrac * span;     // (lateLo, dmax]   -> late

    const shells = resolutionShells(rows, cell, nshells);
    if (!shells.length) {
        return { usable: false, reason: 'no reflections with a valid d-spacing', totalRotation, startAngle, nObs: rows.length };
    }

    // Accumulate early / late intensities per shell.
    const acc = shells.map(() => ({ eSum: 0, eN: 0, lSum: 0, lN: 0 }));
    for (const x of rows) {
        const a = acc[x.shell];
        if (x.dose < earlyHi) { a.eSum += x.I; a.eN++; }
        else if (x.dose > lateLo) { a.lSum += x.I; a.lN++; }
    }

    // Per-shell ratio R = <I>_late / <I>_early. Each shell is normalised by
    // its own early intensity, so R is scale-free and directly comparable
    // across shells: R = 1 means no damage in that shell, R < 1 means the
    // intensities decayed over the course of the scan.
    const shellsOut = shells.map((s, i) => {
        const a = acc[i];
        const meanE = a.eN ? a.eSum / a.eN : NaN;
        const meanL = a.lN ? a.lSum / a.lN : NaN;
        return {
            dLo: s.dLo, dHi: s.dHi, dMid: 1 / Math.sqrt((s.qLo + s.qHi) / 2),
            nEarly: a.eN, nLate: a.lN,
            meanEarly: meanE, meanLate: meanL,
            ratio: (Number.isFinite(meanE) && Number.isFinite(meanL) && meanE !== 0) ? meanL / meanE : NaN,
        };
    }).filter(s => Number.isFinite(s.ratio));

    if (shellsOut.length < 3) {
        return {
            usable: false,
            reason: `too few resolution shells with both early and late data (${shellsOut.length})`,
            totalRotation, startAngle, nObs: rows.length,
        };
    }

    // Fit ln(R) = a + b * (1/d^2). b < 0 => the decay increases with resolution
    // (high-resolution reflections are damaged faster), the classic RADDOSE
    // pattern. The weighted slope is the decay rate per A^-2.
    const xs = shellsOut.map(s => 1 / (s.dMid * s.dMid));
    const ys = shellsOut.map(s => Math.log(s.ratio));
    const ws = shellsOut.map(s => s.nEarly + s.nLate);
    const reg = weightedLinReg(xs, ys, ws);

    // Overall early->late drop: the observation-weighted mean of the per-shell
    // ratios. Each per-shell ratio is already scale-free (normalised by that
    // shell's own early intensity), so combining them avoids the bias of
    // comparing raw intensity sums over different reflection sets.
    let wSum = 0, wRatio = 0;
    for (const s of shellsOut) {
        const w = s.nEarly + s.nLate;
        wSum += w;
        wRatio += w * s.ratio;
    }
    const overallRatio = wSum > 0 ? wRatio / wSum : NaN;
    const k = (Number.isFinite(overallRatio) && overallRatio > 0 && totalRotation > 0)
        ? -Math.log(overallRatio) / totalRotation : NaN;   // per degree
    const doseHalf = k > 0 ? Math.LN2 / k : null;          // degrees to half

    let decay = 'indeterminate';
    if (Number.isFinite(overallRatio)) {
        if (overallRatio < 0.95) decay = 'yes';
        else if (overallRatio < 0.99) decay = 'marginal';
        else if (overallRatio > 1.01) decay = 'no (intensity increased)';
        else decay = 'no';
    }

    return {
        usable: true,
        totalRotation, startAngle,
        doseMin: dmin, doseMax: dmax,
        nObs: rows.length,
        nRefl: new Set(rows.map(r => r.h + ',' + r.k + ',' + r.l)).size,
        earlyFrac, lateFrac, minIsig,
        overall: {
            ratio: overallRatio,          // <I>_late / <I>_early over all shells
            k,                            // decay constant, per degree of rotation
            r2: reg.r2,
            doseHalf,
        },
        shells: shellsOut,
        decay,
    };
}

// Express a per-degree decay constant in intuitive "per 100 degrees" units.
export function kPer100(k) {
    return Number.isFinite(k) ? k * 100 : NaN;
}
