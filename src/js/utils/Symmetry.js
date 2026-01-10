export class Symmetry {
    static parseOperation(opString) {
        // opString example: "x+1/2, -y, z"
        const parts = opString.toLowerCase().replace(/\s/g, '').split(',');
        if (parts.length !== 3) return null;

        return parts.map(part => {
            // Parse each component (x, y, z)
            // We want to convert "x+1/2" into a function or coefficients
            // Let's return { x: 1, y: 0, z: 0, c: 0.5 } for x+1/2
            
            let res = { x: 0, y: 0, z: 0, c: 0 };
            
            // Match numbers (fractions or decimals)
            // Regex to find terms
            // This is a simple parser, might be fragile
            
            // Replace x, y, z with 1*x, 1*y, 1*z to make parsing easier?
            // Or just manual parsing.
            
            let term = part;
            
            // Extract constant
            // Look for + or - followed by number/fraction at the end or beginning?
            // Actually, let's just evaluate it by replacing x,y,z with values.
            // But we need to do this for many atoms, so pre-parsing is better.
            
            // Simple approach:
            // Check for x, -x
            if (term.includes('-x')) res.x = -1;
            else if (term.includes('x')) res.x = 1;
            
            if (term.includes('-y')) res.y = -1;
            else if (term.includes('y')) res.y = 1;
            
            if (term.includes('-z')) res.z = -1;
            else if (term.includes('z')) res.z = 1;
            
            // Remove x, y, z to find constant
            let constPart = term.replace(/-?x/g, '').replace(/-?y/g, '').replace(/-?z/g, '');
            if (constPart.length > 0 && constPart !== '+') {
                if (constPart.includes('/')) {
                    const [num, den] = constPart.split('/');
                    res.c = parseFloat(num) / parseFloat(den);
                } else {
                    res.c = parseFloat(constPart);
                }
            }
            
            return res;
        });
    }

    static apply(op, x, y, z) {
        // op is array of 3 objects from parseOperation
        const nx = op[0].x * x + op[0].y * y + op[0].z * z + op[0].c;
        const ny = op[1].x * x + op[1].y * y + op[1].z * z + op[1].c;
        const nz = op[2].x * x + op[2].y * y + op[2].z * z + op[2].c;
        return { x: nx, y: ny, z: nz };
    }

    static generateEquivalentPositions(atoms, symmetryOps, pack = true) {
        // Expand atoms using symmetry operators
        const expandedAtoms = [];
        const ops = [];
        
        // Parse ops first
        for (let i = 0; i < symmetryOps.length; i++) {
            const op = this.parseOperation(symmetryOps[i]);
            if (op) ops.push(op);
        }

        // Helper to check if atom exists
        const isDuplicate = (atom, list) => {
            const tol = 0.05; // Tolerance in Angstroms? No, these are fractional.
            // Fractional tolerance. 0.05 is too large for fractional. 
            // 0.01 is usually safe (1% of cell edge).
            // But let's be tighter: 0.001
            const ftol = 0.001;
            for (let i = 0; i < list.length; i++) {
                const a = list[i];
                // Check distance in fractional coords (approximate, ideally should use orthogonalization)
                // But for duplicate removal, simple diff is usually enough if we handle periodic boundary?
                // If we pack, we shouldn't have periodic duplicates inside the cell.
                // But special positions might be generated.
                
                const dx = Math.abs(atom.x - a.x);
                const dy = Math.abs(atom.y - a.y);
                const dz = Math.abs(atom.z - a.z);
                
                if (dx < ftol && dy < ftol && dz < ftol) return true;
            }
            return false;
        };

        if (pack) {
            // Whole Molecule Packing Strategy
            // 1. Treat input 'atoms' as the asymmetric unit (one rigid body)
            // 2. Apply each operator to the whole body
            // 3. Translate the body so its centroid is in the cell
            
            // Calculate centroid of input (Asymmetric Unit)
            // Actually, we don't need input centroid, we need centroid of *generated* mates.
            
            for (let j = 0; j < ops.length; j++) {
                const op = ops[j];
                const molAtoms = [];
                let cx = 0, cy = 0, cz = 0;
                
                // Generate transformed molecule
                for (let i = 0; i < atoms.length; i++) {
                    const atom = atoms[i];
                    const newPos = this.apply(op, atom.x, atom.y, atom.z);
                    molAtoms.push({ ...atom, x: newPos.x, y: newPos.y, z: newPos.z });
                    cx += newPos.x;
                    cy += newPos.y;
                    cz += newPos.z;
                }
                
                if (molAtoms.length === 0) continue;
                
                // Average centroid
                cx /= molAtoms.length;
                cy /= molAtoms.length;
                cz /= molAtoms.length;
                
                // Find integer shift to bring centroid to [0.5, 0.5, 0.5] range
                // We want 0 <= center < 1
                const tx = Math.floor(cx) * -1;
                const ty = Math.floor(cy) * -1;
                const tz = Math.floor(cz) * -1;
                
                // Apply shift and add to expanded list
                for (let k = 0; k < molAtoms.length; k++) {
                    const ma = molAtoms[k];
                    ma.x += tx;
                    ma.y += ty;
                    ma.z += tz;
                    
                    // Check duplicate before adding
                    if (!isDuplicate(ma, expandedAtoms)) {
                        expandedAtoms.push(ma);
                    }
                }
            }
        } else {
            // Old behavior: Atom-wise generation (no packing, just raw symmetry)
            // But we should still filter duplicates?
            // The original code didn't filter.
            // Let's keep it simple for non-packing mode (raw expansion).
            
            for (let i = 0; i < atoms.length; i++) {
                const atom = atoms[i];
                for (let j = 0; j < ops.length; j++) {
                    const op = ops[j];
                    const newPos = this.apply(op, atom.x, atom.y, atom.z);
                    expandedAtoms.push({
                        ...atom,
                        x: newPos.x,
                        y: newPos.y,
                        z: newPos.z
                    });
                }
            }
        }
        
        return expandedAtoms;
    }
}
