
export class FcfParser {
    constructor() {
        this.data = {
            title: '',
            cell: { a: 0, b: 0, c: 0, alpha: 90, beta: 90, gamma: 90 },
            reflections: [],
            symmetry: []
        };
    }

    parse(content) {
        const lines = content.split('\n');
        let inLoop = false;
        let loopFields = [];
        let isReflnLoop = false;
        let isSymmLoop = false;

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (!line || line.startsWith('#')) continue;

            if (line.startsWith('_shelx_title')) {
                this.data.title = line.replace(/_shelx_title\s+/, '').replace(/'/g, '').trim();
            } else if (line.startsWith('_cell_length_a')) {
                this.data.cell.a = parseFloat(line.split(/\s+/)[1]);
            } else if (line.startsWith('_cell_length_b')) {
                this.data.cell.b = parseFloat(line.split(/\s+/)[1]);
            } else if (line.startsWith('_cell_length_c')) {
                this.data.cell.c = parseFloat(line.split(/\s+/)[1]);
            } else if (line.startsWith('_cell_angle_alpha')) {
                this.data.cell.alpha = parseFloat(line.split(/\s+/)[1]);
            } else if (line.startsWith('_cell_angle_beta')) {
                this.data.cell.beta = parseFloat(line.split(/\s+/)[1]);
            } else if (line.startsWith('_cell_angle_gamma')) {
                this.data.cell.gamma = parseFloat(line.split(/\s+/)[1]);
            } else if (line.startsWith('loop_')) {
                inLoop = true;
                loopFields = [];
                isReflnLoop = false;
                isSymmLoop = false;
            } else if (inLoop && line.startsWith('_')) {
                loopFields.push(line);
                if (line.startsWith('_refln_')) isReflnLoop = true;
                if (line.startsWith('_space_group_symop_')) isSymmLoop = true;
            } else if (inLoop) {
                // Data line
                if (isReflnLoop) {
                    const parts = line.split(/\s+/);
                    const refln = {};
                    // Mapping based on standard FCF list 4
                    // _refln_index_h _refln_index_k _refln_index_l _refln_F_squared_calc _refln_F_squared_meas _refln_F_squared_sigma _refln_observed_status
                    // We assume the order matches the loop definition, but for simplicity in this specific parser 
                    // we can try to map by index if we tracked loopFields, or just assume standard order if it's robust enough.
                    // Let's use the loopFields to be safe.
                    
                    for(let j=0; j<loopFields.length; j++) {
                        const field = loopFields[j];
                        const val = parts[j];
                        if (field.includes('_index_h')) refln.h = parseInt(val);
                        else if (field.includes('_index_k')) refln.k = parseInt(val);
                        else if (field.includes('_index_l')) refln.l = parseInt(val);
                        else if (field.includes('_F_squared_calc')) refln.Fc2 = parseFloat(val);
                        else if (field.includes('_F_squared_meas')) refln.Fo2 = parseFloat(val);
                        else if (field.includes('_F_squared_sigma')) refln.sigma = parseFloat(val);
                        else if (field.includes('_observed_status')) refln.status = val;
                    }
                    this.data.reflections.push(refln);
                } else if (isSymmLoop) {
                     this.data.symmetry.push(line.replace(/'/g, ''));
                }
            }
        }
        return this.data;
    }
}
