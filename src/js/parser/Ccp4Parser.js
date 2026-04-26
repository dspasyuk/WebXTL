
export class Ccp4Parser {
    constructor() {}

    parse(buffer) {
        const header = new Int32Array(buffer, 0, 256);
        const floatHeader = new Float32Array(buffer, 0, 256);

        // 1. Check "MAP " string at byte 208 (word 52)
        // Note: word 52 is index 52 in Int32Array (bytes 208-211)
        // Actually, the standard says word 53 (1-based) is "MAP ". So index 52.
        // Let's check bytes directly to be safe.
        const magic = new Uint8Array(buffer, 208, 4);
        const magicStr = String.fromCharCode(...magic);
        
        if (magicStr !== "MAP ") {
            console.warn("Ccp4Parser: Magic string 'MAP ' not found. Proceeding anyway, but might be invalid.");
        }

        // 2. Read Header
        const nc = header[0]; // columns (fastest)
        const nr = header[1]; // rows
        const ns = header[2]; // sections (slowest)
        
        const mode = header[3]; // 2 = float
        if (mode !== 2) {
            throw new Error("Ccp4Parser: Only mode 2 (32-bit float) is supported.");
        }

        const ncStart = header[4];
        const nrStart = header[5];
        const nsStart = header[6];

        const mx = header[7]; // sampling along x
        const my = header[8]; // sampling along y
        const mz = header[9]; // sampling along z

        const cellA = floatHeader[10];
        const cellB = floatHeader[11];
        const cellC = floatHeader[12];
        const cellAlpha = floatHeader[13];
        const cellBeta = floatHeader[14];
        const cellGamma = floatHeader[15];

        const mapc = header[16]; // axis corresponding to columns (1=x, 2=y, 3=z)
        const mapr = header[17]; // axis corresponding to rows
        const maps = header[18]; // axis corresponding to sections

        const dmin = floatHeader[19];
        const dmax = floatHeader[20];
        const dmean = floatHeader[21];
        
        const ispg = header[22]; // space group number
        const nsymbt = header[23]; // size of symmetry bytes

        // 3. Read Data
        // Header is 1024 bytes. Symmetry data follows.
        const offset = 1024 + nsymbt;
        const data = new Float32Array(buffer, offset, nc * nr * ns);

        // 4. Normalize Data (Sigma)
        // Calculate mean and sigma if not reliable in header (often they are, but let's recalculate to be safe/consistent)
        let sum = 0;
        let sumSq = 0;
        const len = data.length;
        for (let i = 0; i < len; i++) {
            const val = data[i];
            sum += val;
            sumSq += val * val;
        }
        const mean = sum / len;
        const variance = (sumSq / len) - (mean * mean);
        const sigma = Math.sqrt(variance);

        // Normalize
        if (sigma !== 0) {
            for (let i = 0; i < len; i++) {
                data[i] = (data[i] - mean) / sigma;
            }
        }

        // 5. Handle Axis Ordering
        // We want standard X(fast), Y(medium), Z(slow) for our renderer?
        // Our DensityRenderer loops k(z), j(y), i(x).
        // If mapc=1, mapr=2, maps=3, then data is x, y, z (columns=x, rows=y, sections=z).
        // This matches standard marching cubes expectation if we map i->x, j->y, k->z.
        
        // If axes are swapped, we might need to permute.
        // For now, assume standard 1, 2, 3 (X, Y, Z).
        // If not, we warn.
        if (mapc !== 1 || mapr !== 2 || maps !== 3) {
            console.warn("Ccp4Parser: Non-standard axis ordering (not X, Y, Z). Rendering might be rotated.");
            // TODO: Implement permutation if needed.
        }

        return {
            data: data,
            nx: nc,
            ny: nr,
            nz: ns,
            cell: {
                a: cellA,
                b: cellB,
                c: cellC,
                alpha: cellAlpha,
                beta: cellBeta,
                gamma: cellGamma
            },
            origin: {
                x: ncStart,
                y: nrStart,
                z: nsStart
            },
            grid: {
                mx: mx,
                my: my,
                mz: mz
            },
            stats: {
                min: dmin,
                max: dmax,
                mean: mean,
                sigma: sigma
            }
        };
    }
}
