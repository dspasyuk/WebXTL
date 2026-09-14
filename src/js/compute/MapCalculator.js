
import * as THREE from 'three';
import { Symmetry } from '../utils/Symmetry.js';

export class MapCalculator {
    constructor() {
        // Basic scattering factors coefficients (Cromer-Mann)
        // Element: [a1, b1, a2, b2, a3, b3, a4, b4, c]
        this.sfCoeffs = {
            'H': [0.493002, 10.5109, 0.322912, 26.1257, 0.140191, 3.14236, 0.040810, 57.7997, 0.003038],
            'C': [2.31000, 20.8439, 1.02000, 10.2075, 1.58860, 0.568700, 0.865000, 51.6512, 0.215600],
            'N': [2.5454, 17.6377, 1.1149, 7.4845, 1.4859, 0.4857, 0.6631, 41.2498, 0.1911],
            'O': [3.04850, 13.2771, 2.28680, 5.70110, 1.54630, 0.323900, 0.867000, 32.9089, 0.250800],
            'F': [3.53920, 10.2825, 2.64120, 4.29440, 1.51700, 0.261500, 1.02430, 26.1476, 0.277600],
            'S': [6.90530, 1.46790, 5.20340, 22.2151, 1.43790, 0.253600, 1.58630, 56.1720, 0.866900],
            'Cl': [11.4304, 14.0290, 3.44200, 3.22040, 1.55580, 0.220600, 0.555400, 32.2096, 0.009600]
        };
    }

    getScatteringFactor(element, s2) {
        const c = this.sfCoeffs[element] || this.sfCoeffs['C']; // Fallback to C
        let f = c[8];
        for (let i = 0; i < 4; i++) {
            f += c[i * 2] * Math.exp(-c[i * 2 + 1] * s2);
        }
        return f;
    }

    calculateStructureFactors(atoms, reflections, cell) {
        const d2r = Math.PI / 180.0;
        const ca = Math.cos(cell.alpha * d2r);
        const cb = Math.cos(cell.beta * d2r);
        const cc = Math.cos(cell.gamma * d2r);
        const sa = Math.sin(cell.alpha * d2r);
        const sb = Math.sin(cell.beta * d2r);
        const sc = Math.sin(cell.gamma * d2r);
        
        const V = cell.a * cell.b * cell.c * Math.sqrt(1 - ca*ca - cb*cb - cc*cc + 2*ca*cb*cc);
        
        const a_star = (cell.b * cell.c * sa) / V;
        const b_star = (cell.a * cell.c * sb) / V;
        const c_star = (cell.a * cell.b * sc) / V;
        const cos_alpha_star = (cb * cc - ca) / (sb * sc);
        const cos_beta_star = (ca * cc - cb) / (sa * sc);
        const cos_gamma_star = (ca * cb - cc) / (sa * sb);

        // Flatten the element scattering coefficients into typed arrays so the
        // inner loop does not recompute f(s2) for every atom of an element.
        const els = Object.keys(this.sfCoeffs);
        const E = els.length;
        const elIndex = new Map();
        els.forEach((e, i) => elIndex.set(e, i));
        const coef = new Float64Array(E * 9);
        els.forEach((e, i) => {
            const c = this.sfCoeffs[e];
            for (let j = 0; j < 9; j++) coef[i * 9 + j] = c[j];
        });
        const fallback = elIndex.has('C') ? elIndex.get('C') : 0;

        // Flatten atoms once (avoids repeated property lookups and per-atom
        // coefficient work in the hot loop).
        const n = atoms.length;
        const ax = new Float64Array(n), ay = new Float64Array(n), az = new Float64Array(n);
        const aocc = new Float64Array(n), ael = new Int32Array(n), atk = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const a = atoms[i];
            ax[i] = a.x; ay[i] = a.y; az[i] = a.z;
            aocc[i] = a.occupancy != null ? a.occupancy : 1;
            ael[i] = elIndex.has(a.element) ? elIndex.get(a.element) : fallback;
            atk[i] = -8 * Math.PI * Math.PI * (a.uiso || 0);
        }
        const fCache = new Float64Array(E);
        const twoPi = 2 * Math.PI;

        for (let r = 0; r < reflections.length; r++) {
            const refl = reflections[r];
            const h = refl.h, k = refl.k, l = refl.l;

            const s2 = 0.25 * (
                h*h*a_star*a_star +
                k*k*b_star*b_star +
                l*l*c_star*c_star +
                2*h*k*a_star*b_star*cos_gamma_star +
                2*h*l*a_star*c_star*cos_beta_star +
                2*k*l*b_star*c_star*cos_alpha_star
            );

            for (let e = 0; e < E; e++) {
                const off = e * 9;
                let f = coef[off + 8];
                for (let t = 0; t < 4; t++) f += coef[off + 2 * t] * Math.exp(-coef[off + 2 * t + 1] * s2);
                fCache[e] = f;
            }

            let A = 0;
            let B = 0;
            for (let i = 0; i < n; i++) {
                const fT = fCache[ael[i]] * Math.exp(atk[i] * s2) * aocc[i];
                if (fT === 0) continue;
                const arg = twoPi * (h * ax[i] + k * ay[i] + l * az[i]);
                A += fT * Math.cos(arg);
                B += fT * Math.sin(arg);
            }
            refl.phase = Math.atan2(B, A);
        }
    }

    // Expand the unique (asymmetric-unit) reflections over the Laue group so a
    // Fourier synthesis covers the full reciprocal lattice. SHELXL LIST 4/6
    // FCF files contain only the unique reflections; without this expansion the
    // map is built from a fraction of reciprocal space and looks weak/dispersed.
    expandReflections(reflections, symmetry) {
        const ops = this.laueOperations(symmetry);
        if (!ops.length) return reflections;
        const expanded = new Map();
        for (const r of reflections) {
            for (const R of ops) {
                const h = R[0][0] * r.h + R[0][1] * r.k + R[0][2] * r.l;
                const k = R[1][0] * r.h + R[1][1] * r.k + R[1][2] * r.l;
                const l = R[2][0] * r.h + R[2][1] * r.k + R[2][2] * r.l;
                const key = h + ',' + k + ',' + l;
                if (!expanded.has(key)) {
                    expanded.set(key, { h, k, l, Fo2: r.Fo2, Fc2: r.Fc2, sigma: r.sigma, status: r.status });
                }
            }
        }
        return [...expanded.values()];
    }

    // Expand unique reflections over the full space group and Friedel mates
    // while propagating the model phase. For a space-group operation {R|t}
    //   F(Rh) = exp(2*pi*i (Rh).t) F(h)
    // and the Friedel mate -h is the complex conjugate (phase -> -phase).
    // This lets the (expensive) phase calculation run on the unique
    // reflections only instead of on the whole expanded reciprocal lattice.
    expandReflectionsWithPhases(reflections, symmetry) {
        const ops = [];
        for (const opStr of symmetry || []) {
            const p = Symmetry.parseOperation(opStr);
            if (p) ops.push(p);
        }
        const map = new Map();
        const add = (h, k, l, r, phase) => {
            const key = h + ',' + k + ',' + l;
            if (!map.has(key)) {
                map.set(key, { h, k, l, Fo2: r.Fo2, Fc2: r.Fc2, sigma: r.sigma, status: r.status, phase });
            }
        };
        for (const r of reflections) {
            const phi = r.phase || 0;
            if (!ops.length) {
                add(r.h, r.k, r.l, r, phi);
                add(-r.h, -r.k, -r.l, r, -phi);
                continue;
            }
            for (const op of ops) {
                const h = op[0].x * r.h + op[0].y * r.k + op[0].z * r.l;
                const k = op[1].x * r.h + op[1].y * r.k + op[1].z * r.l;
                const l = op[2].x * r.h + op[2].y * r.k + op[2].z * r.l;
                const shift = 2 * Math.PI * (h * op[0].c + k * op[1].c + l * op[2].c);
                add(h, k, l, r, phi + shift);
                add(-h, -k, -l, r, -(phi + shift));
            }
        }
        return [...map.values()];
    }

    // Integer rotation matrices for the Laue group implied by the space-group
    // symmetry operators, including inversion (Friedel's law for the observed
    // amplitudes). Translations do not affect the hkl orbit.
    laueOperations(symmetry) {
        const idx = { x: 0, y: 1, z: 2 };
        const ops = [];
        const seen = new Set();
        const add = (R) => {
            const key = R[0].join(',') + ';' + R[1].join(',') + ';' + R[2].join(',');
            if (!seen.has(key)) { seen.add(key); ops.push(R); }
        };
        for (const op of symmetry || []) {
            const parts = String(op).split(',');
            if (parts.length !== 3) continue;
            const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
            let ok = true;
            parts.forEach((comp, row) => {
                const re = /([+-]?)\s*(\d*)\s*([xyz])/g;
                let m;
                let found = false;
                while ((m = re.exec(comp)) !== null) {
                    found = true;
                    const sign = m[1] === '-' ? -1 : 1;
                    const num = m[2] === '' ? 1 : parseInt(m[2], 10);
                    R[row][idx[m[3]]] += sign * num;
                }
                if (!found) ok = false;
            });
            if (ok) add(R);
        }
        for (const R of ops.slice()) add(R.map(row => row.map(v => -v)));
        return ops;
    }

    calculateMap(reflections, cell, resolution = 0.5, type = '2Fo-Fc') {
        const na = Math.ceil(cell.a / resolution);
        const nb = Math.ceil(cell.b / resolution);
        const nc = Math.ceil(cell.c / resolution);
        
        const nx = this.nextPowerOf2(na);
        const ny = this.nextPowerOf2(nb);
        const nz = this.nextPowerOf2(nc);

        const size = nx * ny * nz;
        const real = new Float32Array(size);
        const imag = new Float32Array(size);

        for (let refl of reflections) {
            let F = 0;
            const fo = Math.sqrt(refl.Fo2 > 0 ? refl.Fo2 : 0);
            const fc = Math.sqrt(refl.Fc2); 
            
            if (type === '2Fo-Fc') {
                F = 2 * fo - fc;
            } else if (type === 'Fo-Fc') {
                F = fo - fc;
            } else {
                // 'Fo' (Fobserved) and any other type use observed amplitudes
                F = fo;
            }
            
            const phi = refl.phase;
            
            const A = F * Math.cos(phi);
            const B = F * Math.sin(phi);

            let ih = refl.h % nx; if (ih < 0) ih += nx;
            let ik = refl.k % ny; if (ik < 0) ik += ny;
            let il = refl.l % nz; if (il < 0) il += nz;

            const idx = (ih * ny + ik) * nz + il;
            
            real[idx] = A;
            imag[idx] = B;
            
            let ih2 = (-refl.h) % nx; if (ih2 < 0) ih2 += nx;
            let ik2 = (-refl.k) % ny; if (ik2 < 0) ik2 += ny;
            let il2 = (-refl.l) % nz; if (il2 < 0) il2 += nz;
            
            const idx2 = (ih2 * ny + ik2) * nz + il2;
            real[idx2] = A;
            imag[idx2] = -B;
        }
        
        this.fft3d(real, imag, nx, ny, nz, 1);

        // Calculate Mean and Sigma (RMSD)
        let sum = 0;
        let sumSq = 0;
        for (let i = 0; i < size; i++) {
            sum += real[i];
            sumSq += real[i] * real[i];
        }
        const mean = sum / size;
        const variance = (sumSq / size) - (mean * mean);
        const sigma = Math.sqrt(variance);

        // Normalize to Sigma levels
        if (sigma > 1e-10) {
            for (let i = 0; i < size; i++) {
                real[i] = (real[i] - mean) / sigma;
            }
        }

        // Compute min/max with a loop (spread of a large typed array would overflow the call stack)
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < size; i++) {
            const v = real[i];
            if (v < min) min = v;
            if (v > max) max = v;
        }

        return {
            data: real,
            nx, ny, nz,
            min,
            max,
            mean: 0, // Normalized
            sigma: 1 // Normalized
        };
    }

    nextPowerOf2(n) {
        return Math.pow(2, Math.ceil(Math.log2(n)));
    }

    fft3d(real, imag, nx, ny, nz, dir) {
        for (let x = 0; x < nx; x++) {
            for (let y = 0; y < ny; y++) {
                this.fft1d(real, imag, nz, (x * ny + y) * nz, 1, dir);
            }
        }
        for (let x = 0; x < nx; x++) {
            for (let z = 0; z < nz; z++) {
                this.fft1d(real, imag, ny, x * ny * nz + z, nz, dir);
            }
        }
        for (let y = 0; y < ny; y++) {
            for (let z = 0; z < nz; z++) {
                this.fft1d(real, imag, nx, y * nz + z, ny * nz, dir);
            }
        }
    }

    fft1d(real, imag, n, offset, stride, dir) {
        let j = 0;
        for (let i = 0; i < n - 1; i++) {
            if (i < j) {
                const r = real[offset + i * stride];
                const im = imag[offset + i * stride];
                real[offset + i * stride] = real[offset + j * stride];
                imag[offset + i * stride] = imag[offset + j * stride];
                real[offset + j * stride] = r;
                imag[offset + j * stride] = im;
            }
            let k = n >> 1;
            while (k <= j) {
                j -= k;
                k >>= 1;
            }
            j += k;
        }

        let step = 1;
        while (step < n) {
            const jump = step << 1;
            const theta = -dir * Math.PI / step;
            const w_r = Math.cos(theta);
            const w_i = Math.sin(theta);
            
            let u_r = 1.0;
            let u_i = 0.0;
            
            for (let m = 0; m < step; m++) {
                for (let i = m; i < n; i += jump) {
                    const j = i + step;
                    const tr = u_r * real[offset + j * stride] - u_i * imag[offset + j * stride];
                    const ti = u_r * imag[offset + j * stride] + u_i * real[offset + j * stride];
                    
                    real[offset + j * stride] = real[offset + i * stride] - tr;
                    imag[offset + j * stride] = imag[offset + i * stride] - ti;
                    real[offset + i * stride] += tr;
                    imag[offset + i * stride] += ti;
                }
                const t = u_r;
                u_r = t * w_r - u_i * w_i;
                u_i = t * w_i + u_i * w_r;
            }
            step = jump;
        }
    }
}
