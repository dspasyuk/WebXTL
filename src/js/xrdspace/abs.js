// Copyright (c) 2026 Denis Spasyuk. MIT License.
// Multi-scan empirical absorption correction (SADABS / AIMLESS-style).
//
// Corrects intensity variations caused by X-ray absorption (and, as a by-
// product, scan-to-scan scale drift) using the redundancy of equivalent
// reflections measured at different crystal orientations.
//
// The absorption anisotropy is a smooth function of the direction in which a
// reflection is measured (the path length of the beam through the crystal
// depends on orientation). We model it as a spherical-harmonic expansion of the
// scale factor, following the method of AIMLESS by Paul R. Evans and
// Anthony W. McCoy (CCP4, Daresbury Laboratory):
//   P. R. Evans, A. W. McCoy, Acta Cryst. D66, 210-232 (2010).
//   Source: https://ccp4.sourceforge.net/aimless/
//   Spherical-harmonic basis and SD correction per sphericalharmonic.cpp and
//   sdctypes.hh in the AIMLESS source tree.
//
// Model (per observation):
//     ratio(hkl, s) = I_obs / <I>_set  ~=  sum_k a_k Y_k(dir_lab(hkl,s))
//                                          + sum_{s>0} d_s [run s]
// where dir_lab(hkl,s) is the unit direction of the scattering vector in the
// lab frame (q rotated by the scan's crystal->lab orientation), Y_k is the real
// spherical-harmonic basis (even l up to lmaxEven, odd l up to lmaxOdd, AIMLESS
// defaults 6 and 5), a_k are the absorption-surface coefficients, and d_s are
// per-run scale offsets (run 0 is the reference).
//
// The fit is a robust iteratively-reweighted least squares (IRLS): a Huber or
// ln-cosh loss downweights discordant observations and gross outliers are
// rejected, then the intensities are corrected and the set means recomputed,
// repeating until the coefficients converge.
//
// A per-run secondary-data (SD) sigma correction, also from AIMLESS, is
// applied at the end:
//     sigma' = SDfac * sqrt( sigma^2 + SDb*I + (SDadd*I)^2 )
// with (SDfac, SDb, SDadd) refined per run against the observed redundancy.

import { canonicalRep } from './op-math.js';
import { reciprocalCell } from './merge.js';

// ---------------------------------------------------------------------------
// Spherical harmonics (real form)
// ---------------------------------------------------------------------------

// Real spherical harmonics in the same term set AIMLESS uses: Y_00 plus, for
// each l = 1..lmax, m = l..0, the term Y_lm (m = 0) or the pair
// (Y_lm cos m phi, Y_lm sin m phi) (m > 0). Even l are included up to
// lmaxEven, odd l up to lmaxOdd. The coefficients use the orthonormal
// normalisation (integral over the sphere = 1), which keeps the design matrix
// well conditioned for the least-squares fit.
class SphericalHarmonic {
    constructor(lmaxEven = 6, lmaxOdd = 5) {
        this.lmaxEven = (lmaxEven / 2) * 2;             // force even
        this.lmaxOdd = ((lmaxOdd + 1) / 2) * 2 - 1;     // force odd
        this.lmax = Math.max(this.lmaxEven, this.lmaxOdd);
        this._basis = this._buildBasis();
    }

    // Number of basis terms (Y_00 + all higher terms).
    nTerms() { return this._basis.length; }

    // Evaluate the full basis at a unit direction [x, y, z]. Returns a
    // Float64Array of length nTerms().
    ylm(x, y, z) {
        const r = Math.sqrt(x * x + y * y + z * z) || 1;
        const ux = x / r, uy = y / r, uz = z / r;
        const ct = Math.max(-1, Math.min(1, uz));
        const st = Math.sqrt(Math.max(0, 1 - ct * ct));
        const ph = Math.atan2(uy, ux);
        const out = new Float64Array(this._basis.length);
        let i = 0;
        // Y_00
        out[i++] = 1 / Math.sqrt(4 * Math.PI);
        for (let l = 1; l <= this.lmax; l++) {
            const include = (l % 2 === 0) ? (l <= this.lmaxEven) : (l <= this.lmaxOdd);
            if (!include) continue;
            for (let m = l; m >= 0; m--) {
                const P = this._plm(l, m, ct, st);
                if (m > 0) {
                    const N = this._norm(l, m) * Math.SQRT2;
                    out[i++] = N * P * Math.cos(m * ph);
                    out[i++] = N * P * Math.sin(m * ph);
                } else {
                    out[i++] = this._norm(l, 0) * P;
                }
            }
        }
        return out;
    }

    // Build the (l, m, isSin) descriptor list used by ylm (cached once).
    _buildBasis() {
        const list = [{ l: 0, m: 0, sin: false }];
        for (let l = 1; l <= this.lmax; l++) {
            const include = (l % 2 === 0) ? (l <= this.lmaxEven) : (l <= this.lmaxOdd);
            if (!include) continue;
            for (let m = l; m >= 0; m--) {
                if (m > 0) { list.push({ l, m, sin: false }); list.push({ l, m, sin: true }); }
                else list.push({ l, m, sin: false });
            }
        }
        return list;
    }

    // Orthonormalisation constant: sqrt((2l+1)/4pi * (l-m)!/(l+m)!).
    _norm(l, m) {
        let ratio = 1;
        for (let j = l - m + 1; j <= l + m; j++) ratio /= j;
        return Math.sqrt((2 * l + 1) / (4 * Math.PI) * ratio);
    }

    // Associated Legendre P_l^m via the stable upward recurrence.
    // st = sin(theta) is passed in to avoid recomputing the sqrt.
    _plm(l, m, ct, st) {
        if (m === 0) {
            if (l === 0) return 1;
            if (l === 1) return ct;
            let pkm2 = 1, pkm1 = ct;
            for (let ll = 2; ll <= l; ll++) {
                const pk = ((2 * ll - 1) * ct * pkm1 - (ll - 1) * pkm2) / ll;
                pkm2 = pkm1; pkm1 = pk;
            }
            return pkm1;
        }
        let p = 1;
        for (let i = 0; i < m; i++) p *= -(2 * i + 1) * st;
        if (m === l) return p;
        let pkm2 = p, pkm1 = (2 * m + 1) * ct * p;
        if (m + 1 === l) return pkm1;
        for (let ll = m + 2; ll <= l; ll++) {
            const pk = ((2 * ll - 1) * ct * pkm1 - (ll + m - 1) * pkm2) / (ll - m);
            pkm2 = pkm1; pkm1 = pk;
        }
        return pkm1;
    }
}

// ---------------------------------------------------------------------------
// Data classes
// ---------------------------------------------------------------------------

// One crystal scan (image set). Holds its reflections, its crystal->lab
// reciprocal orientation matrix, and its per-run SD correction parameters.
class ScanData {
    constructor(scanIndex, orientation = null) {
        this.scanIndex = scanIndex;
        this.reflections = [];
        // Orientation matrix mapping Miller indices directly to the lab-frame
        // scattering vector: q_lab = O . (h,k,l). For Bruker P4P input this is
        // the reciprocal orientation matrix written on the ORT1/ORT2/ORT3 lines
        // (verified: |O.(h,k,l)| = 1/d). null = use the crystal-frame direction
        // from the reciprocal metric.
        this.orientation = orientation;
        // Secondary-data (sigma) correction parameters, AIMLESS SDcorrection.
        this.sdfac = 1.0;
        this.sdb = 0.0;
        this.sdadd = 0.0;
    }

    addReflection(h, k, l, I, sig, psi) {
        this.reflections.push({ h, k, l, I, sig: sig || 1, psi: psi || 0 });
    }

    get count() { return this.reflections.length; }

    // AIMLESS SD correction: sigma' = SDfac * sqrt(sigma^2 + SDb*I + (SDadd*I)^2).
    sigmaPrime(sigma, I) {
        const arg = sigma * sigma + this.sdb * I + (this.sdadd * I) * (this.sdadd * I);
        return this.sdfac * Math.sqrt(Math.max(0, arg));
    }
}

// A set of observations equivalent under the Laue group. Each member keeps a
// reference to the live reflection object, so corrected intensities are seen
// by the next fit iteration.
class EquivalentSet {
    constructor(rep) {
        this.rep = rep;
        this.members = [];
    }

    get nScans() {
        const s = new Set();
        for (const m of this.members) if (!m.rejected) s.add(m.scanIndex);
        return s.size;
    }

    get nMembers() { return this.members.length; }

    // 1/sigma^2 weighted mean intensity over the non-rejected members.
    meanIntensity() {
        let ws = 0, w = 0;
        for (const m of this.members) {
            if (m.rejected) continue;
            const r = m.refl;
            if (r.sig > 0) { const wi = 1 / (r.sig * r.sig); ws += r.I * wi; w += wi; }
        }
        return w > 0 ? ws / w : NaN;
    }
}

// ---------------------------------------------------------------------------
// Main correction engine
// ---------------------------------------------------------------------------

class MultiScanAbsorptionCorr {
    constructor(options = {}) {
        this.lmaxEven = options.lmaxEven ?? 6;
        this.lmaxOdd = options.lmaxOdd ?? 5;
        this.maxIter = options.maxIterations ?? 30;
        this.convThreshold = options.convergenceThreshold ?? 1e-3;
        this.minScans = options.minScans ?? 2;
        this.minMembers = options.minMembers ?? 2;
        this.minGroups = options.minGroups ?? 10;
        this.minScale = options.minScale ?? 0.05;   // floor on the fitted scale
        this.useSD = options.useSD !== false;        // apply per-run SD correction
        // Robust fit controls.
        this.robust = options.robust !== false;      // IRLS reweighting on/off
        this.robustLoss = options.robustLoss ?? 'lncosh'; // 'lncosh' | 'huber'
        this.huberK = options.huberK ?? 1.5;         // Huber knee (robust sigma units)
        this.outlierSigma = options.outlierSigma ?? 6.0; // hard-reject threshold
        this.maxIrls = options.maxIrls ?? 8;         // inner IRLS iterations
        this._sh = new SphericalHarmonic(this.lmaxEven, this.lmaxOdd);
        this._scans = new Map();
        this._scanList = [];
        this._groups = new Map();
        this._recip = null;
        this._coeffs = null;      // [a_0..a_{nTerms-1}, d_1..d_{N-1}]
        this._runOffset = new Map();
        this.converged = false;
        this.iterations = 0;
        this.nRejected = 0;
    }

    // Register one scan's reflections. `orientation` is an optional 3x3 matrix
    // mapping Miller indices directly to the lab-frame scattering vector.
    addScan(scanIndex, reflections, orientation = null) {
        const sd = new ScanData(scanIndex, orientation);
        for (const r of reflections) {
            if (r.rejected) continue;
            sd.addReflection(r.h, r.k, r.l, r.I, r.sig, r.psi);
        }
        this._scans.set(scanIndex, sd);
    }

    // Set the unit cell so the scattering-vector direction uses the true
    // reciprocal metric (used only when no orientation matrix is supplied).
    setCell(cell) {
        this._recip = cell ? reciprocalCell(cell) : null;
    }

    // Unit direction of the scattering vector in the LAB frame.
    // If an orientation matrix is given (P4P ORT), it maps (h,k,l) directly to
    // q_lab (it already contains the reciprocal metric). Otherwise the
    // crystal-frame reciprocal vector q = h a* + k b* + l c* is built from the
    // cell metric and used directly (identity orientation approximation).
    _directionOf(h, k, l, orientation = null) {
        let qx, qy, qz;
        if (orientation) {
            qx = orientation[0][0] * h + orientation[0][1] * k + orientation[0][2] * l;
            qy = orientation[1][0] * h + orientation[1][1] * k + orientation[1][2] * l;
            qz = orientation[2][0] * h + orientation[2][1] * k + orientation[2][2] * l;
        } else {
            const r = this._recip;
            if (!r) {
                qx = h; qy = k; qz = l;
            } else {
                const A = 1 / r.aS, B = 1 / r.bS, C = 1 / r.cS;
                const sinG = Math.sqrt(Math.max(0, 1 - r.cosG * r.cosG));
                const bx = B * r.cosG, by = B * sinG;
                const cx = C * r.cosB;
                const cy = C * (r.cosA - r.cosB * r.cosG) / sinG;
                const cz = C * Math.sqrt(Math.max(0, 1 - r.cosB * r.cosB - r.cosA * r.cosA
                    - r.cosG * r.cosG + 2 * r.cosA * r.cosB * r.cosG)) / sinG;
                qx = h * A + k * bx + l * cx;
                qy = k * by + l * cy;
                qz = l * cz;
            }
        }
        const m = Math.sqrt(qx * qx + qy * qy + qz * qz);
        return m > 1e-12 ? [qx / m, qy / m, qz / m] : [0, 0, 1];
    }

    // Precompute, once per reflection: the lab direction, the cached
    // spherical-harmonic basis vector, and the ORIGINAL intensity/sigma (the
    // correction is applied against these, never compounding).
    _prepare() {
        for (const [, sd] of this._scans) {
            for (const r of sd.reflections) {
                const [dx, dy, dz] = this._directionOf(r.h, r.k, r.l, sd.orientation);
                r.dx = dx; r.dy = dy; r.dz = dz;
                r.sh = this._sh.ylm(dx, dy, dz);
                r.I0 = r.I;
                r.sig0 = r.sig;
                r.logI0 = r.I > 0 ? Math.log(r.I) : null;
                // Log-space weight: Var(log I) ~ (sigma/I)^2.
                r.w0 = (r.I > 0 && r.sig > 0) ? (r.I / r.sig) * (r.I / r.sig) : 0;
            }
        }
    }

    // Group observations into Laue-equivalent sets.
    _matchEquivalents(laueOps) {
        this._groups = new Map();
        this._scanList = [...this._scans.keys()].sort((a, b) => a - b);
        for (const [scanIdx, sd] of this._scans) {
            for (const r of sd.reflections) {
                const { rep } = canonicalRep([r.h, r.k, r.l], laueOps);
                const key = rep[0] + ',' + rep[1] + ',' + rep[2];
                let g = this._groups.get(key);
                if (!g) { g = new EquivalentSet(rep); this._groups.set(key, g); }
                g.members.push({
                    refl: r,
                    scanIndex: scanIdx,
                    weight: r.w0,
                    rejected: false,
                });
            }
        }
        for (const [key, g] of this._groups) {
            if (g.nScans < this.minScans || g.nMembers < this.minMembers) {
                this._groups.delete(key);
            }
        }
    }

    // Initialise each group's log "true intensity" G_g = robust (median) log(I0).
    _initGroups() {
        for (const g of this._groups.values()) g.G = this._groupG(g);
    }

    // Group log "true intensity": weighted mean of (log I0 - logScale) over the
    // non-rejected members. (Outlier rejection itself lives in the robust fit;
    // see _robustFit.)
    _groupG(g) {
        let ws = 0, w = 0;
        for (const m of g.members) {
            const r = m.refl;
            if (m.rejected || r.logI0 == null) continue;
            const ls = this._logScale ? this._logScale(r.sh, m.scanIndex) : 0;
            if (!Number.isFinite(ls)) continue;
            const wi = r.w0 > 0 ? r.w0 : 1;
            ws += (r.logI0 - ls) * wi;
            w += wi;
        }
        return w > 0 ? ws / w : NaN;
    }

    // Build the log-space design for one fit pass.
    //   target_i = log(I0_i) - G_g          (the scale, in log space)
    //   row_i    = [Y_1 .. Y_{nTerms-1}(dir_i), one-hot run offsets (runs 1..N-1)]
    // The Y_00 term is omitted (fixed at 0) and run 0 is the reference, so the
    // per-group G absorbs the global level (no rank deficiency).
    // Returns the aligned member array alongside the rows.
    // Build the log-space design ONCE. The design matrix A (SH basis + run
    // one-hot) depends only on reflection directions and scan assignments, both
    // of which are fixed after _matchEquivalents; the set of finite-G groups is
    // likewise fixed (_groupG only ever assigns finite values). So A and baseW
    // are constant across all outer iterations — only y (which depends on the
    // per-group G) changes. Building A once instead of every iteration is the
    // dominant cost saving for large multi-scan datasets.
    //   y_i = log(I0_i) - G_{g(i)}      (the scale, in log space)
    //   row_i = [Y_1 .. Y_{nTerms-1}(dir_i), one-hot run offsets (runs 1..N-1)]
    // The Y_00 term is omitted (fixed at 0) and run 0 is the reference, so the
    // per-group G absorbs the global level (no rank deficiency).
    // Stores the fixed parts on this._design; y is recomputed each pass via
    // _updateY().
    _buildDesign() {
        const nTerm = this._sh.nTerms();
        const nRun = this._scanList.length;
        const nCol = (nTerm - 1) + (nRun - 1);
        const runCol = new Map();
        for (let s = 1; s < nRun; s++) runCol.set(this._scanList[s], (nTerm - 1) + (s - 1));
        // Two passes: count active rows, then fill one CONTIGUOUS buffer. A
        // single flat allocation is far cheaper than one Float64Array per row
        // (70k+ small objects) and gives the _lsq inner loop cache-friendly
        // sequential access.
        let n = 0;
        for (const g of this._groups.values()) {
            if (!Number.isFinite(g.G)) continue;
            for (const m of g.members) {
                const r = m.refl;
                if (r.w0 > 0 && r.logI0 != null) n++;
            }
        }
        const A = new Float64Array(n * nCol);
        const baseW = new Float64Array(n);
        const members = new Array(n);
        const gOf = new Array(n);
        let i = 0;
        for (const g of this._groups.values()) {
            if (!Number.isFinite(g.G)) continue;
            for (const m of g.members) {
                const r = m.refl;
                if (r.w0 <= 0 || r.logI0 == null) continue;
                const base = i * nCol;
                for (let k = 1; k < nTerm; k++) A[base + k - 1] = r.sh[k];
                const rc = runCol.get(m.scanIndex);
                if (rc !== undefined) A[base + rc] = 1;
                baseW[i] = r.w0;
                members[i] = m;
                gOf[i] = g;
                i++;
            }
        }
        this._design = { A, baseW, members, gOf, nCol, n };
        this._y = new Float64Array(n);
        this._updateY();
        return this._design;
    }

    // Recompute y_i = log(I0_i) - G_{g(i)} from the current group G values.
    // Cheap (O(n)); called once per outer iteration.
    _updateY() {
        const d = this._design, y = this._y;
        for (let i = 0; i < d.n; i++) y[i] = d.members[i].refl.logI0 - d.gOf[i].G;
    }

    // Weighted least squares (A^T W A) c = A^T W y with Tikhonov damping,
    // solved by Gaussian elimination with partial pivoting. A is a flat
    // row-major buffer of n x nCol (row i at offset i*nCol).
    _lsq(A, w, y, nCol, n) {
        const c = new Float64Array(nCol);
        if (n === 0) return c;
        const ATA = new Float64Array(nCol * nCol);
        const ATy = new Float64Array(nCol);
        for (let i = 0; i < n; i++) {
            const wi = w[i];
            if (wi <= 0) continue;
            const base = i * nCol;
            const yi = y[i];
            for (let a = 0; a < nCol; a++) {
                const va = A[base + a];
                ATy[a] += wi * va * yi;
                for (let b = a; b < nCol; b++) ATA[a * nCol + b] += wi * va * A[base + b];
            }
        }
        for (let a = 0; a < nCol; a++) {
            for (let b = 0; b < a; b++) ATA[a * nCol + b] = ATA[b * nCol + a];
            ATA[a * nCol + a] += 1e-8;   // Tikhonov regularisation
        }
        const M = new Float64Array(ATA);
        const rhs = new Float64Array(ATy);
        for (let col = 0; col < nCol; col++) {
            let pivot = col;
            for (let row = col + 1; row < nCol; row++) {
                if (Math.abs(M[row * nCol + col]) > Math.abs(M[pivot * nCol + col])) pivot = row;
            }
            if (Math.abs(M[pivot * nCol + col]) < 1e-14) continue;
            if (pivot !== col) {
                for (let j = col; j < nCol; j++) {
                    const t = M[col * nCol + j]; M[col * nCol + j] = M[pivot * nCol + j]; M[pivot * nCol + j] = t;
                }
                const t = rhs[col]; rhs[col] = rhs[pivot]; rhs[pivot] = t;
            }
            for (let row = col + 1; row < nCol; row++) {
                const f = M[row * nCol + col] / M[col * nCol + col];
                if (Math.abs(f) < 1e-15) continue;
                for (let j = col; j < nCol; j++) M[row * nCol + j] -= f * M[col * nCol + j];
                rhs[row] -= f * rhs[col];
            }
        }
        for (let row = nCol - 1; row >= 0; row--) {
            let s = rhs[row];
            for (let j = row + 1; j < nCol; j++) s -= M[row * nCol + j] * c[j];
            c[row] = Math.abs(M[row * nCol + row]) > 1e-14 ? s / M[row * nCol + row] : 0;
        }
        return c;
    }

    // Robust iteratively-reweighted least squares (log space).
    //   The residual is the log-scale difference, z-standardised by the
    //   observation's relative error:
    //       z_i = |log(I0_i) - G_g - model_i| * (I0_i / sigma_i)
    //   Discordant points get a downweighting factor from the chosen loss
    //   (ln-cosh: sech^2(z); Huber: min(1, k/|z|)); gross outliers
    //   (|z| > outlierSigma) are hard-rejected and marked on the member.
    // Returns { c, nRejected }.
    _robustFit(A, baseW, y, nCol, members, n) {
        let w = Float64Array.from(baseW);
        let c = this._lsq(A, w, y, nCol, n);
        if (!this.robust || n === 0) return { c, nRejected: 0 };
        let nRejected = 0;
        const res = new Float64Array(n);
        // relErr = sigma/I is constant across IRLS iterations; precompute it
        // once instead of re-dividing for every observation on every iteration.
        const relErr = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const m = members[i];
            const r = m && m.refl ? m.refl : null;
            relErr[i] = (r && r.I0 > 0 && r.sig0 > 0) ? r.sig0 / r.I0 : Infinity;
        }
        for (let it = 0; it < this.maxIrls; it++) {
            nRejected = 0;
            for (let i = 0; i < n; i++) {
                let p = 0;
                const base = i * nCol;
                for (let k = 0; k < nCol; k++) p += A[base + k] * c[k];
                res[i] = y[i] - p;
            }
            const abs = Array.from(res, Math.abs).sort((a, b) => a - b);
            const sMad = 1.4826 * (abs[abs.length >> 1] || 1e-12);
            for (let i = 0; i < n; i++) {
                const m = members[i];
                const s = Math.max(isFinite(relErr[i]) ? relErr[i] : 0, sMad, 1e-12);
                const z = Math.abs(res[i]) / s;
                if (z > this.outlierSigma) {
                    w[i] = 0;
                    if (m) m.rejected = true;
                    nRejected++;
                    continue;
                }
                let f;
                if (this.robustLoss === 'huber') {
                    f = z <= this.huberK ? 1 : this.huberK / z;
                } else { // ln-cosh IRLS weight = sech^2(z)
                    const ch = Math.cosh(z);
                    f = 1 / (ch * ch);
                    if (f < 1e-6) f = 1e-6;
                }
                w[i] = baseW[i] * f;
            }
            const c2 = this._lsq(A, w, y, nCol, n);
            let d = 0, mm = 0;
            for (let k = 0; k < nCol; k++) { d += (c2[k] - c[k]) * (c2[k] - c[k]); mm += c[k] * c[k]; }
            c = c2;
            if (Math.sqrt(d) / (Math.sqrt(mm) + 1e-12) < 1e-6) break;
        }
        return { c, nRejected };
    }

    // Fitted log-scale for one observation, from its cached basis.
    _logScale(sh, scanIndex) {
        if (!this._a) return 0;
        let v = 0;
        const nTerm = this._sh.nTerms();
        for (let k = 1; k < nTerm; k++) v += this._a[k] * sh[k];
        const off = this._runOffset.get(scanIndex);
        if (off !== undefined) v += off;
        return v;
    }

    // Apply the fitted scale to every observation (against the ORIGINAL I/sig,
    // so iterations never compound the correction).
    _applyCorrection() {
        for (const [si, sd] of this._scans) {
            for (const r of sd.reflections) {
                if (r.sig0 <= 0 || !(r.I0 > 0)) continue;
                const ls = this._logScale(r.sh, si);
                if (!Number.isFinite(ls)) continue;
                let factor = Math.exp(ls);           // scale = T(dir) * run_scale
                if (!(factor > this.minScale)) factor = this.minScale;
                r.I = r.I0 / factor;
                r.sig = r.sig0 / factor;
            }
        }
    }

    // Per-run SD (sigma) correction refinement. Fits the three parameters
    // (p1 = SDfac^2, p2 = SDfac^2*SDb, p3 = SDfac^2*SDadd^2) so that the
    // modelled variance sigma'^2 = p1*sig^2 + p2*I + p3*I^2 matches the
    // observed scatter of the equivalent sets (damped Gauss-Newton, numerical
    // Jacobian; the system is 3-dimensional so this is cheap).
    _refineSD() {
        for (const [si, sd] of this._scans) {
            // Observations with their set mean, for this run only.
            const obs = [];
            for (const g of this._groups.values()) {
                const mean = g.meanIntensity();
                if (!Number.isFinite(mean) || mean <= 0) continue;
                for (const m of g.members) {
                    if (m.scanIndex !== si || m.rejected) continue;
                    const r = m.refl;
                    if (r.sig0 <= 0) continue;
                    obs.push({ sig: r.sig0, I: r.I, Iav: mean });
                }
            }
            if (obs.length < 6) continue;
            let p = [sd.sdfac * sd.sdfac, sd.sdfac * sd.sdfac * sd.sdb,
                sd.sdfac * sd.sdfac * sd.sdadd * sd.sdadd];
            const modelVar = (q, o) => Math.max(1e-8, q[0] * o.sig * o.sig + q[1] * o.Iav + q[2] * o.Iav * o.Iav);
            const residual = (q) => {
                let r = 0;
                for (const o of obs) {
                    const obsVar = (o.I - o.Iav) * (o.I - o.Iav);
                    const mv = modelVar(q, o);
                    const d = (obsVar - mv) / mv;
                    r += d * d;
                }
                return r;
            };
            for (let it = 0; it < 30; it++) {
                const R0 = residual(p);
                // Numerical Jacobian of the residual components.
                const eps = 1e-6;
                const JtJ = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
                const Jtr = [0, 0, 0];
                const comp = (q) => {
                    const out = new Array(obs.length);
                    for (let i = 0; i < obs.length; i++) {
                        const o = obs[i];
                        const mv = modelVar(q, o);
                        const obsVar = (o.I - o.Iav) * (o.I - o.Iav);
                        out[i] = (obsVar - mv) / mv;
                    }
                    return out;
                };
                const f0 = comp(p);
                const cols = [];
                for (let k = 0; k < 3; k++) {
                    const q = p.slice(); q[k] += eps;
                    const fk = comp(q);
                    const col = new Array(f0.length);
                    for (let i = 0; i < f0.length; i++) col[i] = (fk[i] - f0[i]) / eps;
                    cols.push(col);
                }
                for (let a = 0; a < 3; a++) {
                    for (let i = 0; i < f0.length; i++) Jtr[a] += cols[a][i] * f0[i];
                    for (let b = 0; b < 3; b++) {
                        for (let i = 0; i < f0.length; i++) JtJ[a][b] += cols[a][i] * cols[b][i];
                    }
                }
                for (let a = 0; a < 3; a++) JtJ[a][a] += 1e-6;
                // Solve JtJ * step = -Jtr (damped).
                const M = new Array(3);
                for (let i = 0; i < 3; i++) M[i] = JtJ[i].slice();
                const rhs = new Array(3);
                for (let i = 0; i < 3; i++) rhs[i] = -Jtr[i];
                for (let col = 0; col < 3; col++) {
                    let pv = col;
                    for (let row = col + 1; row < 3; row++) if (Math.abs(M[row][col]) > Math.abs(M[pv][col])) pv = row;
                    if (Math.abs(M[pv][col]) < 1e-14) continue;
                    [M[col], M[pv]] = [M[pv], M[col]]; [rhs[col], rhs[pv]] = [rhs[pv], rhs[col]];
                    for (let row = col + 1; row < 3; row++) {
                        const f = M[row][col] / M[col][col];
                        for (let j = col; j < 3; j++) M[row][j] -= f * M[col][j];
                        rhs[row] -= f * rhs[col];
                    }
                }
                const step = [0, 0, 0];
                for (let row = 2; row >= 0; row--) {
                    let s = rhs[row];
                    for (let j = row + 1; j < 3; j++) s -= M[row][j] * step[j];
                    step[row] = Math.abs(M[row][row]) > 1e-14 ? s / M[row][row] : 0;
                }
                const cand = new Array(3);
                for (let k = 0; k < 3; k++) cand[k] = p[k] + step[k];
                if (residual(cand) < R0) p = cand;
                else for (let k = 0; k < 3; k++) p[k] += 0.5 * step[k];
                if (Math.hypot(step[0], step[1], step[2]) < 1e-8) break;
            }
            // Unpack, keeping the variance model physical (p1 > 0).
            const p1 = Math.max(1e-6, p[0]);
            const p2 = Math.max(0, p[1]);
            const p3 = Math.max(0, p[2]);
            sd.sdfac = Math.sqrt(p1);
            sd.sdb = p2 / p1;
            sd.sdadd = Math.sqrt(p3) / p1;
        }
    }

    run(laueOps) {
        if (this._scans.size < this.minScans) {
            return { ok: false, error: 'NEED_MORE_SCANS',
                detail: `Absorption correction needs at least ${this.minScans} scans; got ${this._scans.size}.` };
        }
        let total = 0;
        for (const sd of this._scans.values()) total += sd.count;
        if (total === 0) {
            return { ok: false, error: 'NO_REFLECTIONS', detail: 'No reflections to correct.' };
        }
        this._prepare();
        this._matchEquivalents(laueOps);
        if (this._groups.size < this.minGroups) {
            return { ok: false, error: 'TOO_FEW_EQUIV',
                detail: `Only ${this._groups.size} multi-scan equivalent sets found (need >= ${this.minGroups}).` };
        }

        const nTerm = this._sh.nTerms();
        const nRun = this._scanList.length;
        this.converged = false;
        this.iterations = 0;
        this.nRejected = 0;
        this._initGroups();
        // The design matrix A and base weights depend only on directions and
        // scan assignments (fixed after _matchEquivalents), so build them ONCE;
        // each iteration only recomputes y (which tracks the per-group G).
        const { A, baseW, members, nCol, n } = this._buildDesign();
        if (!n) {
            return { ok: false, error: 'NO_USABLE_ROWS', detail: 'No usable observations for the fit.' };
        }
        let prev = null;

        for (let iter = 0; iter < this.maxIter; iter++) {
            this.iterations = iter + 1;
            // Re-admit members each pass: rejection is recomputed from the
            // current model, so transient rejections early on do not stick.
            for (const g of this._groups.values()) for (const m of g.members) m.rejected = false;
            // Alternating least squares:
            //   (1) given the group log-intensities G, fit the scale model;
            //   (2) given the scale model, update G = mean(log I0 - logScale).
            this._updateY();
            const { c } = this._robustFit(A, baseW, this._y, nCol, members, n);
            this._a = new Float64Array(nTerm);
            for (let k = 1; k < nTerm; k++) this._a[k] = c[k - 1];
            this._runOffset = new Map();
            for (let s = 1; s < nRun; s++) this._runOffset.set(this._scanList[s], c[(nTerm - 1) + (s - 1)]);
            // Update group log-intensities (robust median).
            for (const g of this._groups.values()) {
                const G = this._groupG(g);
                if (Number.isFinite(G)) g.G = G;
            }
            this._applyCorrection();
            if (prev) {
                let d = 0, m = 0;
                for (let i = 0; i < c.length; i++) { d += (c[i] - prev[i]) * (c[i] - prev[i]); m += prev[i] * prev[i]; }
                const rel = Math.sqrt(d) / (Math.sqrt(m) + 1e-12);
                if (rel < this.convThreshold) { this.converged = true; break; }
            }
            prev = c;
        }
        // Cumulative rejected outliers.
        let rej = 0;
        for (const g of this._groups.values()) for (const m of g.members) if (m.rejected) rej++;
        this.nRejected = rej;

        // Typical (geometric-mean) scale over all observations.
        let sumLs = 0, nLs = 0;
        for (const [si, sd] of this._scans) {
            for (const r of sd.reflections) {
                if (r.sig0 <= 0 || !(r.I0 > 0)) continue;
                const ls = this._logScale(r.sh, si);
                if (Number.isFinite(ls)) { sumLs += ls; nLs++; }
            }
        }
        const overallScale = nLs ? Math.exp(sumLs / nLs) : 1;

        // Final per-run SD sigma correction.
        const sdParams = {};
        if (this.useSD) {
            this._refineSD();
            for (const [si, sd] of this._scans) {
                for (const r of sd.reflections) {
                    if (r.sig <= 0) continue;
                    r.sig = sd.sigmaPrime(r.sig, r.I);
                }
                sdParams[String(si)] = { sdfac: sd.sdfac, sdb: sd.sdb, sdadd: sd.sdadd };
            }
        }

        // Full coefficient vector: [a_0=0, a_1..a_{nTerm-1}, d_1..d_{N-1}].
        const full = [0];
        for (let k = 1; k < nTerm; k++) full.push(this._a[k]);
        for (let s = 1; s < nRun; s++) full.push(this._runOffset.get(this._scanList[s]) || 0);

        return {
            ok: true,
            converged: this.converged,
            iterations: this.iterations,
            nScans: this._scans.size,
            nEquivalentSets: this._groups.size,
            nTerms: nTerm,
            lmaxEven: this.lmaxEven,
            lmaxOdd: this.lmaxOdd,
            robustLoss: this.robust ? this.robustLoss : 'none',
            nRejected: this.nRejected,
            overallScale,
            absorptionCoeffs: full,
            runOffsets: Object.fromEntries(this._runOffset),
            sdParams,
            stats: this._computeStats(),
        };
    }

    _computeStats() {
        let n = 0, sumI = 0, sumSig = 0;
        let rMergeNum = 0, rMergeDen = 0;
        for (const g of this._groups.values()) {
            const mean = g.meanIntensity();
            if (!Number.isFinite(mean) || Math.abs(mean) < 1e-12) continue;
            for (const m of g.members) {
                if (m.rejected) continue;
                rMergeNum += Math.abs(m.refl.I - mean);
                rMergeDen += Math.abs(mean);
            }
        }
        for (const sd of this._scans.values()) {
            for (const r of sd.reflections) {
                if (r.sig <= 0) continue;
                n++; sumI += Math.abs(r.I); sumSig += r.sig;
            }
        }
        return {
            nReflections: n,
            meanIntensity: n ? sumI / n : 0,
            meanSigma: n ? sumSig / n : 0,
            rMergeAfter: rMergeDen > 0 ? rMergeNum / rMergeDen : 0,
        };
    }

    getCorrectedReflections() {
        const out = [];
        for (const [si, sd] of this._scans) {
            for (const r of sd.reflections) {
                out.push({ h: r.h, k: r.k, l: r.l, I: r.I, sig: r.sig, psi: r.psi, scanIndex: si });
            }
        }
        return out;
    }
}

// ---------------------------------------------------------------------------
// Convenience: one-shot correction
// ---------------------------------------------------------------------------

/**
 * Run multi-scan absorption correction over a set of scans.
 *
 * @param scans   Map<scanIndex, reflections[]> | reflections[][] |
 *                Array<{reflections, orientation?}> | {[idx]: reflections[]}
 * @param cell    {a,b,c,alpha,beta,gamma} (enables true reciprocal directions)
 * @param laueOps Laue-group ops (from laue.js buildLaueGroups)
 * @param options { lmaxEven, lmaxOdd, maxIterations, convergenceThreshold,
 *                  minScans, minMembers, minGroups, minScale, useSD,
 *                  robust, robustLoss, huberK, outlierSigma, maxIrls }
 * @returns { ok, error?, detail?, converged?, iterations?, nScans?, nEquivalentSets?,
 *            overallScale?, absorptionCoeffs?, runOffsets?, sdParams?, stats?,
 *            nRejected?, correctedReflections? }
 */
function runAbsorptionCorrection(scans, cell, laueOps, options = {}) {
    const corr = new MultiScanAbsorptionCorr(options);
    corr.setCell(cell || null);
    if (scans instanceof Map) {
        for (const [idx, refls] of scans) corr.addScan(idx, refls);
    } else if (Array.isArray(scans)) {
        scans.forEach((entry, i) => {
            if (entry && Array.isArray(entry.reflections)) corr.addScan(i, entry.reflections, entry.orientation || null);
            else corr.addScan(i, entry);
        });
    } else if (scans && typeof scans === 'object') {
        for (const key of Object.keys(scans)) corr.addScan(Number(key), scans[key]);
    }
    const result = corr.run(laueOps);
    if (result.ok) result.correctedReflections = corr.getCorrectedReflections();
    return result;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function buildAbsorptionReport(result, cell) {
    if (!result.ok) return `Absorption correction: ${result.error} - ${result.detail || ''}`;
    const L = [];
    L.push('Multi-scan absorption correction (AIMLESS method)');
    L.push('Method: P. R. Evans & A. W. McCoy, Acta Cryst. D66, 210 (2010)');
    L.push('=========================================================');
    L.push(`Converged          : ${result.converged ? 'yes' : 'no'}`);
    L.push(`Iterations         : ${result.iterations}`);
    L.push(`Number of scans    : ${result.nScans}`);
    L.push(`Equivalent sets    : ${result.nEquivalentSets}`);
    L.push(`SH basis terms     : ${result.nTerms}  (lmaxEven=${result.lmaxEven}, lmaxOdd=${result.lmaxOdd})`);
    L.push(`Robust fit         : ${result.robustLoss}${result.nRejected ? `  (${result.nRejected} outliers rejected)` : ''}`);
    L.push(`Overall scale      : ${result.overallScale.toFixed(6)}`);
    L.push('');
    if (Object.keys(result.runOffsets || {}).length) {
        L.push('Per-run scale offsets (run 0 = reference):');
        for (const [run, off] of Object.entries(result.runOffsets)) {
            L.push(`  Run ${String(run).padEnd(4)} : ${off.toFixed(6)}`);
        }
        L.push('');
    }
    if (result.sdParams && Object.keys(result.sdParams).length) {
        L.push('Per-run SD (sigma) correction  sigma\' = SDfac*sqrt(s^2 + SDb I + (SDadd I)^2):');
        for (const [run, p] of Object.entries(result.sdParams)) {
            L.push(`  Run ${String(run).padEnd(4)} : SDfac=${p.sdfac.toFixed(4)}  SDb=${p.sdb.toFixed(4)}  SDadd=${p.sdadd.toFixed(4)}`);
        }
        L.push('');
    }
    if (result.stats) {
        L.push(`Reflections corrected : ${result.stats.nReflections}`);
        L.push(`Mean I (corrected)    : ${result.stats.meanIntensity.toFixed(2)}`);
        L.push(`Mean sigma (corrected): ${result.stats.meanSigma.toFixed(2)}`);
        L.push(`R(merge) after        : ${(result.stats.rMergeAfter * 100).toFixed(2)} %`);
    }
    L.push('');
    L.push('The corrected intensities/sigmas are ready for merging.');
    return L.join('\n');
}

export {
    SphericalHarmonic,
    ScanData,
    EquivalentSet,
    MultiScanAbsorptionCorr,
    runAbsorptionCorrection,
    buildAbsorptionReport,
};
