
import * as THREE from 'three';

export class RealSpaceRefiner {
    constructor() {
        this.stepSize = 0.05; // Angstroms (was 0.01 — too small to reach density peaks)
        this.maxIterations = 50;
    }

    /**
     * Refines atom positions to maximize density.
     * @param {Array} atoms Atoms to refine.
     * @param {Object} mapData Map data {data, nx, ny, nz}.
     * @param {Object} cell Unit cell parameters.
     */
    refine(atoms, mapData, cell) {
        const { data, nx, ny, nz } = mapData;
        const d2r = Math.PI / 180.0;
        const a = cell.a;
        const b = cell.b;
        const c = cell.c;
        const alpha = cell.alpha * d2r;
        const beta = cell.beta * d2r;
        const gamma = cell.gamma * d2r;

        // Metric tensor for converting fractional to Cartesian displacements
        const v = Math.sqrt(1 - Math.cos(alpha)**2 - Math.cos(beta)**2 - Math.cos(gamma)**2 + 2*Math.cos(alpha)*Math.cos(beta)*Math.cos(gamma));
        const m11 = a;
        const m12 = b * Math.cos(gamma);
        const m13 = c * Math.cos(beta);
        const m21 = 0;
        const m22 = b * Math.sin(gamma);
        const m23 = c * (Math.cos(alpha) - Math.cos(beta)*Math.cos(gamma)) / Math.sin(gamma);
        const m31 = 0;
        const m32 = 0;
        const m33 = c * v / Math.sin(gamma);

        const fracToCart = (x, y, z) => ({
            x: m11 * x + m12 * y + m13 * z,
            y: m21 * x + m22 * y + m23 * z,
            z: m31 * x + m32 * y + m33 * z
        });

        // Invert for Cart to Frac
        const det = m11 * (m22 * m33 - m23 * m32) - m12 * (m21 * m33 - m23 * m31) + m13 * (m21 * m32 - m22 * m31);
        const invDet = 1 / det;
        const i11 = (m22 * m33 - m23 * m32) * invDet;
        const i12 = (m13 * m32 - m12 * m33) * invDet;
        const i13 = (m12 * m23 - m13 * m22) * invDet;
        const i21 = (m23 * m31 - m21 * m33) * invDet;
        const i22 = (m11 * m33 - m13 * m31) * invDet;
        const i23 = (m13 * m21 - m11 * m23) * invDet;
        const i31 = (m21 * m32 - m22 * m31) * invDet;
        const i32 = (m12 * m31 - m11 * m32) * invDet;
        const i33 = (m11 * m22 - m12 * m21) * invDet;

        const cartToFrac = (x, y, z) => ({
            x: i11 * x + i12 * y + i13 * z,
            y: i21 * x + i22 * y + i23 * z,
            z: i31 * x + i32 * y + i33 * z
        });

        atoms.forEach(atom => {
            let currentFrac = { x: atom.x, y: atom.y, z: atom.z };
            
            for (let iter = 0; iter < this.maxIterations; iter++) {
                // Calculate gradient in Cartesian space
                const cart = fracToCart(currentFrac.x, currentFrac.y, currentFrac.z);
                const delta = 0.01; // Angstroms for gradient
                
                const getDensAtCart = (cx, cy, cz) => {
                    const f = cartToFrac(cx, cy, cz);
                    return this.sampleGrid(data, nx, ny, nz, f.x * nx, f.y * ny, f.z * nz);
                };

                const d0 = getDensAtCart(cart.x, cart.y, cart.z);
                const dx = (getDensAtCart(cart.x + delta, cart.y, cart.z) - getDensAtCart(cart.x - delta, cart.y, cart.z)) / (2 * delta);
                const dy = (getDensAtCart(cart.x, cart.y + delta, cart.z) - getDensAtCart(cart.x, cart.y - delta, cart.z)) / (2 * delta);
                const dz = (getDensAtCart(cart.x, cart.y, cart.z + delta) - getDensAtCart(cart.x, cart.y, cart.z - delta)) / (2 * delta);

                const gradMag = Math.sqrt(dx*dx + dy*dy + dz*dz);
                if (gradMag < 1e-6) break;

                // Move atom along gradient
                const moveX = (dx / gradMag) * this.stepSize;
                const moveY = (dy / gradMag) * this.stepSize;
                const moveZ = (dz / gradMag) * this.stepSize;

                const nextCart = { x: cart.x + moveX, y: cart.y + moveY, z: cart.z + moveZ };
                const nextFrac = cartToFrac(nextCart.x, nextCart.y, nextCart.z);
                
                // Check if density increased
                const dNext = getDensAtCart(nextCart.x, nextCart.y, nextCart.z);
                if (dNext > d0) {
                    currentFrac = nextFrac;
                } else {
                    break; // Convergence or overshoot
                }
            }

            atom.x = currentFrac.x;
            atom.y = currentFrac.y;
            atom.z = currentFrac.z;
        });
    }

    /**
     * Rigid-body refinement: translates and rotates all atoms as a single unit.
     * Preserves bond lengths and angles within the group.
     */
    refineRigid(atoms, mapData, cell) {
        if (!atoms || atoms.length < 2) {
            if (atoms && atoms.length === 1) this.refine(atoms, mapData, cell);
            return;
        }
        const { data, nx, ny, nz } = mapData;
        const d2r = Math.PI / 180.0;
        const a = cell.a, b = cell.b, c = cell.c;
        const alpha = cell.alpha * d2r, beta = cell.beta * d2r, gamma = cell.gamma * d2r;
        const v = Math.sqrt(1 - Math.cos(alpha)**2 - Math.cos(beta)**2 - Math.cos(gamma)**2 + 2*Math.cos(alpha)*Math.cos(beta)*Math.cos(gamma));
        const m11 = a, m12 = b * Math.cos(gamma), m13 = c * Math.cos(beta);
        const m21 = 0, m22 = b * Math.sin(gamma), m23 = c * (Math.cos(alpha) - Math.cos(beta)*Math.cos(gamma)) / Math.sin(gamma);
        const m31 = 0, m32 = 0, m33 = c * v / Math.sin(gamma);

        const fracToCart = (x, y, z) => ({
            x: m11 * x + m12 * y + m13 * z,
            y: m21 * x + m22 * y + m23 * z,
            z: m31 * x + m32 * y + m33 * z
        });

        const det = m11 * (m22 * m33 - m23 * m32) - m12 * (m21 * m33 - m23 * m31) + m13 * (m21 * m32 - m22 * m31);
        const invDet = 1 / det;
        const i11 = (m22 * m33 - m23 * m32) * invDet;
        const i12 = (m13 * m32 - m12 * m33) * invDet;
        const i13 = (m12 * m23 - m13 * m22) * invDet;
        const i21 = (m23 * m31 - m21 * m33) * invDet;
        const i22 = (m11 * m33 - m13 * m31) * invDet;
        const i23 = (m13 * m21 - m11 * m23) * invDet;
        const i31 = (m21 * m32 - m22 * m31) * invDet;
        const i32 = (m12 * m31 - m11 * m32) * invDet;
        const i33 = (m11 * m22 - m12 * m21) * invDet;

        const cartToFrac = (x, y, z) => ({
            x: i11 * x + i12 * y + i13 * z,
            y: i21 * x + i22 * y + i23 * z,
            z: i31 * x + i32 * y + i33 * z
        });

        const getDensAtCart = (cx, cy, cz) => {
            const f = cartToFrac(cx, cy, cz);
            return this.sampleGrid(data, nx, ny, nz, f.x * nx, f.y * ny, f.z * nz);
        };

        // Store current fractional positions
        let currentFracs = atoms.map(a => ({ x: a.x, y: a.y, z: a.z }));

        for (let iter = 0; iter < this.maxIterations; iter++) {
            // Convert all to Cartesian and compute gradients
            const carts = currentFracs.map(f => fracToCart(f.x, f.y, f.z));
            const delta = 0.01;

            const grads = carts.map(c => {
                const d0 = getDensAtCart(c.x, c.y, c.z);
                const dx = (getDensAtCart(c.x + delta, c.y, c.z) - getDensAtCart(c.x - delta, c.y, c.z)) / (2 * delta);
                const dy = (getDensAtCart(c.x, c.y + delta, c.z) - getDensAtCart(c.x, c.y - delta, c.z)) / (2 * delta);
                const dz = (getDensAtCart(c.x, c.y, c.z + delta) - getDensAtCart(c.x, c.y, c.z - delta)) / (2 * delta);
                return { d0, dx, dy, dz };
            });

            // Net translation = average gradient
            let tx = 0, ty = 0, tz = 0;
            grads.forEach(g => { tx += g.dx; ty += g.dy; tz += g.dz; });
            tx /= grads.length; ty /= grads.length; tz /= grads.length;
            const transMag = Math.sqrt(tx*tx + ty*ty + tz*tz);

            // Centroid in Cartesian
            let cenX = 0, cenY = 0, cenZ = 0;
            carts.forEach(c => { cenX += c.x; cenY += c.y; cenZ += c.z; });
            cenX /= carts.length; cenY /= carts.length; cenZ /= carts.length;

            // Net torque (rotation) around centroid: sum(r × g)
            let rotX = 0, rotY = 0, rotZ = 0;
            for (let i = 0; i < carts.length; i++) {
                const rx = carts[i].x - cenX, ry = carts[i].y - cenY, rz = carts[i].z - cenZ;
                rotX += ry * grads[i].dz - rz * grads[i].dy;
                rotY += rz * grads[i].dx - rx * grads[i].dz;
                rotZ += rx * grads[i].dy - ry * grads[i].dx;
            }
            const rotMag = Math.sqrt(rotX*rotX + rotY*rotY + rotZ*rotZ);

            if (transMag < 1e-6 && rotMag < 1e-6) break;

            // Translation step
            const tStep = transMag > 0 ? Math.min(this.stepSize, transMag * 0.5) / transMag : 0;

            // Rotation step (small fixed angle)
            const rAngle = rotMag > 0 ? Math.min(0.005, rotMag * 0.1) : 0;
            const rAxis = rotMag > 0 ? { x: rotX/rotMag, y: rotY/rotMag, z: rotZ/rotMag } : { x: 0, y: 0, z: 1 };

            // Apply rigid transform to all atoms
            const testFracs = currentFracs.map((f, i) => {
                let cx2 = carts[i].x + tx * tStep;
                let cy2 = carts[i].y + ty * tStep;
                let cz2 = carts[i].z + tz * tStep;

                if (rotMag > 0) {
                    const rx = cx2 - cenX, ry = cy2 - cenY, rz = cz2 - cenZ;
                    const dot = rAxis.x * rx + rAxis.y * ry + rAxis.z * rz;
                    const crx = rAxis.y * rz - rAxis.z * ry;
                    const cry = rAxis.z * rx - rAxis.x * rz;
                    const crz = rAxis.x * ry - rAxis.y * rx;
                    const cosA = Math.cos(rAngle);
                    const sinA = Math.sin(rAngle);
                    cx2 = cenX + rx * cosA + crx * sinA + rAxis.x * dot * (1 - cosA);
                    cy2 = cenY + ry * cosA + cry * sinA + rAxis.y * dot * (1 - cosA);
                    cz2 = cenZ + rz * cosA + crz * sinA + rAxis.z * dot * (1 - cosA);
                }

                const ff = cartToFrac(cx2, cy2, cz2);
                return { x: ff.x, y: ff.y, z: ff.z };
            });

            // Evaluate density change
            let oldSum = 0, newSum = 0;
            for (let i = 0; i < carts.length; i++) {
                oldSum += grads[i].d0;
                const tf = testFracs[i];
                const tc = fracToCart(tf.x, tf.y, tf.z);
                newSum += getDensAtCart(tc.x, tc.y, tc.z);
            }

            if (newSum > oldSum) {
                currentFracs = testFracs;
            } else {
                break;
            }
        }

        atoms.forEach((atom, i) => {
            atom.x = currentFracs[i].x;
            atom.y = currentFracs[i].y;
            atom.z = currentFracs[i].z;
        });
    }

    sampleGrid(data, nx, ny, nz, x, y, z) {
        x = ((x % nx) + nx) % nx;
        y = ((y % ny) + ny) % ny;
        z = ((z % nz) + nz) % nz;
        
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const z0 = Math.floor(z);
        
        const x1 = (x0 + 1) % nx;
        const y1 = (y0 + 1) % ny;
        const z1 = (z0 + 1) % nz;
        
        const dx = x - x0;
        const dy = y - y0;
        const dz = z - z0;
        
        const c000 = data[(x0 * ny + y0) * nz + z0];
        const c100 = data[(x1 * ny + y0) * nz + z0];
        const c010 = data[(x0 * ny + y1) * nz + z0];
        const c001 = data[(x0 * ny + y0) * nz + z1];
        const c110 = data[(x1 * ny + y1) * nz + z0];
        const c101 = data[(x1 * ny + y0) * nz + z1];
        const c011 = data[(x0 * ny + y1) * nz + z1];
        const c111 = data[(x1 * ny + y1) * nz + z1];
        
        const c00 = c000 * (1 - dx) + c100 * dx;
        const c01 = c001 * (1 - dx) + c101 * dx;
        const c10 = c010 * (1 - dx) + c110 * dx;
        const c11 = c011 * (1 - dx) + c111 * dx;
        
        const c0 = c00 * (1 - dy) + c10 * dy;
        const c1 = c01 * (1 - dy) + c11 * dy;
        
        return c0 * (1 - dz) + c1 * dz;
    }
}
