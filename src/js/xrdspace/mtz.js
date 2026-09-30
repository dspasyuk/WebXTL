// Copyright (c) 2026 Denis Spasyuk. MIT License.
// Pure-JS reader/writer for CCP4 MTZ reflection files.
//
// An MTZ file has three regions:
//   1. An 80-byte binary preamble: "MTZ " magic, the header offset, and a
//      machine stamp that encodes the byte order.
//   2. The reflection data: a flat array of `ncols * nreflections` IEEE-754
//      single-precision (4-byte) floats, laid out row-major. Reflection r,
//      column c is stored at element index r * ncols + c. H, K and L are the
//      first three columns (held in floats, as integer values).
//   3. A text header: 80-character fixed-width records (VERS, TITLE, NCOL,
//      CELL, SYMINF, SYMM, RESO, VALM, COLUMN, COLSRC, NDIF, PROJECT, CRYSTAL,
//      DATASET, DCELL, DWAVEL, END), followed by MTZHIST history lines, MTZBATS
//      batch headers and MTZENDOFHEADERS.
//
// The data region precedes the text header; the offset of the text header is
// given by the preamble. This mirrors the reference implementation in gemmi
// (src/mtz.cpp) and is compatible with CCP4 mtzutils / mtz2hkl files.
//
// Column type letters (F, Q, D, G, L, Y, J, K, M, P, A, H, ...) are semantic
// labels only; every column is stored as a single 4-byte float regardless of
// type.

// Map a column label to its conventional MTZ type letter.
const TYPE_BY_LABEL = {
    H: 'H', K: 'H', L: 'H',
    F: 'F', SIGF: 'Q', DANO: 'D', SIGDANO: 'Q',
    'F(+)': 'G', 'SIGF(+)': 'L', 'F(-)': 'G', 'SIGF(-)': 'L',
    ISYM: 'Y',
    IMEAN: 'J', SIGIMEAN: 'Q', 'I(+)': 'K', 'SIGI(+)': 'M', 'I(-)': 'K', 'SIGI(-)': 'M',
    PHI: 'P', SIGPHI: 'Q',
    HLA: 'A', HLB: 'A', HLC: 'A', HLD: 'A',
    SCALE: 'S', BATCH: 'B',
};

// Split an 80-char header line. `key` is the first 4 characters (used to match
// the record type, mirroring gemmi's ialpha4_id); `rest` is the remainder after
// the first keyword word (keywords vary in length, e.g. "COLUMN" vs "NCOL").
function splitHeaderLine(line) {
    const key = line.slice(0, 4);
    const m = line.match(/^\S*\s*/);
    const rest = m ? line.slice(m[0].length) : line;
    return { key, rest };
}

// Read the first whitespace-delimited word from a string. Returns [word, rest].
function readWord(s) {
    const m = s.match(/^\s*(\S+)\s*/);
    if (!m) return ['', s];
    return [m[1], s.slice(m[1].length + m[0].length - m[1].length)];
}

// Read consecutive whitespace-delimited tokens.
function readTokens(s, n) {
    const out = [];
    let rest = s;
    for (let i = 0; i < n; i++) {
        const m = rest.match(/^\s*(\S+)/);
        if (!m) break;
        out.push(m[1]);
        rest = rest.slice(m[0].length);
    }
    return { tokens: out, rest };
}

// Parse a possibly-quoted word (e.g. 'C 2 2 21').
function readQuoted(s) {
    s = s.replace(/^\s+/, '');
    if (s.startsWith("'")) {
        const end = s.indexOf("'", 1);
        if (end === -1) return [s.slice(1), ''];
        return [s.slice(1, end), s.slice(end + 1)];
    }
    const [w, rest] = readWord(s);
    return [w, rest];
}

function toInt(s) {
    const v = parseInt(s, 10);
    return Number.isFinite(v) ? v : 0;
}

function toFloat(s) {
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : NaN;
}

/**
 * Parse an MTZ reflection file.
 * @param {ArrayBuffer|Uint8Array|Buffer} buf file bytes
 * @param {object} [options]
 * @param {boolean} [options.withData=true] read the reflection data (default true)
 * @returns {{
 *   title: string,
 *   version: string,
 *   nreflections: number,
 *   ncols: number,
 *   cell: {a:number,b:number,c:number,alpha:number,beta:number,gamma:number},
 *   spaceGroupNumber: number,
 *   spaceGroupName: string,
 *   latticeType: string,
 *   nsymop: number,
 *   nops: number,
 *   symops: string[],
 *   reso: [number, number],
 *   valm: number,
 *   columns: {label:string,type:string,min:number,max:number,dataset:number,source:string}[],
 *   datasets: {id:number,project:string,crystal:string,dataset:string,cell:object,wavelength:number}[],
 *   history: string[],
 *   batchNumbers: number[],
 *   data: Float32Array,          // flat, row-major, ncols * nreflections
 *   byteOrder: 'LE'|'BE'
 * }}
 */
export function parseMtz(buf, options = {}) {
    const withData = options.withData !== false;
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u8.length < 80) throw new Error('MTZ file too short');
    if (u8[0] !== 0x4d || u8[1] !== 0x54 || u8[2] !== 0x5a || u8[3] !== 0x20) {
        throw new Error('Not an MTZ file (missing "MTZ " magic)');
    }

    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    // Machine stamp at bytes 8-12; first byte (low nibble) is the real-data
    // byte order: 0x1 = big endian, 0x4 = little endian.
    const stamp = dv.getUint32(8, true);
    const byteOrder = (stamp & 0xf0) === 0x10 ? 'BE' : 'LE';
    const le = byteOrder === 'LE';

    let headerOffset = dv.getInt32(4, le);
    if (headerOffset === -1) {
        headerOffset = Number(dv.getBigUint64(12, le));
    }
    const headerPos = 4 * (headerOffset - 1);
    if (headerPos < 80 || headerPos > u8.length) {
        throw new Error('MTZ header offset out of range');
    }

    // Reflection data: bytes [80, headerPos), float32, row-major.
    let data = new Float32Array(0);
    if (withData) {
        const nfloats = Math.floor((headerPos - 80) / 4);
        data = new Float32Array(nfloats);
        for (let i = 0; i < nfloats; i++) {
            data[i] = dv.getFloat32(80 + i * 4, le);
        }
    }

    // Text header records.
    const lines = [];
    for (let off = headerPos; off + 80 <= u8.length; off += 80) {
        let line = '';
        for (let i = 0; i < 80; i++) {
            const c = u8[off + i];
            line += (c >= 32 && c < 127) ? String.fromCharCode(c) : ' ';
        }
        lines.push(line);
    }

    const mtz = {
        title: '',
        version: '',
        nreflections: 0,
        ncols: 0,
        cell: { a: 0, b: 0, c: 0, alpha: 90, beta: 90, gamma: 90 },
        spaceGroupNumber: 0,
        spaceGroupName: 'P 1',
        latticeType: 'P',
        nsymop: 1,
        nops: 1,
        symops: [],
        reso: [NaN, NaN],
        valm: NaN,
        columns: [],
        datasets: [],
        history: [],
        batchNumbers: [],
        data,
        byteOrder,
    };

    let i = 0;
    let inHistory = false;
    let historyLeft = 0;
    let inBatches = false;
    let batchesLeft = 0;
    let lastDataset = null;
    while (i < lines.length) {
        const line = lines[i];
        const { key, rest } = splitHeaderLine(line);

        if (inHistory) {
            if (historyLeft > 0) {
                mtz.history.push(rest.trim());
                historyLeft--;
                i++;
                continue;
            }
            inHistory = false;
        }
        if (inBatches) {
            if (key === 'MTZH' || key === 'MTZE' || key === 'BATCH') {
                inBatches = false;
                // fall through to normal handling
            } else if (key === 'BH ') {
                const t = readTokens(rest, 4);
                mtz.batchNumbers.push(toInt(t.tokens[0]));
                i += 1 + t.tokens[2] + 1 + t.tokens[3]; // TITLE + ints + floats + BHCH
                continue;
            } else {
                i++;
                continue;
            }
        }

        if (key === 'VERS') {
            mtz.version = rest.trim();
        } else if (key === 'TITL') {
            mtz.title = rest.trim();
        } else if (key === 'NCOL') {
            const t = readTokens(rest, 3);
            mtz.ncols = toInt(t.tokens[0]);
            mtz.nreflections = toInt(t.tokens[1]);
        } else if (key === 'CELL') {
            const t = readTokens(rest, 6);
            mtz.cell = {
                a: toFloat(t.tokens[0]), b: toFloat(t.tokens[1]), c: toFloat(t.tokens[2]),
                alpha: toFloat(t.tokens[3]), beta: toFloat(t.tokens[4]), gamma: toFloat(t.tokens[5]),
            };
        } else if (key === 'SYMI') {
            const t = readTokens(rest, 4);
            mtz.nsymop = toInt(t.tokens[0]);
            mtz.nops = toInt(t.tokens[1]);
            mtz.latticeType = t.tokens[2] || 'P';
            mtz.spaceGroupNumber = toInt(t.tokens[3]);
            const [name, qr] = readQuoted(t.rest);
            mtz.spaceGroupName = name;
        } else if (key === 'SYMM') {
            mtz.symops.push(rest.trim());
        } else if (key === 'RESO') {
            const t = readTokens(rest, 2);
            mtz.reso = [toFloat(t.tokens[0]), toFloat(t.tokens[1])];
        } else if (key === 'VALM') {
            mtz.valm = rest.trim().toUpperCase() === 'NAN' ? NaN : toFloat(rest);
        } else if (key === 'COLU') {
            const t = readTokens(rest, 5);
            const col = {
                label: t.tokens[0],
                type: (t.tokens[1] || 'F')[0],
                min: toFloat(t.tokens[2]),
                max: toFloat(t.tokens[3]),
                dataset: toInt(t.tokens[4]),
                source: '',
            };
            mtz.columns.push(col);
        } else if (key === 'COLS') {
            const t = readTokens(rest, 2);
            if (mtz.columns.length) mtz.columns[mtz.columns.length - 1].source = t.tokens[1] || '';
        } else if (key === 'NDIF') {
            // number of datasets; actual dataset records follow
        } else if (key === 'PROJ') {
            const t = readTokens(rest, 2);
            lastDataset = { id: toInt(t.tokens[0]), project: t.tokens[1] || '', crystal: '', dataset: '', cell: { ...mtz.cell }, wavelength: 0 };
            mtz.datasets.push(lastDataset);
        } else if (key === 'CRYS') {
            const t = readTokens(rest, 2);
            if (lastDataset && toInt(t.tokens[0]) === lastDataset.id) lastDataset.crystal = t.tokens[1] || '';
        } else if (key === 'DATA') {
            const t = readTokens(rest, 2);
            if (lastDataset && toInt(t.tokens[0]) === lastDataset.id) lastDataset.dataset = t.tokens[1] || '';
        } else if (key === 'DCEL') {
            const t = readTokens(rest, 7);
            if (lastDataset && toInt(t.tokens[0]) === lastDataset.id) {
                lastDataset.cell = {
                    a: toFloat(t.tokens[1]), b: toFloat(t.tokens[2]), c: toFloat(t.tokens[3]),
                    alpha: toFloat(t.tokens[4]), beta: toFloat(t.tokens[5]), gamma: toFloat(t.tokens[6]),
                };
            }
        } else if (key === 'DWAV') {
            const t = readTokens(rest, 2);
            if (lastDataset && toInt(t.tokens[0]) === lastDataset.id) lastDataset.wavelength = toFloat(t.tokens[1]);
        } else if (key === 'BATCH') {
            const t = readTokens(rest, 6);
            for (const tok of t.tokens) if (tok) mtz.batchNumbers.push(toInt(tok));
        } else if (key === 'MTZH') {
            inHistory = true;
            historyLeft = toInt(rest);
        } else if (key === 'MTZB') {
            inBatches = true;
        } else if (key === 'MTZE' || key === 'END') {
            break;
        }
        i++;
    }

    return mtz;
}

// Column index helpers.
export function columnIndexOf(mtz, label) {
    const l = label.toUpperCase();
    for (let c = 0; c < mtz.columns.length; c++) {
        if (mtz.columns[c].label.toUpperCase() === l) return c;
    }
    return -1;
}

// Values of a single column as a Float32Array (length nreflections).
export function getColumnValues(mtz, label) {
    const c = columnIndexOf(mtz, label);
    if (c < 0) throw new Error('No column named ' + label);
    const { nreflections, ncols, data } = mtz;
    const out = new Float32Array(nreflections);
    for (let r = 0; r < nreflections; r++) out[r] = data[r * ncols + c];
    return out;
}

// Miller indices as a flat Int32Array [h0,k0,l0, h1,k1,l1, ...].
export function getHkl(mtz) {
    const { nreflections, ncols, data } = mtz;
    const out = new Int32Array(nreflections * 3);
    for (let r = 0; r < nreflections; r++) {
        out[r * 3 + 0] = Math.round(data[r * ncols + 0]);
        out[r * 3 + 1] = Math.round(data[r * ncols + 1]);
        out[r * 3 + 2] = Math.round(data[r * ncols + 2]);
    }
    return out;
}

// Common intensity / sigma column labels, in order of preference. MTZ files
// name their amplitude/intensity columns differently (F, FP, IMEAN, I, FMEAS...).
const INTENSITY_LABELS = ['IMEAN', 'F', 'FP', 'FMEAS', 'F_OBS', 'I', 'I_OBS', 'IOBS'];
const SIGMA_LABELS = ['SIGIMEAN', 'SIGF', 'SIGFP', 'SIGFMEAS', 'SIGF_OBS', 'SIGI', 'SIGI_OBS', 'SIGIOBS'];

// First available column label from a priority list, or null.
function firstAvailable(mtz, labels) {
    for (const l of labels) {
        if (columnIndexOf(mtz, l) >= 0) return l;
    }
    return null;
}

// Extract reflections in xrdspace's { h, k, l, I, sig } form.
// `intensity`/`sigma` default to the first available common label
// (IMEAN/F/FP/... and SIGIMEAN/SIGF/SIGFP/...).
export function getReflections(mtz, options = {}) {
    const iLabel = options.intensity || firstAvailable(mtz, INTENSITY_LABELS);
    const sLabel = options.sigma || firstAvailable(mtz, SIGMA_LABELS);
    if (!iLabel) throw new Error('No intensity column found (tried ' + INTENSITY_LABELS.join(', ') + ')');
    const ci = columnIndexOf(mtz, iLabel);
    const cs = sLabel ? columnIndexOf(mtz, sLabel) : -1;
    const { nreflections, ncols, data } = mtz;
    const out = [];
    for (let r = 0; r < nreflections; r++) {
        const h = Math.round(data[r * ncols + 0]);
        const k = Math.round(data[r * ncols + 1]);
        const l = Math.round(data[r * ncols + 2]);
        const I = data[r * ncols + ci];
        if (Number.isNaN(I)) continue; // missing reflection
        const sig = cs >= 0 ? data[r * ncols + cs] : NaN;
        out.push({ h, k, l, I, sig: Number.isFinite(sig) ? sig : 0 });
    }
    return out;
}

// Format a float for a COLUMN min/max field (<= 17 chars, like gemmi).
function fmt17(x) {
    if (!Number.isFinite(x)) return 'NaN'.padEnd(17);
    let s = x.toFixed(9);
    return s.length > 17 ? s.slice(0, 17) : s;
}

// Compute min/max of a column, ignoring NaN.
function colMinMax(mtz, c) {
    const { nreflections, ncols, data } = mtz;
    let min = Infinity, max = -Infinity;
    for (let r = 0; r < nreflections; r++) {
        const v = data[r * ncols + c];
        if (Number.isNaN(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (min === Infinity) { min = NaN; max = NaN; }
    return [min, max];
}

/**
 * Write an MTZ reflection file.
 * @param {object} mtz a parseMtz()-shaped object (or a subset of it).
 * @returns {Buffer} the MTZ file bytes (little-endian).
 */
export function writeMtz(mtz) {
    const columns = mtz.columns;
    const ncol = columns.length;
    const nrefl = mtz.nreflections;
    const data = mtz.data;
    if (!ncol || !nrefl) throw new Error('Cannot write MTZ with no columns/reflections');
    if (data.length < ncol * nrefl) throw new Error('MTZ data too short for columns/reflections');

    const cell = mtz.cell || { a: 0, b: 0, c: 0, alpha: 90, beta: 90, gamma: 90 };
    const symops = (mtz.symops && mtz.symops.length) ? mtz.symops : ['X, Y, Z'];
    const sgName = mtz.spaceGroupName || 'P 1';
    const sgNumber = mtz.spaceGroupNumber || 1;
    const lat = (mtz.latticeType || sgName[0] || 'P').toUpperCase();
    const datasets = (mtz.datasets && mtz.datasets.length)
        ? mtz.datasets
        : [{ id: 0, project: 'HKL_base', crystal: 'HKL_base', dataset: 'HKL_base', cell, wavelength: mtz.wavelength || 0 }];

    // Build the text header lines (each padded to 80 chars).
    const pad = (s, n = 80) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
    const lines = [];
    lines.push(pad('VERS MTZ:V1.1'));
    lines.push(pad('TITLE ' + (mtz.title || 'xrdspace')));
    lines.push(pad('NCOL' + String(ncol).padStart(8) + String(nrefl).padStart(12) + String(0).padStart(8)));
    lines.push(pad('CELL  ' + [cell.a, cell.b, cell.c, cell.alpha, cell.beta, cell.gamma].map(v => Number(v).toFixed(4).padStart(9)).join(' ')));
    lines.push(pad('SORT    0   0   0   0   0'));
    const hm = lat + sgName.slice(1);
    lines.push(pad(`SYMINF ${String(symops.length).padStart(3)} ${String(symops.length).padStart(2)} ${lat} ${String(sgNumber).padStart(5)} ` + `'${hm}'`.padEnd(25) + 'PG1'));
    for (const op of symops) lines.push(pad('SYMM ' + op.toUpperCase()));
    const reso = mtz.reso && Number.isFinite(mtz.reso[0]) ? mtz.reso : [NaN, NaN];
    lines.push(pad('RESO ' + (Number.isFinite(reso[0]) ? reso[0].toFixed(12) : 'NaN').padEnd(20) + ' ' + (Number.isFinite(reso[1]) ? reso[1].toFixed(12) : 'NaN').padEnd(20)));
    lines.push(pad(Number.isNaN(mtz.valm) ? 'VALM NAN' : 'VALM ' + Number(mtz.valm).toFixed(6)));
    for (let c = 0; c < ncol; c++) {
        const col = columns[c];
        const [mn, mx] = colMinMax(mtz, c);
        const label = (col.label || '_').padEnd(30);
        const type = (col.type || TYPE_BY_LABEL[col.label] || 'F').slice(0, 1);
        lines.push(pad(`COLUMN ${label} ${type} ` + fmt17(mn) + ' ' + fmt17(mx) + ' ' + String(col.dataset || 0).padStart(4)));
        if (col.source) lines.push(pad(`COLSRC ${label} ${col.source.padEnd(36)}  ` + String(col.dataset || 0).padStart(4)));
    }
    lines.push(pad('NDIF' + String(datasets.length).padStart(8)));
    for (const ds of datasets) {
        const uc = ds.cell || cell;
        lines.push(pad(`PROJECT ${String(ds.id).padStart(7)} ${ds.project || 'HKL_base'}`));
        lines.push(pad(`CRYSTAL ${String(ds.id).padStart(7)} ${ds.crystal || 'HKL_base'}`));
        lines.push(pad(`DATASET ${String(ds.id).padStart(7)} ${ds.dataset || 'HKL_base'}`));
        lines.push(pad(`DCELL ${String(ds.id).padStart(9)} ` + [uc.a, uc.b, uc.c, uc.alpha, uc.beta, uc.gamma].map(v => Number(v).toFixed(4).padStart(10)).join('')));
        lines.push(pad(`DWAVEL ${String(ds.id).padStart(8)} ` + Number(ds.wavelength || 0).toFixed(5).padStart(10)));
    }
    lines.push(pad('END'));
    if (mtz.history && mtz.history.length) {
        lines.push(pad('MTZHIST' + String(mtz.history.length).padStart(3)));
        for (const h of mtz.history) lines.push(pad(h));
    }
    lines.push(pad('MTZENDOFHEADERS'));

    const textBuf = Buffer.alloc(lines.length * 80);
    for (let i = 0; i < lines.length; i++) lines[i].slice(0, 80).split('').forEach((ch, j) => { textBuf[i * 80 + j] = ch.charCodeAt(0) & 0xff; });

    const dataBytes = ncol * nrefl * 4;
    const headerStart = ncol * nrefl + 21; // (byte 80 + dataBytes) / 4
    let headerStart32 = headerStart;
    let realHeaderStart = 0;
    if (headerStart > 0x7fffffff) {
        headerStart32 = -1;
        realHeaderStart = headerStart;
    }

    const preamble = Buffer.alloc(80);
    preamble.write('MTZ ', 0, 'latin1');
    preamble.writeInt32LE(headerStart32, 4);
    preamble.writeUInt32LE(0x00004144, 8); // little-endian machine stamp
    if (realHeaderStart) preamble.writeBigUInt64LE(BigInt(realHeaderStart), 12);

    const dataBuf = Buffer.alloc(dataBytes);
    for (let i = 0; i < ncol * nrefl; i++) dataBuf.writeFloatLE(data[i], i * 4);

    return Buffer.concat([preamble, dataBuf, textBuf]);
}
