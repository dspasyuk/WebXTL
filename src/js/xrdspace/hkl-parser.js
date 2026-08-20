// Copyright (c) 2026 Denis Spasyuk. MIT License.
// HKL file parsers for xrdspace.
// Supports XDS_ASCII.HKL (with ! header lines), the standard SHELX
// five-column format (H K L I SIG(I)), and COD .hkl files (CIF with a
// _refln_ reflection loop).

export const HKL_FORMAT = {
    XDS_ASCII: 'xds_ascii',
    SHELX: 'shelx',
    COD: 'cod',
    UNKNOWN: 'unknown',
};

// Parse an XDS_ASCII header value like "!UNIT_CELL_CONSTANTS= 19.236 15.537 ..."
function parseXdsHeader(lines) {
    const header = {};
    for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('!')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(1, eq).trim();
        const val = line.slice(eq + 1).trim();
        header[key] = val;
    }
    return header;
}

// Parse a SHELX-style HKL line: 5+ whitespace separated numbers H K L I SIG(I).
// Returns {h,k,l,I,sig} or null.
function parseShelxLine(tokens) {
    if (tokens.length < 5) return null;
    const h = parseInt(tokens[0], 10);
    const k = parseInt(tokens[1], 10);
    const l = parseInt(tokens[2], 10);
    if (isNaN(h) || isNaN(k) || isNaN(l)) return null;
    const I = parseFloat(tokens[3]);
    const sig = parseFloat(tokens[4]);
    if (isNaN(I)) return null;
    return { h, k, l, I, sig: isNaN(sig) ? 0 : sig };
}

// Parse an XDS_ASCII data line. Format (unmerged and merged):
//   H K L I SIGMA(I) X Y ISIGMA(I) Bg Pk N
// We only need H, K, L, I, SIGMA(I).
function parseXdsLine(tokens) {
    if (tokens.length < 5) return null;
    const h = parseInt(tokens[0], 10);
    const k = parseInt(tokens[1], 10);
    const l = parseInt(tokens[2], 10);
    if (isNaN(h) || isNaN(k) || isNaN(l)) return null;
    const I = parseFloat(tokens[3]);
    const sig = parseFloat(tokens[4]);
    if (isNaN(I)) return null;
    return { h, k, l, I, sig: isNaN(sig) ? 0 : sig };
}

// Parse a COD .hkl file: a CIF-style file with a `loop_` of `_refln_` keys.
// The reflection loop gives H K L and either F_meas^2 (with sigma) or F_meas.
// Returns an array of { h, k, l, I, sig } or an empty array.
function parseCodRefln(lines) {
    let headers = null;
    let dataStart = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() !== 'loop_') continue;
        const hdrs = [];
        let j = i + 1;
        while (j < lines.length && lines[j].trim().startsWith('_refln_')) {
            hdrs.push(lines[j].trim());
            j++;
        }
        if (hdrs.includes('_refln_index_h')) {
            headers = hdrs;
            dataStart = j;
            break;
        }
    }
    if (!headers) return [];
    const idx = {
        h: headers.indexOf('_refln_index_h'),
        k: headers.indexOf('_refln_index_k'),
        l: headers.indexOf('_refln_index_l'),
        fsq: headers.indexOf('_refln_F_squared_meas'),
        fsq_sig: headers.indexOf('_refln_F_squared_sigma'),
        f: headers.indexOf('_refln_F_meas'),
        f_sig: headers.indexOf('_refln_F_meas_sigma'),
        f_calc: headers.indexOf('_refln_F_squared_calc'),
    };
    if (idx.h < 0 || idx.k < 0 || idx.l < 0) return [];

    const out = [];
    for (let i = dataStart; i < lines.length; i++) {
        const raw = lines[i].trim();
        if (raw === '' || raw.startsWith('_') || raw.startsWith('loop_') || raw.startsWith('data_') || raw.startsWith('#')) break;
        const row = raw.split(/\s+/).filter(Boolean);
        const h = parseInt(row[idx.h], 10);
        const k = parseInt(row[idx.k], 10);
        const l = parseInt(row[idx.l], 10);
        if (isNaN(h) || isNaN(k) || isNaN(l)) continue;
        let I, sig;
        if (idx.fsq >= 0 && row[idx.fsq] !== undefined && row[idx.fsq] !== '.') {
            I = parseFloat(row[idx.fsq]);
            sig = (idx.fsq_sig >= 0 && row[idx.fsq_sig] !== undefined) ? parseFloat(row[idx.fsq_sig]) : 0;
        } else if (idx.f >= 0 && row[idx.f] !== undefined && row[idx.f] !== '.') {
            const F = parseFloat(row[idx.f]);
            const sF = (idx.f_sig >= 0 && row[idx.f_sig] !== undefined) ? parseFloat(row[idx.f_sig]) : 0;
            I = F * F;
            sig = 2 * F * sF;
        } else if (idx.f_calc >= 0 && row[idx.f_calc] !== undefined && row[idx.f_calc] !== '.') {
            I = parseFloat(row[idx.f_calc]);
            sig = 0;
        } else {
            continue;
        }
        if (isNaN(I)) continue;
        out.push({ h, k, l, I, sig: isNaN(sig) ? 0 : sig });
    }
    return out;
}

// Detect the format of an HKL file by scanning its lines. A file with a
// `_refln_` loop is COD (even though its data rows look SHELX-like); otherwise
// XDS_ASCII (! header lines) or SHELX five-column.
export function detectFormat(text) {
    const lines = text.split(/\r?\n/);
    let hasCodRefln = false;
    let hasXds = false;
    let hasShelx = false;
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('!')) hasXds = true;
        if (line.startsWith('_refln_')) hasCodRefln = true;
        const tokens = line.split(/\s+/).filter(Boolean);
        if (tokens.length >= 5 && /^-?\d/.test(tokens[0])) hasShelx = true;
    }
    if (hasCodRefln) return HKL_FORMAT.COD;
    if (hasXds) return HKL_FORMAT.XDS_ASCII;
    if (hasShelx) return HKL_FORMAT.SHELX;
    return HKL_FORMAT.UNKNOWN;
}

/**
 * Parse an HKL file into a structured object.
 * Returns {
 *   format, title,
 *   cell: { a, b, c, alpha, beta, gamma } | null,
 *   spaceGroupNumber, spaceGroupName, wavelength, merge: bool, friedelsLaw,
 *   reflections: [{ h, k, l, I, sig }]
 * }
 */
export function parseHkl(text) {
    const lines = text.split(/\r?\n/);
    const reflections = [];
    let cell = null;
    let spaceGroupNumber = null;
    let spaceGroupName = null;
    let wavelength = null;
    let merge = null;
    let friedelsLaw = null;
    let title = '';

    const format = detectFormat(text);

    if (format === HKL_FORMAT.XDS_ASCII) {
        const header = parseXdsHeader(lines);
        title = header.OUTPUT_FILE || '';
        const ucc = header.UNIT_CELL_CONSTANTS;
        if (ucc) {
            const v = ucc.split(/\s+/).map(parseFloat);
            if (v.length >= 6) {
                cell = { a: v[0], b: v[1], c: v[2], alpha: v[3], beta: v[4], gamma: v[5] };
            }
        }
        if (header.SPACE_GROUP_NUMBER) spaceGroupNumber = parseInt(header.SPACE_GROUP_NUMBER, 10);
        if (header.SPACE_GROUP_NAME) spaceGroupName = header.SPACE_GROUP_NAME;
        const wl = header['X-RAY_WAVELENGTH'] ?? header.XRAY_WAVELENGTH;
        if (wl) wavelength = parseFloat(wl);
        merge = (header.MERGE || '').toUpperCase() === 'TRUE';
        friedelsLaw = (header.FRIEDELS_LAW || '').toUpperCase() === 'TRUE';

        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith('!')) continue;
            const tokens = line.split(/\s+/);
            const r = parseXdsLine(tokens);
            if (r) reflections.push(r);
        }
    } else if (format === HKL_FORMAT.SHELX) {
        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith('!') || line.startsWith('#')) continue;
            const tokens = line.split(/\s+/);
            const r = parseShelxLine(tokens);
            if (r) reflections.push(r);
        }
    } else if (format === HKL_FORMAT.COD) {
        title = 'COD entry';
        const rl = parseCodRefln(lines);
        reflections.push(...rl);
    } else {
        throw new Error('Unrecognized HKL file format.');
    }

    return { format, title, cell, spaceGroupNumber, spaceGroupName, wavelength, merge, friedelsLaw, reflections };
}
