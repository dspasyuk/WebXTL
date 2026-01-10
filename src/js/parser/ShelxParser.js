import { SpaceGroupsData } from '../utils/SpaceGroups.js';

export class ShelxParser {
    constructor() {
        this.data = {
            title: '',
            cell: { a: 0, b: 0, c: 0, alpha: 90, beta: 90, gamma: 90, lambda: 0 },
            sfac: [],
            atoms: [],
            spaceGroup: null,
            symmetry: [],
            z: 0
        };
        this.currentPart = 0;
    }

    parse(content) {
        this.data = {
            title: '',
            cell: { a: 0, b: 0, c: 0, alpha: 90, beta: 90, gamma: 90, lambda: 0 },
            sfac: [],
            atoms: [],
            spaceGroup: null,
            symmetry: [],
            z: 0
        };
        this.currentPart = 0;

        const lines = content.split('\n');
        let currentSfac = [];

        for (let i = 0; i < lines.length; i++) {
            let startLine = i;
            let line = lines[i].trim();
            
            // Handle line continuation (=)
            // If line ends with =, append next line
            while (line.endsWith('=') && i + 1 < lines.length) {
                line = line.slice(0, -1) + ' ' + lines[++i].trim();
            }

            if (!line) continue; // Skip empty lines

            const parts = line.split(/\s+/);
            const cmd = parts[0].toUpperCase();

            switch (cmd) {
                case 'TITL':
                    this.data.title = line.substring(4).trim();
                    break;
                case 'CELL':
                    this.data.cell.lambda = parseFloat(parts[1]);
                    this.data.cell.a = parseFloat(parts[2]);
                    this.data.cell.b = parseFloat(parts[3]);
                    this.data.cell.c = parseFloat(parts[4]);
                    this.data.cell.alpha = parseFloat(parts[5]);
                    this.data.cell.beta = parseFloat(parts[6]);
                    this.data.cell.gamma = parseFloat(parts[7]);
                    break;
                case 'ZERR':
                    this.data.z = parseFloat(parts[1]);
                    // Errors are ignored for now
                    break;
                case 'LATT':
                    // Handle lattice type if needed for symmetry
                    break;
                case 'SFAC':
                    // SFAC can be just elements or elements + coefficients
                    // For visualization, we just need the element names.
                    // Usually SFAC C H O N ...
                    for (let j = 1; j < parts.length; j++) {
                        // Check if it's a number (coefficients), if so ignore for now
                        if (isNaN(parseFloat(parts[j]))) {
                            currentSfac.push(parts[j]);
                        }
                    }
                    this.data.sfac = currentSfac;
                    break;
                case 'UNIT':
                    // Number of atoms of each type in unit cell
                    break;
                case 'PART':
                    this.currentPart = parseInt(parts[1]);
                    if (isNaN(this.currentPart)) this.currentPart = 0;
                    break;
                case 'END':
                case 'FVAR':
                case 'HKLF':
                case 'REM':
                case 'MOLE':
                case 'LAUE':
                    break;
                case 'SYMM':
                    this.data.symmetry.push(line.substring(4).trim());
                    break;
                case 'PLAN':
                case 'SIZE':
                case 'TEMP':
                case 'WGHT':
                case 'BOND':
                case 'CONF':
                case 'MPLA':
                case 'HTAB':
                case 'LIST':
                case 'ACTA':
                case 'OMIT':
                case 'SADI':
                case 'SAME':
                case 'DFIX':
                case 'FLAT':
                case 'DELU':
                case 'SIMU':
                case 'ISOR':
                case 'RIGU':
                case 'EADP':
                case 'EXYZ':
                case 'AFIX':
                case 'HFIX':
                case 'EQIV':
                case 'CONN':
                    break;
                default:
                    // Check if it's an atom
                    // Atom format: Name SfacType x y z Occ Uiso ...
                    // We need to check if the first part looks like an atom name (string) and second is a number (sfac index)
                    // But sometimes SFAC is implicit or explicit.
                    // Standard SHELX: Label Type x y z occ U
                    
                    // Heuristic: Label is string, Type is Int, x,y,z are floats.
                    if (parts.length >= 5) {
                        const sfacIndex = parseInt(parts[1]);
                        const x = parseFloat(parts[2]);
                        const y = parseFloat(parts[3]);
                        const z = parseFloat(parts[4]);

                        if (!isNaN(sfacIndex) && !isNaN(x) && !isNaN(y) && !isNaN(z)) {
                            // It's likely an atom
                            let element = this.data.sfac[sfacIndex - 1] || 'C'; // Default to C if unknown
                            
                            // Explicitly check for Q-peaks
                            if (parts[0].toUpperCase().startsWith('Q')) {
                                element = 'Q';
                            }
                            // Parse ADPs (Uij) if available
                            // Standard SHELX .res format for ANIS:
                            // Label Sfac x y z occ U11 U22 U33 U23 U13 U12
                            // (Indices: 0 1 2 3 4 5 6 7 8 9 10 11)
                            // Length >= 12.
                            
                            let u = null;
                            let uiso = parseFloat(parts[6]); // Default: treat as Uiso or U11
                            
                            // Check if we have 6 U-parameters starting at index 6
                            if (parts.length >= 12) {
                                const u11 = parseFloat(parts[6]);
                                const u22 = parseFloat(parts[7]);
                                const u33 = parseFloat(parts[8]);
                                const u23 = parseFloat(parts[9]);
                                const u13 = parseFloat(parts[10]);
                                const u12 = parseFloat(parts[11]);
                                
                                if (!isNaN(u11) && !isNaN(u22) && !isNaN(u33) && !isNaN(u23) && !isNaN(u13) && !isNaN(u12)) {
                                     u = { u11, u22, u33, u23, u13, u12 };
                                     // Calculate approx Ueq for Uiso
                                     // Ueq = 1/3 * (U11 + U22 + U33) (Simplified, assuming orthogonal or ignoring trace details for rough display)
                                     uiso = (u11 + u22 + u33) / 3.0;
                                }
                            }
                            
                            if (isNaN(uiso)) uiso = 0.05;

                            this.data.atoms.push({
                                label: parts[0],
                                element: element,
                                x: x,
                                y: y,
                                z: z,
                                occupancy: parseFloat(parts[5]) || 1.0,
                                uiso: uiso,
                                u: u,
                                part: this.currentPart || 0,
                                startLine: startLine + 1, // 1-based
                                endLine: i + 1 // 1-based
                            });
                        }
                    }
                    break;
            }
        }

        return this.data;
    }
}
