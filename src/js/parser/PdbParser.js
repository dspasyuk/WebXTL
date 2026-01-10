import { SpaceGroupsData } from '../utils/SpaceGroups.js';
import * as THREE from 'three';

export class PdbParser {
    constructor() {
        this.data = {
            title: '',
            cell: { a: 10, b: 10, c: 10, alpha: 90, beta: 90, gamma: 90 }, // Default cell
            atoms: [],
            spaceGroup: 'P 1',
            symmetry: []
        };
        this.hasCell = false;
    }

    parse(content) {
        this.data = {
            title: '',
            cell: { a: 10, b: 10, c: 10, alpha: 90, beta: 90, gamma: 90 },
            atoms: [],
            spaceGroup: 'P 1',
            symmetry: []
        };
        this.hasCell = false;

        const lines = content.split('\n');
        
        // First pass: Look for CRYST1
        for (let line of lines) {
            if (line.startsWith('CRYST1')) {
                this.parseCryst1(line);
                // Check for dummy cell (common in EM)
                if (this.data.cell.a === 1.0 && this.data.cell.b === 1.0 && this.data.cell.c === 1.0) {
                    this.hasCell = false; // Ignore it
                    console.log("Ignored dummy CRYST1 (1x1x1)");
                } else {
                    this.hasCell = true;
                }
                break;
            }
        }

        // Calculate conversion matrix if cell exists
        let cartToFrac = null;
        if (this.hasCell) {
            cartToFrac = this.getCartToFracMatrix(this.data.cell);
        }

        // Second pass: Parse Atoms
        for (let line of lines) {
            if (line.startsWith('ATOM') || line.startsWith('HETATM')) {
                this.parseAtom(line, cartToFrac);
            } else if (line.startsWith('TITLE ')) {
                this.data.title += line.substring(10).trim() + ' ';
            }
        }

        // If no cell, calculate bounding box and normalize
        if (!this.hasCell && this.data.atoms.length > 0) {
            console.log("Calculating bounding box for " + this.data.atoms.length + " atoms");
            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

            this.data.atoms.forEach(atom => {
                if (atom.originalX < minX) minX = atom.originalX;
                if (atom.originalY < minY) minY = atom.originalY;
                if (atom.originalZ < minZ) minZ = atom.originalZ;
                if (atom.originalX > maxX) maxX = atom.originalX;
                if (atom.originalY > maxY) maxY = atom.originalY;
                if (atom.originalZ > maxZ) maxZ = atom.originalZ;
            });

            console.log(`Bounding Box: [${minX}, ${minY}, ${minZ}] to [${maxX}, ${maxY}, ${maxZ}]`);

            const padding = 2.0;
            const sizeX = maxX - minX + padding * 2;
            const sizeY = maxY - minY + padding * 2;
            const sizeZ = maxZ - minZ + padding * 2;
            
            console.log(`Cell Size: ${sizeX}, ${sizeY}, ${sizeZ}`);

            // Update cell
            this.data.cell.a = sizeX;
            this.data.cell.b = sizeY;
            this.data.cell.c = sizeZ;
            this.data.cell.alpha = 90;
            this.data.cell.beta = 90;
            this.data.cell.gamma = 90;

            // Normalize atoms
            this.data.atoms.forEach(atom => {
                atom.x = (atom.originalX - minX + padding) / sizeX;
                atom.y = (atom.originalY - minY + padding) / sizeY;
                atom.z = (atom.originalZ - minZ + padding) / sizeZ;
            });
            
            if (this.data.atoms.length > 0) {
                console.log("First atom normalized:", this.data.atoms[0]);
            }
        } else {
             console.log("Using existing cell:", this.data.cell);
             console.log("Atoms count:", this.data.atoms.length);
        }
        
        console.log("PdbParser result:", this.data);
        return this.data;
    }

    parseCryst1(line) {
        // cols 7-15: a
        // cols 16-24: b
        // cols 25-33: c
        // cols 34-40: alpha
        // cols 41-47: beta
        // cols 48-54: gamma
        // cols 56-66: Space group symbol
        
        this.data.cell.a = parseFloat(line.substring(6, 15));
        this.data.cell.b = parseFloat(line.substring(15, 24));
        this.data.cell.c = parseFloat(line.substring(24, 33));
        this.data.cell.alpha = parseFloat(line.substring(33, 40));
        this.data.cell.beta = parseFloat(line.substring(40, 47));
        this.data.cell.gamma = parseFloat(line.substring(47, 54));
        
        const spaceGroup = line.substring(55, 66).trim();
        this.data.spaceGroup = spaceGroup;

        // Lookup symmetry
        this.lookupSymmetry(spaceGroup);
    }

    lookupSymmetry(sgName) {
        // Normalize space group name: remove extra spaces, handle different formats
        // PDB often uses "P 21 21 21", SpaceGroupsData uses "P 21 21 21" or "P212121"
        // We try exact match first, then normalized.
        
        let found = SpaceGroupsData.find(sg => sg.hm === sgName || sg.hs === sgName);
        
        if (!found) {
            // Try normalizing spaces: "P 21 21 21" -> "P 21 21 21" (standardize spacing)
            // Or remove spaces: "P212121"
            const cleanName = sgName.replace(/\s+/g, ' ').trim();
            found = SpaceGroupsData.find(sg => sg.hm === cleanName || sg.hs === cleanName);
            
            if (!found) {
                 // Try removing all spaces
                 const noSpaceName = sgName.replace(/\s+/g, '');
                 // This might be risky if SpaceGroupsData relies on spaces, but let's check
                 // Actually SpaceGroupsData keys have spaces.
                 // Let's try to match by removing spaces from BOTH
                 found = SpaceGroupsData.find(sg => sg.hm.replace(/\s+/g, '') === noSpaceName || sg.hs.replace(/\s+/g, '') === noSpaceName);
            }
        }

        if (found) {
            console.log(`Found symmetry for ${sgName}:`, found.hm);
            this.data.symmetry = found.s;
        } else {
            console.warn(`Symmetry not found for space group: "${sgName}"`);
            // Default to P1
            this.data.symmetry = ["x,y,z"];
        }
    }

    parseAtom(line, cartToFrac) {
        // cols 13-16: Atom name
        // cols 17: AltLoc
        // cols 31-38: x
        // cols 39-46: y
        // cols 47-54: z
        // cols 55-60: Occupancy
        // cols 61-66: TempFactor
        // cols 77-78: Element symbol
        
        const name = line.substring(12, 16).trim();
        const altLoc = line.charAt(16);
        if (altLoc !== ' ' && altLoc !== 'A' && altLoc !== '1') return; // Skip alt locs for now

        const x = parseFloat(line.substring(30, 38));
        const y = parseFloat(line.substring(38, 46));
        const z = parseFloat(line.substring(46, 54));
        const occ = parseFloat(line.substring(54, 60)) || 1.0;
        const b = parseFloat(line.substring(60, 66)) || 0.0;
        
        let element = line.substring(76, 78).trim();
        if (!element) {
            // Deduce from name
            element = name.replace(/[0-9]/g, '');
            if (element.length > 2) element = element.substring(0, 2); // Heuristic
        }
        
        let atom = {
            label: name,
            element: element,
            x: x,
            y: y,
            z: z,
            occupancy: occ,
            uiso: b / (8 * Math.PI * Math.PI), // Convert B to Uiso roughly
            originalX: x,
            originalY: y,
            originalZ: z
        };

        if (cartToFrac) {
            const frac = this.applyMatrix(cartToFrac, {x, y, z});
            atom.x = frac.x;
            atom.y = frac.y;
            atom.z = frac.z;
        } else {
            // Store original for bounding box calc later
             atom.x = x;
             atom.y = y;
             atom.z = z;
        }

        this.data.atoms.push(atom);
    }

    getCartToFracMatrix(cell) {
        const a = cell.a;
        const b = cell.b;
        const c = cell.c;
        const alpha = cell.alpha * Math.PI / 180;
        const beta = cell.beta * Math.PI / 180;
        const gamma = cell.gamma * Math.PI / 180;

        const v = a * b * c * Math.sqrt(1 - Math.cos(alpha)**2 - Math.cos(beta)**2 - Math.cos(gamma)**2 + 2 * Math.cos(alpha) * Math.cos(beta) * Math.cos(gamma));

        // Cartesian to Fractional Matrix (Inverse of FracToCart)
        // It's easier to build FracToCart and invert it.
        
        // FracToCart (standard crystallographic convention):
        // x_c = a*x + b*cos(gamma)*y + c*cos(beta)*z
        // y_c = 0   + b*sin(gamma)*y + c*(cos(alpha)-cos(beta)cos(gamma))/sin(gamma)*z
        // z_c = 0   + 0              + v/(a*b*sin(gamma))*z
        
        // Let's use Three.js Matrix4 for inversion
        const m = new THREE.Matrix4();
        
        const n2 = (Math.cos(alpha) - Math.cos(beta) * Math.cos(gamma)) / Math.sin(gamma);
        
        m.set(
            a, b * Math.cos(gamma), c * Math.cos(beta), 0,
            0, b * Math.sin(gamma), c * n2, 0,
            0, 0, v / (a * b * Math.sin(gamma)), 0,
            0, 0, 0, 1
        );
        
        return m.invert();
    }

    applyMatrix(m, v) {
        const vec = new THREE.Vector3(v.x, v.y, v.z);
        vec.applyMatrix4(m);
        return vec;
    }
}
