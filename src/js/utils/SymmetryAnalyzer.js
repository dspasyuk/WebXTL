import * as THREE from 'three';

export class SymmetryAnalyzer {
    static analyze(ops) {
        const elements = [];
        
        ops.forEach(opString => {
            const op = this.parseOp(opString);
            if (!op) return;

            // Matrix W and vector w
            // x' = Wx + w
            const W = op.W;
            const w = op.w;

            // 1. Calculate Trace to identify type
            const trace = W[0][0] + W[1][1] + W[2][2];
            const det = this.determinant(W);

            // Identity (Trace=3, Det=1) - Skip
            if (trace === 3 && det === 1) return;

            // Inversion (Trace=-3, Det=-1)
            if (trace === -3 && det === -1) {
                // Fixed point: -x + w = x => 2x = w => x = w/2
                const pos = new THREE.Vector3(w.x/2, w.y/2, w.z/2);
                // Normalize to unit cell [0,1]
                this.normalizePosition(pos);
                elements.push({ type: 'inversion', pos: pos, label: 'i' });
                return;
            }

            // Rotation / Screw Axes (Det = 1)
            if (det === 1) {
                let order = 0;
                if (trace === -1) order = 2;
                else if (trace === 0) order = 3;
                else if (trace === 1) order = 4;
                else if (trace === 2) order = 6;

                if (order > 0) {
                    // Find Axis Direction (Eigenvector for lambda=1)
                    // (W - I)v = 0
                    const axis = this.findEigenvector(W);
                    if (!axis) return;

                    // Find Location (Fixed point in plane perpendicular to axis)
                    // (I - W)x = w_perp
                    // This is a bit complex for general case. 
                    // Simplified approach for standard settings:
                    // Check if axis is parallel to X, Y, or Z
                    
                    const pos = this.findAxisPosition(W, w, axis);
                    
                    elements.push({ 
                        type: 'rotation', 
                        order: order, 
                        axis: axis, 
                        pos: pos,
                        screw: this.getScrewComponent(W, w, axis)
                    });
                }
            }
            
            // Roto-inversion (Det = -1)
            // Mirror planes (Trace=1, Det=-1)
            if (det === -1 && trace === 1) {
                // Reflection / Glide Plane
                // Normal n is eigenvector for lambda = -1
                // W n = -n
                const normal = this.findEigenvector(W, -1);
                if (!normal) return;

                // Plane equation: n . x = C
                // 2 * (n . x) = n . w
                // C = (n . w) / 2
                const C = (normal.x * w.x + normal.y * w.y + normal.z * w.z) / 2;
                
                // Glide component
                // g = w - 2 * C * n (approximate for label determination)
                // Actually, we can just look at w components perpendicular to n.
                // But let's just store the raw data and determine label later or here.
                
                // Determine label
                let label = 'm';
                const g = new THREE.Vector3(
                    w.x - 2 * C * normal.x,
                    w.y - 2 * C * normal.y,
                    w.z - 2 * C * normal.z
                );
                
                // Normalize glide to [0,1)
                const gx = Math.abs(g.x - Math.round(g.x)) < 1e-5 ? 0 : Math.abs(g.x);
                const gy = Math.abs(g.y - Math.round(g.y)) < 1e-5 ? 0 : Math.abs(g.y);
                const gz = Math.abs(g.z - Math.round(g.z)) < 1e-5 ? 0 : Math.abs(g.z);
                
                const isZero = (v) => Math.abs(v) < 1e-4;
                const isHalf = (v) => Math.abs(v - 0.5) < 1e-4;
                const isQuarter = (v) => Math.abs(v - 0.25) < 1e-4 || Math.abs(v - 0.75) < 1e-4;

                if (isZero(gx) && isZero(gy) && isZero(gz)) label = 'm';
                else if (isHalf(gx) && isZero(gy) && isZero(gz)) label = 'a';
                else if (isZero(gx) && isHalf(gy) && isZero(gz)) label = 'b';
                else if (isZero(gx) && isZero(gy) && isHalf(gz)) label = 'c';
                else if (isHalf(gx) && isHalf(gy) && isHalf(gz)) label = 'n'; // 3D n?
                else if (isHalf(gx) && isHalf(gy)) label = 'n';
                else if (isHalf(gx) && isHalf(gz)) label = 'n';
                else if (isHalf(gy) && isHalf(gz)) label = 'n';
                else if (isQuarter(gx) || isQuarter(gy) || isQuarter(gz)) label = 'd';
                else label = 'g'; // Generic glide

                elements.push({
                    type: 'plane',
                    normal: normal,
                    constant: C,
                    label: label
                });
            }
        });

        return this.filterDuplicates(elements);
    }

    static parseOp(opString) {
        // Similar to Symmetry.js but returns Matrix form
        // opString: "x+1/2, -y, -z"
        // Returns { W: [[1,0,0],[0,-1,0],[0,0,-1]], w: {x:0.5, y:0, z:0} }
        
        const parts = opString.toLowerCase().replace(/\s/g, '').split(',');
        if (parts.length !== 3) return null;

        const W = [[0,0,0], [0,0,0], [0,0,0]];
        const w = { x: 0, y: 0, z: 0 };

        const axes = ['x', 'y', 'z'];
        
        parts.forEach((part, i) => {
            // Parse W
            if (part.includes('-x')) W[i][0] = -1;
            else if (part.includes('x')) W[i][0] = 1;
            
            if (part.includes('-y')) W[i][1] = -1;
            else if (part.includes('y')) W[i][1] = 1;
            
            if (part.includes('-z')) W[i][2] = -1;
            else if (part.includes('z')) W[i][2] = 1;

            // Parse w
            let constPart = part.replace(/-?x/g, '').replace(/-?y/g, '').replace(/-?z/g, '');
            if (constPart.length > 0 && constPart !== '+') {
                if (constPart.includes('/')) {
                    const [num, den] = constPart.split('/');
                    const val = parseFloat(num) / parseFloat(den);
                    if (i === 0) w.x = val;
                    if (i === 1) w.y = val;
                    if (i === 2) w.z = val;
                } else {
                    const val = parseFloat(constPart);
                    if (i === 0) w.x = val;
                    if (i === 1) w.y = val;
                    if (i === 2) w.z = val;
                }
            }
        });

        return { W, w };
    }

    static determinant(m) {
        return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
               m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
               m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    }

    static findEigenvector(W, lambda = 1) {
        // Find v such that Wv = lambda*v => (W - lambda*I)v = 0
        const test = (v) => {
            const res = {
                x: W[0][0]*v.x + W[0][1]*v.y + W[0][2]*v.z,
                y: W[1][0]*v.x + W[1][1]*v.y + W[1][2]*v.z,
                z: W[2][0]*v.x + W[2][1]*v.y + W[2][2]*v.z
            };
            // Check if res == lambda * v
            const target = { x: lambda*v.x, y: lambda*v.y, z: lambda*v.z };
            
            return Math.abs(res.x - target.x) < 1e-5 && 
                   Math.abs(res.y - target.y) < 1e-5 && 
                   Math.abs(res.z - target.z) < 1e-5;
        };

        if (test({x:1, y:0, z:0})) return new THREE.Vector3(1,0,0);
        if (test({x:0, y:1, z:0})) return new THREE.Vector3(0,1,0);
        if (test({x:0, y:0, z:1})) return new THREE.Vector3(0,0,1);
        
        // Diagonals
        if (test({x:1, y:1, z:0})) return new THREE.Vector3(1,1,0).normalize();
        if (test({x:1, y:-1, z:0})) return new THREE.Vector3(1,-1,0).normalize();
        if (test({x:0, y:1, z:1})) return new THREE.Vector3(0,1,1).normalize();
        if (test({x:0, y:1, z:-1})) return new THREE.Vector3(0,1,-1).normalize();
        if (test({x:1, y:0, z:1})) return new THREE.Vector3(1,0,1).normalize();
        if (test({x:1, y:0, z:-1})) return new THREE.Vector3(1,0,-1).normalize();
        
        if (test({x:1, y:1, z:1})) return new THREE.Vector3(1,1,1).normalize();
        
        return null; // Fallback
    }

    static findAxisPosition(W, w, axis) {
        // We need to find a point x such that (I - W)x = w (mod translation along axis)
        // For standard axes, we can solve for the other components.
        
        const pos = new THREE.Vector3(0,0,0);
        
        // If axis is Z (0,0,1), we solve for x and y
        if (Math.abs(axis.z) > 0.9) {
            // x' = Wxx*x + Wxy*y + wx
            // y' = Wyx*x + Wyy*y + wy
            // We want x' = x, y' = y
            // (1-Wxx)x - Wxy*y = wx
            // -Wyx*x + (1-Wyy)y = wy
            
            const A = 1 - W[0][0];
            const B = -W[0][1];
            const C = w.x;
            const D = -W[1][0];
            const E = 1 - W[1][1];
            const F = w.y;
            
            const det = A*E - B*D;
            if (Math.abs(det) > 1e-5) {
                pos.x = (C*E - B*F) / det;
                pos.y = (A*F - C*D) / det;
            }
        }
        // If axis is Y (0,1,0)
        else if (Math.abs(axis.y) > 0.9) {
            // Solve for x, z
            const A = 1 - W[0][0];
            const B = -W[0][2];
            const C = w.x;
            const D = -W[2][0];
            const E = 1 - W[2][2];
            const F = w.z;
            
            const det = A*E - B*D;
            if (Math.abs(det) > 1e-5) {
                pos.x = (C*E - B*F) / det;
                pos.z = (A*F - C*D) / det;
            }
        }
        // If axis is X (1,0,0)
        else if (Math.abs(axis.x) > 0.9) {
            // Solve for y, z
            const A = 1 - W[1][1];
            const B = -W[1][2];
            const C = w.y;
            const D = -W[2][1];
            const E = 1 - W[2][2];
            const F = w.z;
            
            const det = A*E - B*D;
            if (Math.abs(det) > 1e-5) {
                pos.y = (C*E - B*F) / det;
                pos.z = (A*F - C*D) / det;
            }
        }
        
        this.normalizePosition(pos);
        return pos;
    }

    static getScrewComponent(W, w, axis) {
        // Calculate translation along axis
        // t = w . axis
        // But w is in fractional coords, axis is normalized direction.
        // For standard axes, it's simple.
        
        const t = w.x * axis.x + w.y * axis.y + w.z * axis.z;
        // Normalize t to [0, 1)
        let tNorm = t - Math.floor(t);
        if (Math.abs(tNorm - 1) < 1e-5) tNorm = 0;
        
        return Math.abs(tNorm) > 1e-5 ? tNorm : 0;
    }

    static normalizePosition(pos) {
        // Wrap to [0, 1)
        pos.x = pos.x - Math.floor(pos.x);
        pos.y = pos.y - Math.floor(pos.y);
        pos.z = pos.z - Math.floor(pos.z);
        
        // If very close to 1, make 0
        if (Math.abs(pos.x - 1) < 1e-5) pos.x = 0;
        if (Math.abs(pos.y - 1) < 1e-5) pos.y = 0;
        if (Math.abs(pos.z - 1) < 1e-5) pos.z = 0;
    }

    static filterDuplicates(elements) {
        const unique = [];
        elements.forEach(el => {
            let exists = false;
            for (let u of unique) {
                if (u.type !== el.type) continue;
                
                // Check position distance (accounting for PBC)
                // For planes, check normal and constant
                if (el.type === 'plane') {
                    if (Math.abs(u.normal.dot(el.normal)) > 0.9) {
                        // Same normal direction (or opposite)
                        // If opposite, constant sign flips? 
                        // n.x = C vs -n.x = -C => same plane
                        
                        let c1 = u.constant;
                        let c2 = el.constant;
                        
                        // Normalize C to [0, |n|] ?
                        // Just check distance between planes
                        // dist = |C1 - C2| / |n|? n is normalized.
                        // But PBC...
                        
                        if (Math.abs(c1 - c2) < 0.01) {
                            exists = true;
                            break;
                        }
                    }
                } else {
                    const dx = Math.abs(u.pos.x - el.pos.x);
                    const dy = Math.abs(u.pos.y - el.pos.y);
                    const dz = Math.abs(u.pos.z - el.pos.z);
                    
                    if (dx < 0.01 && dy < 0.01 && dz < 0.01) {
                        if (el.type === 'rotation') {
                            if (Math.abs(u.axis.dot(el.axis)) > 0.9) {
                                exists = true;
                                break;
                            }
                        } else {
                            exists = true;
                            break;
                        }
                    }
                }
            }
            if (!exists) unique.push(el);
        });
        return unique;
    }
}
