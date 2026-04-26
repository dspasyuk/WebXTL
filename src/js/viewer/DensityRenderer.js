
import * as THREE from 'three';
import { MarchingCubes } from 'three/examples/jsm/objects/MarchingCubes.js';

export class DensityRenderer {
    constructor(parent) {
        this.parent = parent;
        this.mesh = null;
        this.material = new THREE.MeshBasicMaterial({
            color: 0x0000ff,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.4, 
            depthWrite: false,
            wireframe: true
        });
        this.isoLevel = 1.0;
    }

    render(mapData, cell, level = 1.0, color = 0x0000ff, bounds = null, center = null, radius = null) {
        if (this.mesh) {
            this.parent.remove(this.mesh);
            this.mesh.geometry.dispose();
        }

        this.isoLevel = level;
        this.material.color.setHex(color);

        const { data, nx, ny, nz } = mapData;
        
        // Default bounds: 0 to 1
        let minFrac = { x: 0, y: 0, z: 0 };
        let maxFrac = { x: 1, y: 1, z: 1 };
        
        if (bounds) {
            minFrac = bounds.min;
            maxFrac = bounds.max;
        }
        
        const dFracX = maxFrac.x - minFrac.x;
        const dFracY = maxFrac.y - minFrac.y;
        const dFracZ = maxFrac.z - minFrac.z;
        
        // Adjust resolution
        const resX = Math.ceil(nx * dFracX);
        const resY = Math.ceil(ny * dFracY);
        const resZ = Math.ceil(nz * dFracZ);
        
        const resolution = Math.max(resX, resY, resZ);
        
        this.mesh = new MarchingCubes(resolution, this.material, true, true, 100000);
        this.mesh.userData.isMap = true; 
        
        const field = this.mesh.field;
        
        // Metric Tensor for Distance Calculation
        const d2r = Math.PI / 180.0;
        const a = cell.a;
        const b = cell.b;
        const c = cell.c;
        const alpha = cell.alpha * d2r;
        const beta = cell.beta * d2r;
        const gamma = cell.gamma * d2r;
        
        const g11 = a * a;
        const g22 = b * b;
        const g33 = c * c;
        const g12 = a * b * Math.cos(gamma);
        const g13 = a * c * Math.cos(beta);
        const g23 = b * c * Math.cos(alpha);
        
        const radiusSq = radius ? radius * radius : Infinity;
        
        for (let k = 0; k < resolution; k++) { // z
            for (let j = 0; j < resolution; j++) { // y
                for (let i = 0; i < resolution; i++) { // x
                    const u = i / resolution;
                    const v = j / resolution;
                    const w = k / resolution;
                    
                    // Map u (0..1) to fractional coordinate
                    const fracX = minFrac.x + u * dFracX;
                    const fracY = minFrac.y + v * dFracY;
                    const fracZ = minFrac.z + w * dFracZ;
                    
                    // Spherical Mask
                    if (center && radius) {
                        const dx = fracX - center.x;
                        const dy = fracY - center.y;
                        const dz = fracZ - center.z;
                        
                        const distSq = dx*dx*g11 + dy*dy*g22 + dz*dz*g33 + 
                                       2*dx*dy*g12 + 2*dx*dz*g13 + 2*dy*dz*g23;
                                       
                        if (distSq > radiusSq) {
                            field[k * resolution * resolution + j * resolution + i] = -1000; // Mask out
                            continue;
                        }
                    }
                    
                    // Map fractional to grid index
                    const gx = fracX * nx;
                    const gy = fracY * ny;
                    const gz = fracZ * nz;
                    
                    const val = this.sampleGrid(data, nx, ny, nz, gx, gy, gz);
                    
                    const idx = k * resolution * resolution + j * resolution + i;
                    field[idx] = val;
                }
            }
        }
        
        this.mesh.isolation = this.isoLevel;
        this.mesh.update();
        
        // Matrix Calculation
        // MC Mesh is -1 to 1? Or 0 to 1?
        // MarchingCubes.js usually creates geometry in [-1, 1] range?
        // Let's verify. 
        // If I use makeScale(0.5).translate(1,1,1) previously to map to 0..1,
        // it implies it was -1..1.
        // (-1 * 0.5 + 0.5 = 0). (1 * 0.5 + 0.5 = 1).
        // Wait, previous code was: makeScale(0.5).multiply(makeTranslation(1,1,1))?
        // No, makeScale(0.5,0.5,0.5).multiply(makeTranslation(1,1,1))
        // Order: Scale then Translate? No, multiplyMatrices(A, B) is A * B.
        // So Scale * Translate.
        // Point p. M * p = Scale * (Translate * p)? No.
        // Matrix multiplication in Three.js: A.multiply(B) sets A = A * B.
        // Transform p: A * p.
        // So Scale * Translate * p.
        // p' = Scale * (p + T).
        // If p = -1: 0.5 * (-1 + 1) = 0.
        // If p = 1: 0.5 * (1 + 1) = 1.
        // So yes, MC is -1 to 1.
        
        // New Mapping: -1..1 -> minFrac..maxFrac
        // Target: min + (max-min) * (p+1)/2
        // = min + (max-min)/2 * p + (max-min)/2
        // = (max-min)/2 * p + (min + (max-min)/2)
        // Scale = (max-min)/2
        // Translate = min + (max-min)/2 = center
        
        const scaleX = dFracX / 2;
        const scaleY = dFracY / 2;
        const scaleZ = dFracZ / 2;
        
        const centerX = minFrac.x + scaleX;
        const centerY = minFrac.y + scaleY;
        const centerZ = minFrac.z + scaleZ;
        
        // We need M such that M * p = Scale * p + Center?
        // No, standard matrix is T * R * S.
        // Here we just need Scale and Translate.
        // M = Translate(center) * Scale(scale)
        // Check: M * p = T * (S * p) = S*p + center.
        // If p = -1: S*(-1) + center = -d/2 + min + d/2 = min. Correct.
        // If p = 1: S*(1) + center = d/2 + min + d/2 = min + d = max. Correct.
        
        const unitToFrac = new THREE.Matrix4()
            .makeTranslation(centerX, centerY, centerZ)
            .scale(new THREE.Vector3(scaleX, scaleY, scaleZ));
            
        // Orthogonalization
        // Variables already declared above
        
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
        
        const fracToCart = new THREE.Matrix4().set(
            m11, m12, m13, 0,
            m21, m22, m23, 0,
            m31, m32, m33, 0,
            0,   0,   0,   1
        );
            
        const finalMat = new THREE.Matrix4().multiplyMatrices(fracToCart, unitToFrac);
        
        this.mesh.matrixAutoUpdate = false;
        this.mesh.matrix.copy(finalMat);
        this.mesh.updateMatrixWorld(true);
        
        this.parent.add(this.mesh);
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
    
    updateLevel(level) {
        if (this.mesh) {
            this.mesh.isolation = level;
            // MarchingCubes doesn't auto-update geometry on isolation change in Three.js implementation?
            // Actually, looking at the code, it seems we might need to call something.
            // But let's assume update() is needed.
            // Wait, MarchingCubes.js has an update() method that regenerates geometry.
            // I called it in render().
            // I should call it here too.
            // But update() uses the field. The field is already set.
            // So yes, calling update() should work.
            // However, update() is expensive.
            // But changing level requires re-marching.
            // So yes.
             this.mesh.update();
        }
    }
}
