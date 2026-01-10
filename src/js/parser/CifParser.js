export class CifParser {
    constructor() {
        this.data = {
            title: '',
            cell: { a: 0, b: 0, c: 0, alpha: 90, beta: 90, gamma: 90 },
            atoms: [],
            symmetry: []
        };
    }

    parse(content) {
        // Reset data for new parse
        this.data = {
            title: '',
            cell: { a: 0, b: 0, c: 0, alpha: 90, beta: 90, gamma: 90 },
            atoms: [],
            symmetry: []
        };

        // Remove comments and split lines
        // Optimization: Avoid regex replace on huge string if possible, but for now just split
        const lines = content.split('\n');
        
        let loopHeaders = [];
        let inLoop = false;
        let loopData = [];

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (line.length === 0 || line.startsWith('#')) continue;
            
            // Check for block terminators
            if (line.startsWith('data_')) {
                if (inLoop) {
                    this.processLoop(loopHeaders, loopData);
                    inLoop = false;
                }
                this.data.title = line.substring(5);
                continue;
            }

            if (line.startsWith('loop_')) {
                if (inLoop) {
                    this.processLoop(loopHeaders, loopData);
                }
                inLoop = true;
                loopHeaders = [];
                loopData = [];
                continue;
            }

            if (inLoop) {
                if (line.startsWith('_')) {
                    // If we already have data, this _tag terminates the loop
                    if (loopData.length > 0) {
                        this.processLoop(loopHeaders, loopData);
                        inLoop = false;
                        // Fall through to handle this tag as a single item
                    } else {
                        // Still collecting headers
                        loopHeaders.push(line);
                        continue;
                    }
                } else {
                    // It is data
                    loopData.push(line);
                    continue;
                }
            }

            // Single tag processing (not in loop, or fell through from loop termination)
            if (line.startsWith('_')) {
                // Simple split by whitespace
                let spaceIdx = line.indexOf(' ');
                if (spaceIdx === -1) spaceIdx = line.indexOf('\t');
                
                if (spaceIdx !== -1) {
                    const tag = line.substring(0, spaceIdx);
                    let value = line.substring(spaceIdx + 1).trim();
                    this.processTag(tag, value);
                } else {
                    // Tag might be alone, value on next line
                     const tag = line;
                     let value = '';
                     // Look ahead for value
                     // We need to be careful not to consume the next tag if value is missing (unlikely in valid CIF)
                     // But we must check if next line is a tag
                     if (i + 1 < lines.length) {
                         const nextL = lines[i+1].trim();
                         if (!nextL.startsWith('_') && !nextL.startsWith('loop_') && !nextL.startsWith('data_')) {
                             value = nextL;
                             i++; // Consume next line
                         }
                     }
                     this.processTag(tag, value);
                }
            }
        }
        
        // End of file: process pending loop
        if (inLoop) {
            this.processLoop(loopHeaders, loopData);
        }

        return this.data;
    }

    processTag(tag, value) {
        value = this.cleanValue(value);
        switch (tag) {
            case '_cell_length_a': this.data.cell.a = parseFloat(value); break;
            case '_cell_length_b': this.data.cell.b = parseFloat(value); break;
            case '_cell_length_c': this.data.cell.c = parseFloat(value); break;
            case '_cell_angle_alpha': this.data.cell.alpha = parseFloat(value); break;
            case '_cell_angle_beta': this.data.cell.beta = parseFloat(value); break;
            case '_cell_angle_gamma': this.data.cell.gamma = parseFloat(value); break;
            case '_symmetry_space_group_name_H-M': this.data.spaceGroup = value.replace(/['"]/g, ''); break;
        }
    }

    processLoop(headers, dataLines) {
        const indices = {};
        for (let i = 0; i < headers.length; i++) {
            indices[headers[i]] = i;
        }

        let isAtomLoop = false;
        let isSymLoop = false;

        for (let i = 0; i < headers.length; i++) {
            if (headers[i].startsWith('_atom_site_')) {
                isAtomLoop = true;
                break;
            }
            if (headers[i].startsWith('_symmetry_equiv_pos_') || headers[i].startsWith('_space_group_symop_')) {
                isSymLoop = true;
                break;
            }
        }

        if (!isAtomLoop && !isSymLoop) return;

        if (isAtomLoop) {
            this.parseAtomLoop(indices, dataLines);
        } else if (isSymLoop) {
            this.parseSymmetryLoop(indices, dataLines);
        }
    }

    parseAtomLoop(indices, dataLines) {
        const labelIdx = indices['_atom_site_label'];
        const typeIdx = indices['_atom_site_type_symbol'];
        const xIdx = indices['_atom_site_fract_x'];
        const yIdx = indices['_atom_site_fract_y'];
        const zIdx = indices['_atom_site_fract_z'];

        if (xIdx === undefined || yIdx === undefined || zIdx === undefined) return;

        for (let i = 0; i < dataLines.length; i++) {
            const line = dataLines[i];
            const parts = line.trim().split(/\s+/);
            
            let label = parts[labelIdx];
            let type = typeIdx !== undefined ? parts[typeIdx] : label.replace(/[0-9+-]/g, '');
            
            this.data.atoms.push({
                label: label,
                element: type,
                x: parseFloat(this.cleanValue(parts[xIdx])),
                y: parseFloat(this.cleanValue(parts[yIdx])),
                z: parseFloat(this.cleanValue(parts[zIdx]))
            });
        }
    }

    parseSymmetryLoop(indices, dataLines) {
        const xyzIdx = indices['_symmetry_equiv_pos_as_xyz'] || indices['_space_group_symop_operation_xyz'];
        if (xyzIdx === undefined) return;

        for (let i = 0; i < dataLines.length; i++) {
            const line = dataLines[i];
            // Handle quotes
            let sym = '';
            const q1 = line.indexOf("'");
            const q2 = line.indexOf('"');
            
            if (q1 !== -1) {
                const end = line.indexOf("'", q1 + 1);
                if (end !== -1) sym = line.substring(q1 + 1, end);
            } else if (q2 !== -1) {
                const end = line.indexOf('"', q2 + 1);
                if (end !== -1) sym = line.substring(q2 + 1, end);
            } else {
                const parts = line.trim().split(/\s+/);
                sym = parts[xyzIdx];
            }
            
            if (sym) this.data.symmetry.push(sym);
        }
    }

    cleanValue(val) {
        if (!val) return '';
        // Remove standard uncertainties like 1.234(5) -> 1.234
        return val.split('(')[0];
    }
}
