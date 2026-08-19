// HKL file parsers for jsSpace.
// Supports XDS_ASCII.HKL (with ! header lines) and the standard SHELX
// five-column format (H K L I SIG(I)).

export const HKL_FORMAT = {
    XDS_ASCII: 'xds_ascii',
    SHELX: 'shelx',
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

// Detect the format of an HKL file from its first non-empty lines.
export function detectFormat(text) {
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('!')) return HKL_FORMAT.XDS_ASCII;
        const tokens = line.split(/\s+/).filter(Boolean);
        if (tokens.length >= 5) return HKL_FORMAT.SHELX;
        return HKL_FORMAT.UNKNOWN;
    }
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
        if (header.XRAY_WAVELENGTH) wavelength = parseFloat(header.XRAY_WAVELENGTH);
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
    } else {
        throw new Error('Unrecognized HKL file format.');
    }

    return { format, title, cell, spaceGroupNumber, spaceGroupName, wavelength, merge, friedelsLaw, reflections };
}
