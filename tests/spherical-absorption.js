import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { SphericalAbsorption } from '../src/js/compute/SphericalAbsorption.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, got, want, tol) => {
    const ok = Math.abs(got - want) <= tol;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: got ${got}, want ${want} (±${tol})`);
};

// 1. theta = 0 sphere factor against the standard table (PLATON AMUR).
const table = [[0, 1.0], [0.5, 0.48181], [1, 0.24249], [2, 0.07142],
               [3, 0.02606], [4, 0.01156], [5, 0.005983], [10, 0.00075]];
table.forEach(([muR, want]) => check(`A*(${muR})`, SphericalAbsorption.transmission(muR), want, 5e-5));
check('A*(0.01) series', SphericalAbsorption.transmission(0.01), 0.9851193362, 1e-7);

// 2. theta-dependent factor: equals theta=0 at theta=0 and rises with theta.
const d2r = Math.PI / 180;
check('T(1,0) = A*(1)', SphericalAbsorption.transmissionTheta(1, 0), SphericalAbsorption.transmission(1), 1e-6);
check('T(1,90deg)', SphericalAbsorption.transmissionTheta(1, 90 * d2r), 0.3324, 0.002);
check('T(2,90deg)', SphericalAbsorption.transmissionTheta(2, 90 * d2r), 0.1817, 0.003);
check('T(1,45deg)', SphericalAbsorption.transmissionTheta(1, 45 * d2r), 0.2854, 0.002);

// 3. sin(theta) from the reciprocal metric (cubic a=10, 100 reflection).
const cell = { a: 10, b: 10, c: 10, alpha: 90, beta: 90, gamma: 90 };
check('sinTheta(1,0,0)', SphericalAbsorption.sinTheta(1, 0, 0, cell, 1.54178), 1.54178 / 20, 1e-6);
check('sinTheta(0,0,2)', SphericalAbsorption.sinTheta(0, 0, 2, cell, 1.54178), 2 * 1.54178 / 20, 1e-6);

// 4. Linear mu from the example structure (test/test.res).
const anom = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/data/anomalous.json'), 'utf8')).elements;
const byUpper = {};
Object.keys(anom).forEach(k => { byUpper[k.toUpperCase()] = anom[k]; });
const energy = 12398.4198 / 1.54178;
const fppAt = (el) => {
    const rows = byUpper[el.toUpperCase()];
    let lo = 0, hi = rows.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rows[m][0] <= energy) lo = m; else hi = m; }
    const [E0, , b0] = rows[lo], [E1, , b1] = rows[hi];
    return b0 + (b1 - b0) * (energy - E0) / (E1 - E0);
};
const counts = { C: 304, N: 16, Ni: 16, O: 80, P: 32 };
const fpp = { C: fppAt('C'), N: fppAt('N'), Ni: fppAt('Ni'), O: fppAt('O'), P: fppAt('P') };
const mu = SphericalAbsorption.linearMu({ cellVolume: 9145.28, wavelength: 1.54178, counts, fpp });
check('mu (mm^-1) vs SHELXL 2.79', mu / 10, 2.79, 0.35);

// 5. Equivalent sphere radius.
check('R for 0.2x0.3x0.4 mm', SphericalAbsorption.equivalentSphereRadius([0.2, 0.3, 0.4]), 0.1789, 5e-4);

// 6. Applying the correction with theta dependence gives a T range.
const refls = [
    { h: 1, k: 0, l: 0, Fo2: 100, sigma: 5 },
    { h: 0, k: 0, l: 8, Fo2: 50, sigma: 3 }
];
const res = SphericalAbsorption.apply(refls, { mu: 26.1, radiusA: 1e6, cell, wavelength: 1.54178 });
check('apply useTheta', res.useTheta ? 1 : 0, 1, 0);
check('apply T range ordered', res.Tmax > res.Tmin ? 1 : 0, 1, 0);
check('apply high-angle Fo2', res.reflections[1].Fo2, 50 / res.Tmax, 1e-9);
check('apply sigma scaled', res.reflections[0].sigma, 5 / res.Tmin, 1e-9);

console.log(failures ? `\n${failures} failure(s)` : '\nall spherical-absorption checks passed');
process.exit(failures ? 1 : 0);
