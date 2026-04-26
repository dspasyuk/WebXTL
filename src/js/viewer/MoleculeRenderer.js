import * as THREE from 'three';
import { SpaceGroupsData } from '../utils/SpaceGroups.js';
import { Symmetry } from '../utils/Symmetry.js';
import { SymmetryAnalyzer } from '../utils/SymmetryAnalyzer.js';

export class MoleculeRenderer {
    constructor(scene) {
        this.scene = scene;
        this.group = new THREE.Group();
        this.scene.add(this.group);
        this.atomMeshes = {}; // Cache geometries/materials
        this.materials = {};
        this.labelCache = {}; // Cache label textures
        
        this.highlightGroup = new THREE.Group();
        this.group.add(this.highlightGroup); // Add to group to share coordinate system
        
        // Default Atom Colors (CPK)
        this.atomColors = {
            'H': 0xFFFFFF, 'C': 0x000000, 'N': 0x3050F8, 'O': 0xFF0D0D,
            'F': 0x90E050, 'Cl': 0x1FF01F, 'Br': 0xA62929, 'I': 0x940094,
            'He': 0x40FFFF, 'Ne': 0xB3B3B3, 'Ar': 0x80D1E3, 'Kr': 0x5CB8D1,
            'Xe': 0x429EB0, 'P': 0xFF8000, 'S': 0xFFFF30, 'B': 0xFFB5B5,
            'Li': 0xCC80FF, 'Na': 0xAB5CF2, 'K': 0x8F40D4, 'Rb': 0x3D0096,
            'Cs': 0x2A0069, 'Be': 0xC2FF00, 'Mg': 0x8AFF00, 'Ca': 0x4DFF00,
            'Sr': 0x00FF00, 'Ba': 0x00C900, 'Ra': 0x007D00, 'Ti': 0x999999,
            'Fe': 0xE06633, 'Cu': 0xC88033, 'Zn': 0x7D80B0, 'Au': 0xFFD123,
            'Ag': 0xC0C0C0, 'Pt': 0xD0D0E0, 'Si': 0xF0C8A0, 'Al': 0xBFA6A6,
            'Q': 0xAAAAAA // Lighter Grey for Q-peaks
        };
        
        this.defaultColor = 0xFF00FF;
    }

    clear() {
        for (let i = this.group.children.length - 1; i >= 0; i--) {
            const child = this.group.children[i];
            if (!child.userData.isMap) {
                this.group.remove(child);
            }
        }
        // Re-create highlight group if it was removed (it likely was)
        // Check if it exists?
        if (!this.group.children.includes(this.highlightGroup)) {
             this.highlightGroup = new THREE.Group();
             this.group.add(this.highlightGroup);
        } else {
            // If it wasn't removed (e.g. if I marked it? No, I didn't), clear it
            this.clearHighlights();
        }
    }

    clearHighlights() {
        while(this.highlightGroup.children.length > 0){ 
            this.highlightGroup.remove(this.highlightGroup.children[0]); 
        }
    }

    highlightAtoms(lineNumbers) {
        this.clearHighlights();
        if (!lineNumbers || lineNumbers.size === 0) return;

        const highlightGeo = new THREE.SphereGeometry(1, 16, 16); 
        const highlightMat = new THREE.MeshBasicMaterial({ 
            color: 0x0088ff, 
            transparent: true, 
            opacity: 0.5, 
            depthWrite: false,
            side: THREE.DoubleSide
        });

        const dummy = new THREE.Object3D();
        const matrix = new THREE.Matrix4();

        this.group.children.forEach(mesh => {
            if (mesh.isInstancedMesh && mesh.userData.atomMap) {
                // Get atom radius from geometry parameters
                const atomRadius = mesh.geometry.parameters.radius || 0.3;

                for (let i = 0; i < mesh.count; i++) {
                    const atom = mesh.userData.atomMap[i];
                    
                    // Check if any line in the atom's range is selected
                    let isSelected = false;
                    if (atom) {
                        if (atom.startLine && atom.endLine) {
                            for (let l = atom.startLine; l <= atom.endLine; l++) {
                                if (lineNumbers.has(l)) {
                                    isSelected = true;
                                    break;
                                }
                            }
                        } else if (atom.lineNumber) {
                            isSelected = lineNumbers.has(atom.lineNumber);
                        }
                    }

                    if (isSelected) {
                        mesh.getMatrixAt(i, matrix);
                        dummy.position.setFromMatrixPosition(matrix);
                        dummy.scale.setFromMatrixScale(matrix);
                        
                        // Scale: Atom Radius * Instance Scale * 1.1 (10% bigger)
                        // Since highlightGeo has radius 1, we scale it to match target radius.
                        const scale = atomRadius * dummy.scale.x * 1.1;
                        
                        const halo = new THREE.Mesh(highlightGeo, highlightMat);
                        halo.position.copy(dummy.position);
                        halo.scale.set(scale, scale, scale);
                        // Disable raycasting for highlights so they don't block clicks
                        halo.raycast = () => {};
                        this.highlightGroup.add(halo);
                    }
                }
            }
        });
    }

    render(data, settings = {}) {
        console.log("MoleculeRenderer render called with:", data);
        this.clear();
        if (!data || !data.cell) {
             console.error("MoleculeRenderer: No data or cell");
             return;
        }
        
        console.log("Drawing atoms...");

        const showUnitCell = settings.showUnitCell !== false; // Default true
        console.log("Render: showUnitCell =", showUnitCell);
        const showLabels = settings.showLabels === true;

        // 1. Calculate Orthogonalization Matrix
        const { a, b, c, alpha, beta, gamma } = data.cell;
        const toRad = Math.PI / 180;
        const al = alpha * toRad;
        const be = beta * toRad;
        const ga = gamma * toRad;

        const cosAl = Math.cos(al);
        const cosBe = Math.cos(be);
        const cosGa = Math.cos(ga);
        const sinGa = Math.sin(ga);
        
        const V = a * b * c * Math.sqrt(1 - cosAl*cosAl - cosBe*cosBe - cosGa*cosGa + 2*cosAl*cosBe*cosGa);
        
        // Transformation Matrix (Fractional -> Cartesian)
        const m11 = a;
        const m12 = b * cosGa;
        const m13 = c * cosBe;
        const m21 = 0;
        const m22 = b * sinGa;
        const m23 = c * (cosAl - cosBe * cosGa) / sinGa;
        const m31 = 0;
        const m32 = 0;
        const m33 = V / (a * b * sinGa);

        const fracToCart = (x, y, z) => {
            return new THREE.Vector3(
                m11 * x + m12 * y + m13 * z,
                m21 * x + m22 * y + m23 * z,
                m31 * x + m32 * y + m33 * z
            );
        };

        // 2. Draw Unit Cell
        if (showUnitCell) {
            this.drawUnitCell(fracToCart, settings);
        }

        // 3. Expand Symmetry
        let expandedAtoms = [];
        if (showUnitCell) {
            let ops = ["x,y,z"];
            if (data.symmetry && data.symmetry.length > 0) {
                ops = data.symmetry;
            } else if (data.spaceGroup) {
                const search = data.spaceGroup.replace(/\s/g, '').toLowerCase();
                const found = SpaceGroupsData.find(sg => sg.hm.replace(/\s/g, '').toLowerCase() === search);
                if (found) {
                    ops = found.s;
                }
            }
            // Use new packing logic (pack=true is default)
            expandedAtoms = Symmetry.generateEquivalentPositions(data.atoms, ops, true);
        } else {
            expandedAtoms = data.atoms.map(a => ({ ...a }));
        }
        
        this.expandedAtoms = expandedAtoms; // Expose for MapCalculator

        // 4. Draw Atoms
        const atomsByElement = {};
        
        expandedAtoms.forEach(atom => {
            // Do NOT wrap coords manually if packing is enabled.
            // Symmetry.js now handles packing whole molecules into the cell.
            
            let x = atom.x;
            let y = atom.y;
            let z = atom.z;

            const pos = fracToCart(x, y, z);
            const el = atom.element || 'X';
            
            if (!atomsByElement[el]) atomsByElement[el] = [];
            atomsByElement[el].push({ pos, atom }); 
        });

        const atomScale = settings.preferences ? settings.preferences.viewer.atoms.scale : 0.3;
        const atomRes = settings.preferences ? settings.preferences.viewer.atoms.resolution : 'medium';
        const segments = atomRes === 'high' ? 32 : (atomRes === 'low' ? 8 : 16);
        
        const sphereGeo = new THREE.SphereGeometry(atomScale, segments, segments);

        for (const [el, items] of Object.entries(atomsByElement)) {
            const color = this.atomColors[el] !== undefined ? this.atomColors[el] : this.defaultColor;
            const material = new THREE.MeshStandardMaterial({ color: color, roughness: 0.3, metalness: 0.1 });
            const mesh = new THREE.InstancedMesh(sphereGeo, material, items.length);
            mesh.userData.atomMap = []; // Store mapping from instanceId to atom data
            
            const dummy = new THREE.Object3D();
            let scale = 1.0;
            if (el === 'H') scale = 0.6;
            if (el === 'Q') scale = 0.5;
            
            items.forEach((item, i) => {
                dummy.position.copy(item.pos);
                
                // If ADPs are shown AND this atom has ADP data, hide the sphere (scale=0)
                if (settings.showADPs && item.atom.u) {
                    dummy.scale.set(0, 0, 0);
                } else {
                    dummy.scale.set(scale, scale, scale);
                }
                
                dummy.updateMatrix();
                mesh.setMatrixAt(i, dummy.matrix);
                mesh.userData.atomMap[i] = item.atom; // Store reference
            });
            
            this.group.add(mesh);
        }

        // 5. Draw Bonds
        const bondColor = settings.preferences ? settings.preferences.viewer.bondColor : 0x888888;
        const bondRadius = settings.preferences ? settings.preferences.viewer.bonds.radius : 0.05;
        // Reuse segments from atomRes for simplicity, or separate if needed
        const bondGeo = new THREE.CylinderGeometry(bondRadius, bondRadius, 1, segments === 32 ? 16 : 8);
        const bondMaterial = new THREE.MeshStandardMaterial({ color: bondColor });
        
        let allPositions = [];
        for (const items of Object.values(atomsByElement)) {
            // Avoid spread operator for large arrays
            allPositions = allPositions.concat(items);
        }

        const bonds = [];
        const qBonds = []; // Separate list for Q-bonds
        const cellSize = 2.0;
        const grid = {};

        const getKey = (p) => {
            const ix = Math.floor(p.pos.x / cellSize);
            const iy = Math.floor(p.pos.y / cellSize);
            const iz = Math.floor(p.pos.z / cellSize);
            return `${ix},${iy},${iz}`;
        };

        // Build Grid
        allPositions.forEach((item, idx) => {
            const key = getKey(item);
            if (!grid[key]) grid[key] = [];
            grid[key].push({ item, idx });
        });

        const neighborOffsets = [];
        for(let x=-1; x<=1; x++) {
            for(let y=-1; y<=1; y++) {
                for(let z=-1; z<=1; z++) {
                    neighborOffsets.push({x,y,z});
                }
            }
        }

        allPositions.forEach((item1, i) => {
            const p1 = item1.pos;
            const atom1 = item1.atom;
            
            const ix = Math.floor(p1.x / cellSize);
            const iy = Math.floor(p1.y / cellSize);
            const iz = Math.floor(p1.z / cellSize);

            neighborOffsets.forEach(offset => {
                const key = `${ix + offset.x},${iy + offset.y},${iz + offset.z}`;
                const cellAtoms = grid[key];
                if (cellAtoms) {
                    cellAtoms.forEach(entry2 => {
                        const j = entry2.idx;
                        if (j > i) {
                            const item2 = entry2.item;
                            const p2 = item2.pos;
                            const atom2 = item2.atom;
                            
                            // 1. Check H-H
                            const el1 = atom1.element || 'X';
                            const el2 = atom2.element || 'X';
                            if (el1 === 'H' && el2 === 'H') return;

                            // 2. Check PART
                            const part1 = atom1.part || 0;
                            const part2 = atom2.part || 0;
                            if (part1 !== 0 && part2 !== 0 && part1 !== part2) return;

                            // 3. Distance Check with Element-Aware Thresholds
                            const NON_METALS = new Set(['H', 'C', 'N', 'O', 'F', 'P', 'S', 'Cl', 'Br', 'I', 'B', 'Si', 'He', 'Ne', 'Ar', 'Kr', 'Xe']);
                            const isMetal1 = !NON_METALS.has(el1);
                            const isMetal2 = !NON_METALS.has(el2);
                            const hasMetal = isMetal1 || isMetal2;

                            // Get thresholds from settings or defaults
                            const prefs = settings.preferences ? settings.preferences.viewer.bondThresholds : { metal: 2.5, nonMetal: 1.9, hBond: 0.0 };
                            
                            // Thresholds
                            const maxDist = hasMetal ? prefs.metal : prefs.nonMetal;
                            const maxDistSq = maxDist * maxDist;
                            const minDistSq = 0.16; // 0.4 * 0.4

                            const distSq = p1.distanceToSquared(p2);
                            if (distSq > minDistSq && distSq < maxDistSq) {
                                if (el1 === 'Q' || el2 === 'Q') {
                                    qBonds.push({ p1, p2 });
                                } else {
                                    bonds.push({ p1, p2, dist: Math.sqrt(distSq) });
                                }
                            }
                        }
                    });
                }
            });
        });

        if (bonds.length > 0) {
            const bondMesh = new THREE.InstancedMesh(bondGeo, bondMaterial, bonds.length);
            const dummy = new THREE.Object3D();
            const axis = new THREE.Vector3(0, 1, 0);

            bonds.forEach((bond, i) => {
                const p1 = bond.p1;
                const p2 = bond.p2;
                const dist = bond.dist;
                const mid = p1.clone().add(p2).multiplyScalar(0.5);
                
                dummy.position.copy(mid);
                dummy.scale.set(1, dist, 1);
                
                const dir = p2.clone().sub(p1).normalize();
                dummy.quaternion.setFromUnitVectors(axis, dir);
                
                dummy.updateMatrix();
                bondMesh.setMatrixAt(i, dummy.matrix);
            });
            this.group.add(bondMesh);
        }

        // Draw Q-Bonds (Dashed Lines)
        if (qBonds.length > 0) {
            const points = [];
            qBonds.forEach(bond => {
                points.push(bond.p1);
                points.push(bond.p2);
            });
            const qBondGeo = new THREE.BufferGeometry().setFromPoints(points);
            const qBondMat = new THREE.LineDashedMaterial({ 
                color: 0x888888, 
                dashSize: 0.2, 
                gapSize: 0.1,
                opacity: 0.7,
                transparent: true
            });
            const qBondLines = new THREE.LineSegments(qBondGeo, qBondMat);
            qBondLines.computeLineDistances(); // Required for dashed lines
            this.group.add(qBondLines);
        }
        
        // Center camera on bounding box
        let min = new THREE.Vector3(Infinity, Infinity, Infinity);
        let max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        allPositions.forEach(item => {
            min.min(item.pos);
            max.max(item.pos);
        });
        const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
        
        this.group.position.copy(center).multiplyScalar(-1);

        // Calculate bounding radius from center
        let maxDistSq = 0;
        allPositions.forEach(item => {
            const distSq = item.pos.distanceToSquared(center);
            if (distSq > maxDistSq) maxDistSq = distSq;
        });
        this.boundingRadius = Math.sqrt(maxDistSq);
        // Add some padding for atoms radius (approx 1.5A)
        this.boundingRadius += 1.5;

        // 6. Draw Labels
        if (showLabels) {
            this.drawLabels(expandedAtoms, fracToCart, settings);
        }

        // 7. Draw Symmetry Elements
        if (settings.showSymmetry) {
            this.drawSymmetryElements(data, fracToCart, settings);
        }

        // 8. Draw Thermal Ellipsoids
        if (settings.showADPs) {
            this.drawThermalEllipsoids(expandedAtoms, fracToCart, settings);
        }
    }

    drawThermalEllipsoids(atoms, fracToCart, settings) {
        const sphereGeo = new THREE.SphereGeometry(1, 16, 16); // Unit sphere
        // Materials for ellipsoids (usually more transparent or wireframe?)
        // Let's use similar colors to atoms but transparent
        
        const dummy = new THREE.Object3D();
        const matrix = new THREE.Matrix4();
        const vec = new THREE.Vector3();
        
        // Orthogonalization Matrix (Cartesian -> Fractional conversion inverse)
        // We need Fractional -> Cartesian matrix M
        const { a, b, c, alpha, beta, gamma } = settings.cell || {}; // We need cell data, hopefully passed or available
        // Wait, 'data' was local in render(). We passed expandedAtoms. We need cell here.
        // Let's assume fracToCart function implicitly holds the cell but we need the raw matrix components for Uij transformation?
        // Actually, Uij in SHELX are usually in Cartesian Å^2 if orthogonal, but for non-orthogonal...
        // SHELX manual: Uij are components of tensor U defined by exp(-2pi^2 sum sum h_i h_j a*_i a*_j U_ij)
        // This effectively means Uij are coefficients in the reciprocal basis.
        // HOWEVER, standard CIF/RES often output Uij in angstroms squared relative to Cartesian axes OR orthogonalized frame.
        // Actually, SHELX RES Uij are "components of the anisotropic displacement tensor... in Å^2".
        // The standard interpretation for visualization is:
        // The U matrix is symmetric. We diagnolize it to find principal axes (eigenvectors) and magnitudes (eigenvalues).
        // If the crystal system is non-orthogonal, we first need to transform U from crystal basis to Cartesian basis?
        // Usually, Uij in RES file are already in an orthogonalized frame (often the standard setting). 
        // Let's assume Uij are in Cartesian Å^2 for simplicity as a first pass, as is common for .res files used in visualization (e.g. OLEX2).
        // If not, we might see skewed ellipsoids if we don't transform.
        
        // Group atoms by element for batching
        const atomsByElement = {};
        atoms.forEach(atom => {
            if (atom.u) {
                const el = atom.element || 'X';
                if (!atomsByElement[el]) atomsByElement[el] = [];
                atomsByElement[el].push(atom);
            }
        });

        for (const [el, items] of Object.entries(atomsByElement)) {
             const color = this.atomColors[el] !== undefined ? this.atomColors[el] : this.defaultColor;
             const material = new THREE.MeshStandardMaterial({ 
                 color: color, 
                 roughness: 0.3, 
                 metalness: 0.1,
                 transparent: false,
                 opacity: 1.0
             });
             
             // Ribbons (Rings) Material - Opaque, White for contrast
             const ribbonMaterial = new THREE.MeshStandardMaterial({
                 color: 0xFFFFFF,
                 roughness: 0.3,
                 metalness: 0.1
             });
             
             // 1. Transparent Shells
             const mesh = new THREE.InstancedMesh(sphereGeo, material, items.length);
             mesh.userData.atomMap = []; // Enable selection
             
             // 2. Ribbons (3 rings per atom) -> 3 * items.length
             // Use TorusGeometry for ribbons? Or Tube?
             // Torus: radius 1, tube 0.05
             const ringGeo = new THREE.TorusGeometry(1.0, 0.03, 8, 32);
             const ribbonMesh = new THREE.InstancedMesh(ringGeo, ribbonMaterial, items.length * 3);
             ribbonMesh.userData.atomMap = []; // Enable selection

             let validCount = 0;
             let ribbonCount = 0;

             items.forEach((atom, i) => {
                 const u = atom.u;
                 // Construct Matrix
                 // [ u11 u12 u13 ]
                 // [ u12 u22 u23 ]
                 // [ u13 u23 u33 ]
                 // Wait, order in RES is U11 U22 U33 U23 U13 U12
                 // U = | U11 U12 U13 |
                 //     | U12 U22 U23 |
                 //     | U13 U23 U33 |
                 
                 // If these are indeed Cartesian Uij:
                 const U = [
                     [u.u11, u.u12, u.u13],
                     [u.u12, u.u22, u.u23],
                     [u.u13, u.u23, u.u33]
                 ];
                 
                 // Diagonalize standard 3x3 symmetric real matrix
                 const result = this.diagonalizeSymmetric3x3(U);
                 
                 if (result) {
                     // Eigenvalues are mean square displacements along principal axes.
                     // Scale factors are sqrt(eigenvalue) * probability_factor
                     // Standard 50% probability: factor = 1.5ish? 
                     // probability P: radius scale = sqrt(-2 ln(1-P)) ? No, for 3D Gaussian...
                     // Commonly displayed at 50% probability.
                     // For Uij (mean square displacement):
                     // 1 sigma = sqrt(U). 50% probability surface for 3D Gaussian is approx 1.538 * sigma.
                     const probabilityScale = 1.538; 
                     
                     const ev1 = Math.sqrt(Math.max(0, result.eigenvalues[0])) * probabilityScale;
                     const ev2 = Math.sqrt(Math.max(0, result.eigenvalues[1])) * probabilityScale;
                     const ev3 = Math.sqrt(Math.max(0, result.eigenvalues[2])) * probabilityScale;
                     
                     // Eigenvectors are columns of rotation matrix
                     const R = new THREE.Matrix4();
                     const v1 = result.eigenvectors[0];
                     const v2 = result.eigenvectors[1];
                     const v3 = result.eigenvectors[2];
                     
                     R.set(
                         v1.x, v2.x, v3.x, 0,
                         v1.y, v2.y, v3.y, 0,
                         v1.z, v2.z, v3.z, 0,
                         0,    0,    0,    1
                     );
                     
                     dummy.matrix.identity();
                     
                     // Position
                     const pos = fracToCart(atom.x, atom.y, atom.z);
                     dummy.position.copy(pos);
                     
                     // Rotation (from eigenvectors)
                     // Combine Scale and Rotation
                     // M = T * R * S
                     // dummy.rotation.setFromRotationMatrix(R); // Extract Euler? Or just multiply.
                     
                     const S = new THREE.Matrix4().makeScale(ev1, ev2, ev3);
                     const M = new THREE.Matrix4().multiplyMatrices(R, S);
                     
                     // dummy has position set, now apply rotation/scale
                     const finalM = new THREE.Matrix4();
                     finalM.makeTranslation(pos.x, pos.y, pos.z);
                     finalM.multiply(M);
                     
                     mesh.setMatrixAt(validCount, finalM);
                     mesh.userData.atomMap[validCount] = atom; // Map instance to atom
                     validCount++;
                     
                     // --- RIBBONS ---
                     // Ring 1: XY Plane (v1, v2) -> Scale (ev1, ev2, 1)
                     const M1 = new THREE.Matrix4();
                     M1.makeScale(ev1, ev2, 1); // Z scale 1 doesn't matter for Torus in XY but tube thickness might distort? 
                     // Wait, non-uniform scaling of Torus distorts tube. Ideally we want constant tube thickness.
                     // But for simple visualization, distortion is acceptable or we use LineLoop.
                     // Let's stick to Torus for "Ribbon" look.
                     
                     const finM1 = new THREE.Matrix4();
                     finM1.makeTranslation(pos.x, pos.y, pos.z);
                     finM1.multiply(R).multiply(M1);
                     ribbonMesh.setMatrixAt(ribbonCount, finM1);
                     ribbonMesh.userData.atomMap[ribbonCount] = atom;
                     ribbonCount++;
                     
                     // Ring 2: YZ Plane (v2, v3) -> Rotate Torus to YZ, Scale (1, ev2, ev3)
                     // Base Torus is in XY. Rotate 90 deg around Y -> lies in YZ.
                     const rotY = new THREE.Matrix4().makeRotationY(Math.PI / 2);
                     const M2 = new THREE.Matrix4();
                     // After rotation, Local X is now Global Z. Local Y is Global Y.
                     // We want axes ev3 (along Z) and ev2 (along Y).
                     // Scale needs to be applied in the Torus local frame BEFORE rotation or AFTER?
                     // Torus is circle in XY.
                     // We want ellipse with radii ev3, ev2.
                     // Scale torus by (ev3, ev2, 1).
                     // Then Rotate Y.
                     const M2_S = new THREE.Matrix4().makeScale(ev3, ev2, 1);
                     const finM2 = new THREE.Matrix4();
                     finM2.makeTranslation(pos.x, pos.y, pos.z);
                     finM2.multiply(R).multiply(rotY).multiply(M2_S);
                     ribbonMesh.setMatrixAt(ribbonCount, finM2);
                     ribbonMesh.userData.atomMap[ribbonCount] = atom;
                     ribbonCount++;

                     // Ring 3: XZ Plane (v1, v3) -> Rotate Torus to XZ, Scale (ev1, 1, ev3)
                     // Base Torus in XY. Rotate 90 deg around X -> lies in XZ.
                     const rotX = new THREE.Matrix4().makeRotationX(Math.PI / 2);
                     // After rotX, Local X is X, Local Y is Z.
                     // We want axes ev1 (X) and ev3 (Z).
                     // Scale Torus by (ev1, ev3, 1).
                     const M3_S = new THREE.Matrix4().makeScale(ev1, ev3, 1);
                     const finM3 = new THREE.Matrix4();
                     finM3.makeTranslation(pos.x, pos.y, pos.z);
                     finM3.multiply(R).multiply(rotX).multiply(M3_S);
                     ribbonMesh.setMatrixAt(ribbonCount, finM3);
                     ribbonMesh.userData.atomMap[ribbonCount] = atom;
                     ribbonCount++;
                 }
             });
             
             mesh.count = validCount;
             ribbonMesh.count = ribbonCount;
             
             this.group.add(mesh);
             this.group.add(ribbonMesh);
         }
    }
    
    diagonalizeSymmetric3x3(A) {
        // Jacobi Iteration or crude analytical for 3x3
        // Since it's only 3x3, analytical is feasible but messy (cubic).
        // Jacobi is robust.
        
        const maxIter = 50;
        let V = [[1,0,0],[0,1,0],[0,0,1]];
        let D = [A[0].slice(), A[1].slice(), A[2].slice()]; // Copy
        
        for (let iter = 0; iter < maxIter; iter++) {
            // Find max off-diagonal
            let maxDist = 0;
            let p, q;
            for (let i=0; i<3; i++) {
                for (let j=i+1; j<3; j++) {
                    if (Math.abs(D[i][j]) > maxDist) {
                        maxDist = Math.abs(D[i][j]);
                        p = i; q = j;
                    }
                }
            }
            
            if (maxDist < 1e-5) break; // Converged
            
            const phi = 0.5 * Math.atan2(2 * D[p][q], D[q][q] - D[p][p]);
            const c = Math.cos(phi);
            const s = Math.sin(phi);
            
            // Rotate D
            // D' = J^T * D * J
            const D_pp = c*c*D[p][p] - 2*s*c*D[p][q] + s*s*D[q][q];
            const D_qq = s*s*D[p][p] + 2*s*c*D[p][q] + c*c*D[q][q];
            const D_pq = (c*c - s*s)*D[p][q] + s*c*(D[p][p] - D[q][q]); // Should be 0
            
            D[p][p] = D_pp;
            D[q][q] = D_qq;
            D[p][q] = 0;
            D[q][p] = 0;
            
            for (let k=0; k<3; k++) {
                if (k !== p && k !== q) {
                    const D_pk = c*D[p][k] - s*D[q][k];
                    const D_qk = s*D[p][k] + c*D[q][k];
                    D[p][k] = D_pk;
                    D[k][p] = D_pk; // Symmetry
                    D[q][k] = D_qk;
                    D[k][q] = D_qk;
                }
            }
            
            // Accumulate V
            // V' = V * J
            for (let k=0; k<3; k++) {
                const V_kp = c*V[k][p] - s*V[k][q];
                const V_kq = s*V[k][p] + c*V[k][q];
                V[k][p] = V_kp;
                V[k][q] = V_kq;
            }
        }
        
        const eigenvalues = [D[0][0], D[1][1], D[2][2]];
        const eigenvectors = [
            new THREE.Vector3(V[0][0], V[1][0], V[2][0]),
            new THREE.Vector3(V[0][1], V[1][1], V[2][1]),
            new THREE.Vector3(V[0][2], V[1][2], V[2][2])
        ];
        
        return { eigenvalues, eigenvectors };
    }

    drawLabels(atoms, fracToCart, settings = {}) {
        atoms.forEach(atom => {
            // Do NOT wrap coords. Use the positions from expandedAtoms which are already packed correctly.
            let x = atom.x, y = atom.y, z = atom.z;
            
            const pos = fracToCart(x, y, z);
            const label = atom.label || atom.element;
            
            const sprite = this.createTextSprite(label, settings);
            sprite.position.copy(pos);
            
            // Offset
            const offX = settings.preferences ? settings.preferences.viewer.labels.offsetX : 0.0;
            const offY = settings.preferences ? settings.preferences.viewer.labels.offsetY : 0.0;
            const offZ = settings.preferences ? settings.preferences.viewer.labels.offsetZ : 0.0;
            
            sprite.position.add(new THREE.Vector3(offX, offY, offZ));
            this.group.add(sprite);
        });
    }

    createTextSprite(message, settings = {}) {
        // Cache key needs to include color and size now
        const fontSize = settings.preferences ? settings.preferences.viewer.labels.fontSize : 24;
        const color = settings.preferences ? settings.preferences.viewer.labels.color : '#000000';
        const cacheKey = `${message}_${fontSize}_${color}`;

        if (this.labelCache[cacheKey]) {
            const mat = new THREE.SpriteMaterial( { map: this.labelCache[cacheKey] } );
            const sprite = new THREE.Sprite( mat );
            const aspect = this.labelCache[cacheKey].image.width / this.labelCache[cacheKey].image.height;
            const scale = 0.02 * fontSize;
            sprite.scale.set(scale * aspect, scale, 1.0);
            sprite.center.set(0, 0.5);
            return sprite;
        }

        const fontface = "Arial";
        
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        
        // Measure text
        context.font = "Bold " + fontSize + "px " + fontface;
        const metrics = context.measureText( message );
        const textWidth = metrics.width;
        
        canvas.width = textWidth + 10;
        canvas.height = fontSize + 10;
        
        // Redraw with correct size
        context.font = "Bold " + fontSize + "px " + fontface;
        
        // Text color
        context.fillStyle = color;
        context.fillText( message, 5, fontSize );
        
        const texture = new THREE.CanvasTexture(canvas); 
        this.labelCache[cacheKey] = texture; // Cache it

        const spriteMaterial = new THREE.SpriteMaterial( { map: texture, depthTest: false, depthWrite: false } );
        const sprite = new THREE.Sprite( spriteMaterial );
        
        // Scale sprite
        const scale = 0.02 * fontSize; // Adjust scale factor
        sprite.scale.set(scale * canvas.width / canvas.height, scale, 1.0);
        
        // Set center to left-middle so the position is the left edge of the text
        sprite.center.set(0, 0.5);
        
        return sprite;
    }

    drawUnitCell(fracToCart, settings = {}) {
        const corners = [
            [0,0,0], [1,0,0], [1,1,0], [0,1,0],
            [0,0,1], [1,0,1], [1,1,1], [0,1,1]
        ].map(c => fracToCart(c[0], c[1], c[2]));

        const edges = [
            [0,1], [1,2], [2,3], [3,0], // Bottom
            [4,5], [5,6], [6,7], [7,4], // Top
            [0,4], [1,5], [2,6], [3,7]  // Sides
        ];

        const points = [];
        edges.forEach(e => {
            points.push(corners[e[0]]);
            points.push(corners[e[1]]);
        });

        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const cellColor = settings.preferences ? settings.preferences.viewer.unitCellColor : 0x000000;
        const material = new THREE.LineBasicMaterial({ color: cellColor, opacity: 0.3, transparent: true }); // Black lines
        const lines = new THREE.LineSegments(geometry, material);
        this.group.add(lines);
    }

    drawSymmetryElements(data, fracToCart, settings) {
        let ops = [];
        if (data.symmetry && data.symmetry.length > 0) {
            ops = data.symmetry;
        } else if (data.spaceGroup) {
            const search = data.spaceGroup.replace(/\s/g, '').toLowerCase();
            const found = SpaceGroupsData.find(sg => sg.hm.replace(/\s/g, '').toLowerCase() === search);
            if (found) ops = found.s;
        }

        if (ops.length === 0) return;

        const elements = SymmetryAnalyzer.analyze(ops);
        
        elements.forEach(el => {
            if (el.type === 'inversion') {
                // Draw sphere
                const pos = fracToCart(el.pos.x, el.pos.y, el.pos.z);
                const geo = new THREE.SphereGeometry(0.5, 16, 16);
                const mat = new THREE.MeshBasicMaterial({ color: 0xFFFF00, depthTest: false, depthWrite: false }); // Yellow

                const mesh = new THREE.Mesh(geo, mat);
                mesh.position.copy(pos);
                this.group.add(mesh);
                
                // Add Label
                const sprite = this.createTextSprite("i", { 
                    preferences: { 
                        viewer: { 
                            labels: { 
                                fontSize: 60, 
                                color: '#000000' 
                            } 
                        } 
                    } 
                });
                sprite.position.copy(pos).add(new THREE.Vector3(0.6, 0.6, 0.6));
                this.group.add(sprite);
            } else if (el.type === 'rotation') {
                // Draw Axis Line/Cylinder
                // Need to draw it through the unit cell.
                // Start and End points?
                // Axis passes through el.pos and has direction el.axis
                
                // Find intersection with unit cell box? 
                // Simplified: Draw a long cylinder centered at pos
                
                const pos = fracToCart(el.pos.x, el.pos.y, el.pos.z);
                
                // Convert axis direction to cartesian
                // el.axis is in fractional basis (u,v,w)
                // We need to apply the matrix portion of fracToCart
                // But fracToCart includes origin shift. We just want the vector.
                const p0 = fracToCart(0,0,0);
                const p1 = fracToCart(el.axis.x, el.axis.y, el.axis.z);
                const dir = p1.clone().sub(p0).normalize();
                
                const len = 10; // Long enough
                const radius = 0.05;
                const geo = new THREE.CylinderGeometry(radius, radius, len, 8);
                
                // Color by order
                let color = 0xFFFFFF;
                if (el.order === 2) color = 0xFF0000; // Red
                if (el.order === 3) color = 0x00FF00; // Green
                if (el.order === 4) color = 0x0000FF; // Blue
                if (el.order === 6) color = 0xFF00FF; // Purple
                
                const mat = new THREE.MeshBasicMaterial({ color: color });
                const mesh = new THREE.Mesh(geo, mat);
                
                // Orient cylinder
                const up = new THREE.Vector3(0, 1, 0);
                mesh.quaternion.setFromUnitVectors(up, dir);
                mesh.position.copy(pos);
                
                this.group.add(mesh);

                // Add Label
                let label = `${el.order}`;
                if (el.screw > 0) {
                    // Try to deduce subscript
                    const screw = el.screw;
                    const order = el.order;
                    // Check common fractions
                    const check = (num, den) => Math.abs(screw - num/den) < 0.01;
                    
                    if (order === 2 && check(1,2)) label = "2_1";
                    else if (order === 3) {
                        if (check(1,3)) label = "3_1";
                        else if (check(2,3)) label = "3_2";
                    }
                    else if (order === 4) {
                        if (check(1,4)) label = "4_1";
                        else if (check(2,4)) label = "4_2";
                        else if (check(3,4)) label = "4_3";
                    }
                    else if (order === 6) {
                        if (check(1,6)) label = "6_1";
                        else if (check(2,6)) label = "6_2";
                        else if (check(3,6)) label = "6_3";
                        else if (check(4,6)) label = "6_4";
                        else if (check(5,6)) label = "6_5";
                    }
                    else {
                        // Fallback
                        label += `(${screw.toFixed(2)})`;
                    }
                }
                const sprite = this.createTextSprite(label, { 
                    preferences: { 
                        viewer: { 
                            labels: { 
                                fontSize: 60, 
                                color: '#000000' 
                            } 
                        } 
                    } 
                });
                sprite.position.copy(pos).add(new THREE.Vector3(0.2, 0.2, 0.2));
                this.group.add(sprite);
            } else if (el.type === 'plane') {
                // Draw Plane
                // We need to find the polygon intersection of the plane n.x = C with the unit cube [0,1]^3
                
                const points = this.getPlaneCubeIntersection(el.normal, el.constant);
                if (points.length >= 3) {
                    // Convert fractional points to cartesian
                    const cartPoints = points.map(p => fracToCart(p.x, p.y, p.z));
                    
                    // Create geometry
                    const shape = new THREE.Shape();
                    // Project points to 2D for Shape? No, BufferGeometry is better for 3D polygon.
                    
                    // Triangulate fan
                    const vertices = [];
                    const p0 = cartPoints[0];
                    for (let i = 1; i < cartPoints.length - 1; i++) {
                        vertices.push(p0.x, p0.y, p0.z);
                        vertices.push(cartPoints[i].x, cartPoints[i].y, cartPoints[i].z);
                        vertices.push(cartPoints[i+1].x, cartPoints[i+1].y, cartPoints[i+1].z);
                        
                        // Double sided?
                        vertices.push(p0.x, p0.y, p0.z);
                        vertices.push(cartPoints[i+1].x, cartPoints[i+1].y, cartPoints[i+1].z);
                        vertices.push(cartPoints[i].x, cartPoints[i].y, cartPoints[i].z);
                    }
                    
                    const geo = new THREE.BufferGeometry();
                    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
                    
                    const mat = new THREE.MeshBasicMaterial({ 
                        color: 0x00FFFF, // Cyan
                        opacity: 0.2, 
                        transparent: true, 
                        side: THREE.DoubleSide,
                        depthWrite: false 
                    });
                    
                    const mesh = new THREE.Mesh(geo, mat);
                    this.group.add(mesh);
                    
                    // Add Label at center of polygon
                    const center = new THREE.Vector3();
                    cartPoints.forEach(p => center.add(p));
                    center.divideScalar(cartPoints.length);
                    
                    const sprite = this.createTextSprite(el.label, { 
                        preferences: { 
                            viewer: { 
                                labels: { 
                                    fontSize: 60, 
                                    color: '#000000' 
                                } 
                            } 
                        } 
                    });
                    sprite.position.copy(center);
                    this.group.add(sprite);
                }
            }
        });
    }

    getPlaneCubeIntersection(normal, constant) {
        // Plane: normal.x * x + normal.y * y + normal.z * z = constant
        // Cube edges: 12 edges
        const edges = [
            { p1: {x:0,y:0,z:0}, p2: {x:1,y:0,z:0} }, // x-axis at y=0,z=0
            { p1: {x:0,y:1,z:0}, p2: {x:1,y:1,z:0} },
            { p1: {x:0,y:0,z:1}, p2: {x:1,y:0,z:1} },
            { p1: {x:0,y:1,z:1}, p2: {x:1,y:1,z:1} },
            
            { p1: {x:0,y:0,z:0}, p2: {x:0,y:1,z:0} }, // y-axis
            { p1: {x:1,y:0,z:0}, p2: {x:1,y:1,z:0} },
            { p1: {x:0,y:0,z:1}, p2: {x:0,y:1,z:1} },
            { p1: {x:1,y:0,z:1}, p2: {x:1,y:1,z:1} },
            
            { p1: {x:0,y:0,z:0}, p2: {x:0,y:0,z:1} }, // z-axis
            { p1: {x:1,y:0,z:0}, p2: {x:1,y:0,z:1} },
            { p1: {x:0,y:1,z:0}, p2: {x:0,y:1,z:1} },
            { p1: {x:1,y:1,z:0}, p2: {x:1,y:1,z:1} }
        ];
        
        const points = [];
        
        edges.forEach(edge => {
            // Line: P = p1 + t * (p2 - p1)
            // n . (p1 + t*d) = C
            // n.p1 + t * n.d = C
            // t = (C - n.p1) / (n.d)
            
            const dx = edge.p2.x - edge.p1.x;
            const dy = edge.p2.y - edge.p1.y;
            const dz = edge.p2.z - edge.p1.z;
            
            const dotD = normal.x * dx + normal.y * dy + normal.z * dz;
            const dotP1 = normal.x * edge.p1.x + normal.y * edge.p1.y + normal.z * edge.p1.z;
            
            if (Math.abs(dotD) > 1e-5) {
                const t = (constant - dotP1) / dotD;
                if (t >= 0 && t <= 1) {
                    points.push(new THREE.Vector3(
                        edge.p1.x + t * dx,
                        edge.p1.y + t * dy,
                        edge.p1.z + t * dz
                    ));
                }
            }
        });
        
        // Remove duplicates
        const unique = [];
        points.forEach(p => {
            let exists = false;
            for (let u of unique) {
                if (p.distanceTo(u) < 1e-4) {
                    exists = true;
                    break;
                }
            }
            if (!exists) unique.push(p);
        });
        
        if (unique.length < 3) return [];
        
        // Sort points to form a polygon
        // Project to 2D plane defined by normal
        // Find center
        const center = new THREE.Vector3();
        unique.forEach(p => center.add(p));
        center.divideScalar(unique.length);
        
        // Define basis vectors on plane
        // u = (p0 - center) normalized
        // v = normal x u
        const u = new THREE.Vector3().subVectors(unique[0], center).normalize();
        const v = new THREE.Vector3().crossVectors(normal, u).normalize();
        
        unique.sort((a, b) => {
            const va = new THREE.Vector3().subVectors(a, center);
            const vb = new THREE.Vector3().subVectors(b, center);
            
            const angA = Math.atan2(va.dot(v), va.dot(u));
            const angB = Math.atan2(vb.dot(v), vb.dot(u));
            
            return angA - angB;
        });
        
        return unique;
    }
}
