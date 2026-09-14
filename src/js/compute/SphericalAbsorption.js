// Pure-JS analytic spherical absorption correction.
//
// A crystal treated as an isotropic sphere of radius R and linear absorption
// coefficient mu has a transmission factor T(mu*R, theta) where theta is the
// Bragg angle:
//
//   T = (1/V) integral over the sphere of exp(-mu (l_in + l_out)) dV
//
// l_in and l_out are the incident/diffracted path lengths inside the sphere.
// The theta = 0 value reduces to the standard tabulated sphere factor
//
//   A*(p) = 3 * (2 - exp(-2p) * (4p^2 + 4p + 2)) / (8 p^3),   A*(0) = 1
//
// (e.g. PLATON's AMUR table: p = 1 -> 0.24249, 2 -> 0.07142, 3 -> 0.02606).
// The theta dependence is the whole point of a spherical correction - a
// theta-independent factor is just an overall scale. Values of T(muR, theta)
// are precomputed by Gauss-Legendre integration of the exact integral (see
// SphereAbsorptionTable.js).
//
// Data are corrected with I_corr = I_obs / T; the arbitrary overall scale is
// absorbed by the refinement scale factor.

import { SPHERE_MUR, SPHERE_THETA_DEG, SPHERE_A } from './SphereAbsorptionTable.js';

export const ELECTRON_RADIUS_CM = 2.8179403262e-13;

// 3*(2 - e^-2p (4p^2+4p+2)) / (8p^3), or its Taylor series near p = 0.
function sphereFactor(p) {
    if (p <= 0) return 1;
    if (p < 0.2) {
        const p2 = p * p, p3 = p2 * p, p4 = p3 * p, p5 = p4 * p, p6 = p5 * p;
        return 1 - 1.5 * p + 1.2 * p2 - (2 / 3) * p3 + (2 / 7) * p4 - 0.1 * p5 + (4 / 135) * p6;
    }
    return 3 * (2 - Math.exp(-2 * p) * (4 * p * p + 4 * p + 2)) / (8 * p * p * p);
}

// Largest index i with arr[i] <= x, clamped to [0, arr.length-2].
function bracket(arr, x) {
    if (x <= arr[0]) return 0;
    if (x >= arr[arr.length - 1]) return arr.length - 2;
    let lo = 0, hi = arr.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= x) lo = mid; else hi = mid;
    }
    return lo;
}

export class SphericalAbsorption {
    // Standard theta = 0 sphere factor A*(muR).
    static transmission(muR) {
        return sphereFactor(muR);
    }

    // T(muR, theta) with bilinear interpolation of the precomputed table.
    // `thetaRad` is the Bragg angle in radians (clamped to [0, pi/2]).
    static transmissionTheta(muR, thetaRad) {
        const p = Math.max(0, Math.min(10, muR));
        const thetaDeg = Math.max(0, Math.min(90, thetaRad * 180 / Math.PI));
        const j = bracket(SPHERE_MUR, p);
        const i = bracket(SPHERE_THETA_DEG, thetaDeg);
        const t = (thetaDeg - SPHERE_THETA_DEG[i]) / (SPHERE_THETA_DEG[i + 1] - SPHERE_THETA_DEG[i]);
        const s = (p - SPHERE_MUR[j]) / (SPHERE_MUR[j + 1] - SPHERE_MUR[j]);
        const a = SPHERE_A[i][j] * (1 - s) + SPHERE_A[i][j + 1] * s;
        const b = SPHERE_A[i + 1][j] * (1 - s) + SPHERE_A[i + 1][j + 1] * s;
        return a * (1 - t) + b * t;
    }

    // Linear absorption coefficient in cm^-1 from the unit-cell contents:
    //   mu = (2 r_e lambda / V) * sum_over_cell(f")
    static linearMu({ cellVolume, wavelength, counts, fpp }) {
        if (!(cellVolume > 0) || !(wavelength > 0)) {
            throw new Error('cellVolume (A^3) and wavelength (A) are required');
        }
        const volumeCm3 = cellVolume * 1e-24;
        const lambdaCm = wavelength * 1e-8;
        const f2ByElement = {};
        Object.keys(fpp || {}).forEach(k => { f2ByElement[k.toUpperCase()] = fpp[k]; });
        let sumF2 = 0;
        Object.keys(counts || {}).forEach(el => {
            const f2 = f2ByElement[el.toUpperCase()];
            if (f2 != null && isFinite(f2)) sumF2 += counts[el] * f2;
        });
        return 2 * ELECTRON_RADIUS_CM * lambdaCm * sumF2 / volumeCm3;
    }

    // Radius (same length unit as the inputs) of the sphere of equal volume for
    // a box d1 x d2 x d3. A single dimension is treated as a diameter.
    static equivalentSphereRadius(dims) {
        const d = (dims || []).filter(x => isFinite(x) && x > 0);
        if (d.length === 0) return 0;
        if (d.length === 1) return d[0] / 2;
        return Math.cbrt(3 * d.reduce((a, b) => a * b, 1) / (4 * Math.PI));
    }

    // sin(theta) = lambda * |H*| / 2 from the reciprocal metric tensor.
    static sinTheta(h, k, l, cell, wavelength) {
        if (!cell || !(wavelength > 0)) return 0;
        const d2r = Math.PI / 180;
        const ca = Math.cos(cell.alpha * d2r), cb = Math.cos(cell.beta * d2r), cg = Math.cos(cell.gamma * d2r);
        const sa = Math.sin(cell.alpha * d2r), sb = Math.sin(cell.beta * d2r), sg = Math.sin(cell.gamma * d2r);
        const a = cell.a, b = cell.b, c = cell.c;
        const V = a * b * c * Math.sqrt(1 - ca * ca - cb * cb - cg * cg + 2 * ca * cb * cg);
        const astar = b * c * sa / V;
        const bstar = a * c * sb / V;
        const cstar = a * b * sg / V;
        const cosAst = (cb * cg - ca) / (sb * sg);
        const cosBst = (ca * cg - cb) / (sa * sg);
        const cosGst = (ca * cb - cg) / (sa * sb);
        const dstar2 = h * h * astar * astar + k * k * bstar * bstar + l * l * cstar * cstar
            + 2 * h * k * astar * bstar * cosGst
            + 2 * h * l * astar * cstar * cosBst
            + 2 * k * l * bstar * cstar * cosAst;
        return Math.min(1, wavelength * Math.sqrt(Math.max(0, dstar2)) / 2);
    }

    // Apply the correction to reflections [{h,k,l,Fo2,sigma?}, ...].
    // `mu` is cm^-1 and `radiusA` is in A. When `cell` and `wavelength` are
    // given (and the reflection has h,k,l) the theta-dependent factor is used,
    // otherwise the theta = 0 factor is applied uniformly.
    static apply(reflections, { mu, radiusA, cell, wavelength }) {
        if (!(mu >= 0)) throw new Error('mu (cm^-1) is required');
        if (!(radiusA >= 0)) throw new Error('radiusA (A) is required');
        const muR = mu * radiusA * 1e-8;
        const useTheta = !!(cell && wavelength > 0);
        let tmin = Infinity, tmax = -Infinity;
        const factorFor = (r) => {
            let T;
            if (useTheta && r && r.h != null && r.k != null && r.l != null) {
                const st = SphericalAbsorption.sinTheta(r.h, r.k, r.l, cell, wavelength);
                T = SphericalAbsorption.transmissionTheta(muR, Math.asin(st));
            } else {
                T = sphereFactor(muR);
            }
            if (T < tmin) tmin = T;
            if (T > tmax) tmax = T;
            return T > 0 ? 1 / T : 1;
        };
        const corrected = reflections.map(r => {
            const factor = factorFor(r);
            const out = { ...r };
            if (out.Fo2 != null) out.Fo2 = out.Fo2 * factor;
            if (out.Fc2 != null) out.Fc2 = out.Fc2 * factor;
            if (out.sigma != null) out.sigma = out.sigma * factor;
            return out;
        });
        return {
            reflections: corrected,
            muR,
            mu,
            muMm: mu / 10,
            radiusA,
            useTheta,
            Tmin: isFinite(tmin) ? tmin : sphereFactor(muR),
            Tmax: isFinite(tmax) ? tmax : sphereFactor(muR)
        };
    }

    static transmissionFor({ mu, radiusA }) {
        const muR = mu * radiusA * 1e-8;
        return { muR, A: sphereFactor(muR) };
    }
}

export default SphericalAbsorption;
