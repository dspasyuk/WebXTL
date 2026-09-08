// Molecule clustering: groups atoms into molecules by connectivity
// (bond distances + periodic boundary conditions) and produces a
// relabeling plan that numbers atoms per element in molecule order:
// molecule 1 gets C1 C2 O1, molecule 2 gets C3 C4 O2, etc.

const COVALENT_RADII = {
    H: 0.31, C: 0.76, N: 0.71, O: 0.66, F: 0.57, P: 1.07, S: 1.05,
    Cl: 1.02, Br: 1.20, I: 1.39, B: 0.84, Si: 1.11, Na: 1.66, K: 2.03,
    Mg: 1.41, Ca: 1.76, Li: 1.28, Mn: 1.39, Fe: 1.32, Co: 1.26, Ni: 1.24,
    Cu: 1.32, Zn: 1.22, Se: 1.20, Q: 1.70
};

const DEFAULT_BOND_FACTOR = 1.25;

export class MoleculeCluster {
    constructor(cell, atoms, options = {}) {
        this.cell = cell;
        this.atoms = atoms;
        this.bondFactor = options.bondFactor || DEFAULT_BOND_FACTOR;
        this.minBond = options.minBond || 0.85;
        this.maxBond = options.maxBond || 2.2;
    }

    // Fractional -> Cartesian (same convention as main.js calculateDistance)
    fracToCartesian(x, y, z) {
        const { a, b, c, alpha, beta, gamma } = this.cell;
        const toRad = Math.PI / 180;
        const al = alpha * toRad;
        const be = beta * toRad;
        const ga = gamma * toRad;

        const cosAl = Math.cos(al);
        const cosBe = Math.cos(be);
        const cosGa = Math.cos(ga);
        const sinGa = Math.sin(ga);

        const V = a * b * c * Math.sqrt(1 - cosAl * cosAl - cosBe * cosBe - cosGa * cosGa + 2 * cosAl * cosBe * cosGa);

        const m11 = a;
        const m12 = b * cosGa;
        const m13 = c * cosBe;
        const m22 = b * sinGa;
        const m23 = c * (cosAl - cosBe * cosGa) / sinGa;
        const m33 = V / (a * b * sinGa);

        return {
            x: m11 * x + m12 * y + m13 * z,
            y: m22 * y + m23 * z,
            z: m33 * z
        };
    }

    // Minimum-image distance in Cartesian space
    distance(i, j) {
        const A = this.atoms[i];
        const B = this.atoms[j];
        const p1 = this.fracToCartesian(A.x, A.y, A.z);
        const p2 = this.fracToCartesian(B.x, B.y, B.z);
        const { a, b, c } = this.cell;
        const dx = p1.x - p2.x;
        const dy = p1.y - p2.y;
        const dz = p1.z - p2.z;
        // For non-orthogonal cells the minimum image is approximate,
        // which is acceptable for clustering purposes.
        const mx = ((dx % a) + a) % a;
        const my = ((dy % b) + b) % b;
        const mz = ((dz % c) + c) % c;
        const fx = Math.min(mx, a - mx);
        const fy = Math.min(my, b - my);
        const fz = Math.min(mz, c - mz);
        return Math.sqrt(fx * fx + fy * fy + fz * fz);
    }

    bondCutoff(el1, el2) {
        const r1 = COVALENT_RADII[(el1 || '').toUpperCase()] || 1.5;
        const r2 = COVALENT_RADII[(el2 || '').toUpperCase()] || 1.5;
        return (r1 + r2) * this.bondFactor;
    }

    // Build adjacency list using bond distance cutoffs
    buildGraph() {
        const n = this.atoms.length;
        const adj = Array.from({ length: n }, () => []);
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const d = this.distance(i, j);
                if (d < this.minBond) continue;
                const cutoff = this.bondCutoff(this.atoms[i].element, this.atoms[j].element);
                if (d <= Math.min(cutoff, this.maxBond)) {
                    adj[i].push(j);
                    adj[j].push(i);
                }
            }
        }
        return adj;
    }

    // Connected components = molecules
    findMolecules() {
        const adj = this.buildGraph();
        const n = this.atoms.length;
        const visited = new Array(n).fill(false);
        const molecules = [];
        for (let i = 0; i < n; i++) {
            if (visited[i]) continue;
            const indices = [];
            const queue = [i];
            visited[i] = true;
            while (queue.length) {
                const cur = queue.shift();
                indices.push(cur);
                for (const nb of adj[cur]) {
                    if (!visited[nb]) {
                        visited[nb] = true;
                        queue.push(nb);
                    }
                }
            }
            molecules.push({ indices });
        }
        return molecules;
    }

    // Walk the molecule by proximity: start from the atom closest to the
    // molecule centroid, then repeatedly visit the nearest not-yet-visited
    // neighbor. Returns atom indices in walk order.
    walkOrder(indices, centroid) {
        // Start from the atom nearest to the centroid
        let current = indices[0];
        let bestDist = Infinity;
        indices.forEach(i => {
            const a = this.atoms[i];
            const dx = a.x - centroid.x;
            const dy = a.y - centroid.y;
            const dz = a.z - centroid.z;
            const d = dx * dx + dy * dy + dz * dz;
            if (d < bestDist) {
                bestDist = d;
                current = i;
            }
        });

        const order = [current];
        const visited = new Set([current]);
        while (order.length < indices.length) {
            let next = -1;
            let nd = Infinity;
            indices.forEach(i => {
                if (visited.has(i)) return;
                const d = this.distance(current, i);
                if (d < nd) {
                    nd = d;
                    next = i;
                }
            });
            if (next === -1) break;
            order.push(next);
            visited.add(next);
            current = next;
        }
        return order;
    }

    // Element counts for a set of atom indices
    composition(indices) {
        const counts = {};
        indices.forEach(i => {
            const el = (this.atoms[i].element || 'C').toUpperCase();
            counts[el] = (counts[el] || 0) + 1;
        });
        return counts;
    }

    // Build the full relabeling plan.
    // Returns { molecules: [{ indices, composition, centroid }], plan: [{ index, oldLabel, newLabel }] }
    buildPlan() {
        const molecules = this.findMolecules();

        // Order molecules by position: x, then y, then z (centroid in fractional coords)
        molecules.forEach(mol => {
            let cx = 0, cy = 0, cz = 0;
            mol.indices.forEach(i => {
                cx += this.atoms[i].x;
                cy += this.atoms[i].y;
                cz += this.atoms[i].z;
            });
            mol.centroid = { x: cx / mol.indices.length, y: cy / mol.indices.length, z: cz / mol.indices.length };
            mol.composition = this.composition(mol.indices);
        });

        molecules.sort((m1, m2) => {
            const dx = m1.centroid.x - m2.centroid.x;
            if (Math.abs(dx) > 1e-6) return dx;
            const dy = m1.centroid.y - m2.centroid.y;
            if (Math.abs(dy) > 1e-6) return dy;
            return m1.centroid.z - m2.centroid.z;
        });

        // Number atoms per element, continuing across molecules in order.
        // Within each molecule, atoms are ordered by a proximity walk
        // (nearest-neighbor traversal starting from the atom closest to the
        // molecule centroid) so labels follow the physical layout.
        const counters = {};
        const plan = [];
        molecules.forEach((mol, mi) => {
            const ordered = this.walkOrder(mol.indices, mol.centroid);
            ordered.forEach(i => {
                const atom = this.atoms[i];
                const el = (atom.element || 'C').toUpperCase();
                counters[el] = (counters[el] || 0) + 1;
                // Preserve any trailing suffix (e.g. disorder letters: C1A -> C3A)
                const suffixMatch = atom.label.match(/\d+([A-Za-z]+)$/);
                const suffix = suffixMatch ? suffixMatch[1] : '';
                plan.push({
                    index: i,
                    molecule: mi + 1,
                    oldLabel: atom.label,
                    newLabel: el + counters[el] + suffix
                });
            });
        });

        return { molecules, plan };
    }
}
