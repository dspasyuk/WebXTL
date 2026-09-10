import * as THREE from 'three';
import { MarchingCubes } from 'three/examples/jsm/objects/MarchingCubes.js';

export class DensityRenderer {
    constructor(parent) {
        this.parent = parent;
        this.mesh = null;
        this.negativeMesh = null;

        // Wireframe isosurface (classic "chickenwire" look)
        this.wireframeMaterial = new THREE.MeshBasicMaterial({
            color: 0x0000ff,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.4,
            depthWrite: false,
            wireframe: true
        });

        // Smooth, lit, semi-transparent isosurface (Coot "solid" look).
        this.surfaceMaterial = new THREE.MeshPhongMaterial({
            color: 0x0000ff,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.45,
            depthWrite: true,
            shininess: 35,
            specular: 0x222222
        });

        // Separate materials for the negative (difference-map) lobes.
        this.wireframeNegativeMaterial = this.wireframeMaterial.clone();
        this.surfaceNegativeMaterial = this.surfaceMaterial.clone();

        this.material = this.wireframeMaterial;
        this.negativeMaterial = this.wireframeNegativeMaterial;
        this.style = 'wireframe';
        this.opacity = 0.4;
        this.isoLevel = 1.0;
        this.color = new THREE.Color(0x0000ff);
        this.negativeColor = new THREE.Color(0xff0000);
    }

    _allMaterials() {
        return [
            this.wireframeMaterial,
            this.surfaceMaterial,
            this.wireframeNegativeMaterial,
            this.surfaceNegativeMaterial
        ];
    }

    setStyle(style) {
        if (style !== 'smooth' && style !== 'wireframe') style = 'wireframe';
        this.style = style;
        this.material = style === 'smooth' ? this.surfaceMaterial : this.wireframeMaterial;
        this.negativeMaterial = style === 'smooth' ? this.surfaceNegativeMaterial : this.wireframeNegativeMaterial;
        if (this.mesh) this.mesh.material = this.material;
        if (this.negativeMesh) this.negativeMesh.material = this.negativeMaterial;
        return this.material;
    }

    setColor(color) {
        this.color = new THREE.Color(color);
        this.wireframeMaterial.color.set(color);
        this.surfaceMaterial.color.set(color);
        if (this.mesh) this.mesh.material.color.set(color);
    }

    setNegativeColor(color) {
        this.negativeColor = new THREE.Color(color);
        this.wireframeNegativeMaterial.color.set(color);
        this.surfaceNegativeMaterial.color.set(color);
        if (this.negativeMesh) this.negativeMesh.material.color.set(color);
    }

    setOpacity(opacity) {
        opacity = parseFloat(opacity);
        if (!isFinite(opacity)) opacity = 0.4;
        this.opacity = Math.min(1, Math.max(0, opacity));
        for (const m of this._allMaterials()) m.opacity = this.opacity;
    }

    setVisible(visible) {
        if (this.mesh) this.mesh.visible = visible;
        if (this.negativeMesh) this.negativeMesh.visible = visible;
    }

    disposeMeshes() {
        if (this.mesh) {
            this.parent.remove(this.mesh);
            if (this.mesh.geometry) this.mesh.geometry.dispose();
            this.mesh = null;
        }
        if (this.negativeMesh) {
            this.parent.remove(this.negativeMesh);
            if (this.negativeMesh.geometry) this.negativeMesh.geometry.dispose();
            this.negativeMesh = null;
        }
    }

    render(mapData, cell, level = 1.0, color = 0x0000ff, bounds = null, center = null, radius = null, options = {}) {
        this.disposeMeshes();

        this.isoLevel = level;
        this.setColor(color);

        const negativeLevel = options.negativeLevel != null ? options.negativeLevel : null;
        if (options.negativeColor != null) this.setNegativeColor(options.negativeColor);

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

        // Cap resolution so the polygon buffers stay within a reasonable size.
        const MAX_RES = 48;
        const mcRes = Math.min(resolution, MAX_RES);

        const maxPolyCount = Math.max(100000, Math.ceil(Math.pow(mcRes - 1, 3) * 5 * 1.1));

        // Metric tensor for the spherical mask.
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

        // Sample the (periodic) map onto the marching-cubes grid. A different
        // out-of-range value is used for positive vs negative contours so the
        // spherical mask does not itself create a spurious surface.
        const buildField = (maskValue) => {
            const field = new Float32Array(mcRes * mcRes * mcRes);
            for (let k = 0; k < mcRes; k++) {
                for (let j = 0; j < mcRes; j++) {
                    for (let i = 0; i < mcRes; i++) {
                        const u = i / mcRes;
                        const v = j / mcRes;
                        const w = k / mcRes;
                        const fracX = minFrac.x + u * dFracX;
                        const fracY = minFrac.y + v * dFracY;
                        const fracZ = minFrac.z + w * dFracZ;

                        if (center && radius) {
                            const dx = fracX - center.x;
                            const dy = fracY - center.y;
                            const dz = fracZ - center.z;
                            const distSq = dx*dx*g11 + dy*dy*g22 + dz*dz*g33 +
                                2*dx*dy*g12 + 2*dx*dz*g13 + 2*dy*dz*g23;
                            if (distSq > radiusSq) {
                                field[k * mcRes * mcRes + j * mcRes + i] = maskValue;
                                continue;
                            }
                        }
                        field[k * mcRes * mcRes + j * mcRes + i] =
                            this.sampleGrid(data, nx, ny, nz, fracX * nx, fracY * ny, fracZ * nz);
                    }
                }
            }
            return field;
        };

        const makeMesh = (field, material, isolation) => {
            const mesh = new MarchingCubes(mcRes, material, true, true, maxPolyCount);
            mesh.userData.isMap = true;
            mesh.field.set(field);
            mesh.isolation = isolation;
            mesh.update();
            return mesh;
        };

        const positiveField = buildField(-1000);
        this.mesh = makeMesh(positiveField, this.material, this.isoLevel);

        if (negativeLevel != null) {
            const negativeField = buildField(1000);
            this.negativeMesh = makeMesh(negativeField, this.negativeMaterial, negativeLevel);
        }

        // Unit-cube [-1,1] -> fractional -> Cartesian matrix.
        const scaleX = dFracX / 2;
        const scaleY = dFracY / 2;
        const scaleZ = dFracZ / 2;
        const centerX = minFrac.x + scaleX;
        const centerY = minFrac.y + scaleY;
        const centerZ = minFrac.z + scaleZ;

        const unitToFrac = new THREE.Matrix4()
            .makeTranslation(centerX, centerY, centerZ)
            .scale(new THREE.Vector3(scaleX, scaleY, scaleZ));

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

        for (const m of [this.mesh, this.negativeMesh]) {
            if (!m) continue;
            m.matrixAutoUpdate = false;
            m.matrix.copy(finalMat);
            m.updateMatrixWorld(true);
            this.parent.add(m);
        }
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
        this.isoLevel = level;
        if (this.mesh) {
            this.mesh.isolation = level;
            this.mesh.update();
        }
        if (this.negativeMesh) {
            this.negativeMesh.isolation = -Math.abs(level);
            this.negativeMesh.update();
        }
    }
}
