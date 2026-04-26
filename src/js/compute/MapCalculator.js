
import * as THREE from 'three';

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

        for (let refl of reflections) {
            const h = refl.h;
            const k = refl.k;
            const l = refl.l;

            const s2 = 0.25 * (
                h*h*a_star*a_star + 
                k*k*b_star*b_star + 
                l*l*c_star*c_star + 
                2*h*k*a_star*b_star*cos_gamma_star + 
                2*h*l*a_star*c_star*cos_beta_star + 
                2*k*l*b_star*c_star*cos_alpha_star
            );

            let A = 0;
            let B = 0;

            for (let atom of atoms) {
                const f = this.getScatteringFactor(atom.element, s2);
                const T = Math.exp(-8 * Math.PI * Math.PI * atom.uiso * s2);
                const fT = f * T * atom.occupancy;

                const arg = 2 * Math.PI * (h * atom.x + k * atom.y + l * atom.z);
                A += fT * Math.cos(arg);
                B += fT * Math.sin(arg);
            }

            const phase = Math.atan2(B, A);
            refl.phase = phase;
        }
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

        return {
            data: real,
            nx, ny, nz,
            min: Math.min(...real),
            max: Math.max(...real),
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
