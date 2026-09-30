// Copyright (c) 2026 Denis Spasyuk. MIT License.
// HKL file parsers for xrdspace.
// Supports XDS_ASCII.HKL (with ! header lines), the standard SHELX
// five-column format (H K L I SIG(I)), COD .hkl files (CIF with a
// _refln_ reflection loop), and Bruker P4P files (SAINT/APEX output with a
// FILEID/CELL/SOURCE header and REF05 reflection records).

export const HKL_FORMAT = {
    XDS_ASCII: 'xds_ascii',
    SHELX: 'shelx',
    COD: 'cod',
    P4P: 'p4p',
    UNKNOWN: 'unknown',
};

// Split a line into whitespace-separated tokens with a single pass (avoids the
// per-line allocations of split(/\s+/).filter(Boolean) on large reflection files).
function tokenize(s) {
    const out = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 32 || c === 9 || c === 13) {
            if (cur) { out.push(cur); cur = ''; }
        } else {
            cur += s[i];
        }
    }
    if (cur) out.push(cur);
    return out;
}

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
        // The FORMAT line packs the flags after the first key, e.g.
        // "!FORMAT=XDS_ASCII    MERGE=FALSE    FRIEDEL'S_LAW=TRUE", so extract
        // them explicitly or they would be swallowed into the FORMAT value.
        if (key === 'FORMAT') {
            const m = val.match(/\bMERGE\s*=\s*(\w+)/i);
            if (m) header.MERGE = m[1];
            const f = val.match(/FRIEDEL'?S_LAW\s*=\s*(\w+)/i);
            if (f) header["FRIEDEL'S_LAW"] = f[1];
        }
        // Data-record column layout, e.g. "!ITEM_PSI=12". Values are 1-based
        // column positions; we keep a lowercase key -> column map so the data
        // parser can read PSI (and friends) without assuming a fixed layout.
        const item = key.match(/^ITEM_(.+)$/);
        if (item) {
            const col = parseInt(val, 10);
            if (Number.isFinite(col)) header['item_' + item[1].toLowerCase()] = col;
        }
    }
    return header;
}

// Scan geometry for a rotation experiment, used to turn each observation's
// rotation angle (PSI) into a cumulative dose position. Returns
// { startAngle, oscRange, nFrames, totalRotation } (any field may be null when
// the header does not carry it).
function parseXdsGeometry(header) {
    const num = (v) => {
        const x = v == null ? NaN : parseFloat(String(v).trim());
        return Number.isFinite(x) ? x : null;
    };
    const startAngle = num(header.STARTING_ANGLE);
    const oscRange = num(header.OSCILLATION_RANGE);
    let nFrames = null;
    const dr = header.DATA_RANGE;
    if (dr) {
        const t = tokenize(dr);
        const lo = parseInt(t[0], 10);
        const hi = parseInt(t[1], 10);
        if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo) nFrames = hi - lo + 1;
    }
    let totalRotation = null;
    if (oscRange != null && nFrames != null) totalRotation = oscRange * nFrames;
    return { startAngle, oscRange, nFrames, totalRotation };
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
    return { h, k, l, I, sig: isNaN(sig) ? 0 : Math.abs(sig) };
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
    // XDS flags observations that it rejected during scaling (e.g. overloaded
    // or outlier reflections) with a NEGATIVE sigma. The magnitude is still a
    // plausible standard deviation, but such observations must not enter the
    // merge: the old code tested `sig > 0`, so a negative sigma fell into the
    // "no sigma" branch and was given unit weight, letting a rejected outlier
    // dominate the weighted mean (and producing absurdly small merged sigmas).
    const rejected = !isNaN(sig) && sig < 0;
    return { h, k, l, I, sig: isNaN(sig) ? 0 : Math.abs(sig), rejected };
}

// Parse a COD .hkl file: a CIF-style file with a `loop_` of `_refln_` keys.
// The reflection loop gives H K L and either F_meas^2 (with sigma) or F_meas.
// Returns an array of { h, k, l, I, sig } or an empty array.
function parseCodRefln(lines) {
    let headers = null;
    let dataStart = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() !== 'loop_') continue;
        // Collect the header block: consecutive lines starting with '_'
        // (some COD files interleave non-_refln_ keys such as
        // _pd_refln_wavelength_id inside the reflection loop).
        const hdrs = [];
        let j = i + 1;
        while (j < lines.length && lines[j].trim().startsWith('_')) {
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
        int: headers.indexOf('_refln_intensity_meas'),
        int_sig: headers.indexOf('_refln_intensity_sigma'),
        f: headers.indexOf('_refln_F_meas'),
        f_sig: headers.indexOf('_refln_F_meas_sigma'),
        fobs: headers.indexOf('_refln_f_obs'),
        fobs_sig: headers.indexOf('_refln_f_obs_sigma') >= 0 ? headers.indexOf('_refln_f_obs_sigma') : headers.indexOf('_refln_F_sigma'),
        f_calc: headers.indexOf('_refln_F_squared_calc'),
    };
    if (idx.h < 0 || idx.k < 0 || idx.l < 0) return [];

    const out = [];
    for (let i = dataStart; i < lines.length; i++) {
        const raw = lines[i].trim();
        if (raw === '' || raw.startsWith('_') || raw.startsWith('loop_') || raw.startsWith('data_') || raw.startsWith('#')) break;
        const row = tokenize(raw);
        const h = parseInt(row[idx.h], 10);
        const k = parseInt(row[idx.k], 10);
        const l = parseInt(row[idx.l], 10);
        if (isNaN(h) || isNaN(k) || isNaN(l)) continue;
        const get = (i, d = 0) => (i >= 0 && row[i] !== undefined && row[i] !== '.') ? parseFloat(row[i]) : NaN;
        let I, sig;
        if (!isNaN(get(idx.fsq))) {
            I = get(idx.fsq);
            sig = get(idx.fsq_sig);
        } else if (!isNaN(get(idx.int))) {
            I = get(idx.int);
            sig = get(idx.int_sig);
        } else if (!isNaN(get(idx.f))) {
            const F = get(idx.f);
            I = F * F;
            sig = 2 * F * get(idx.f_sig);
        } else if (!isNaN(get(idx.fobs))) {
            const F = get(idx.fobs);
            I = F * F;
            sig = 2 * F * get(idx.fobs_sig);
        } else if (!isNaN(get(idx.f_calc))) {
            I = get(idx.f_calc);
            sig = 0;
        } else {
            continue;
        }
        if (isNaN(I)) continue;
        out.push({ h, k, l, I, sig: isNaN(sig) ? 0 : sig });
    }
    return out;
}

// Parse a Bruker P4P header (the fixed keyword lines written by SAINT/APEX).
// Returns { title, cell, wavelength }. The unit cell is on the `CELL` line and
// the wavelength is the second number of the `SOURCE` line (e.g. "SOURCE CU
// 1.54188 1.54056 1.54439 ...").
function parseP4PHeader(lines) {
    let title = '';
    let cell = null;
    let wavelength = null;
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const tokens = tokenize(line);
        const key = tokens[0].toUpperCase();
        if (key === 'TITLE') {
            title = tokens.slice(1).join(' ').trim();
        } else if (key === 'CELL') {
            if (tokens.length >= 6) {
                cell = {
                    a: parseFloat(tokens[1]), b: parseFloat(tokens[2]), c: parseFloat(tokens[3]),
                    alpha: parseFloat(tokens[4]), beta: parseFloat(tokens[5]), gamma: parseFloat(tokens[6]),
                };
            }
        } else if (key === 'SOURCE') {
            // "SOURCE CU 1.54188 1.54056 1.54439 2.00000 40.00 4.00"
            for (let i = 1; i < tokens.length; i++) {
                const v = parseFloat(tokens[i]);
                if (Number.isFinite(v)) { wavelength = v; break; }
            }
        }
    }
    return { title, cell, wavelength };
}

// Parse a single Bruker P4P `REF05` reflection line.
//
// Layout (whitespace-separated, after the "REF05" tag):
//   [flag] h k l omega 2theta psi chi <2 aux> I sigma u1 u2 u3 [0 0 0 0]
// where `flag` is an optional single/multi-letter status field (H, C, A, CH,
// AC, ACH, ...) and the trailing zeros are present in most files.
//
// The intensity (I) and its standard deviation (sigma) are the two numeric
// fields immediately before the reciprocal-lattice vector components
// (u1, u2, u3): these are verified to equal ORT . (h k l) (the orientation
// matrix applied to the Miller indices), which pins them down unambiguously.
// For this SAINT/APEX layout that puts I at h+9 and sigma at h+10. The
// rotation angle is `omega`, the field right after l.
//
// A quirk of some SAINT/APEX versions: when `l` is followed by a negative
// `omega` the two are written with no separating space, e.g. "13-108.000"
// meaning l=13, omega=-108.000. We split that token on the sign boundary
// (omega is always the negative, decimal-carrying part).
//
// The (0,0,0) direct-beam / standard-reflection rows that SAINT writes are
// skipped: they carry no diffraction data.
//
// Returns { h, k, l, I, sig, psi } or null.
function parseP4PLine(line) {
    const tokens = tokenize(line);
    if (tokens.length < 12) return null;
    // Drop the leading "REF05" tag, then any alphabetic status flag(s).
    let i = 0;
    if (/^REF\d*$/.test(tokens[0])) i = 1;
    while (i < tokens.length && !/^-?\d/.test(tokens[i])) i++;
    // Need at least up to the intensity/sigma pair (the normal case reads
    // tokens[i+9] and tokens[i+10]).
    if (i + 10 >= tokens.length) return null;

    let h = parseInt(tokens[i], 10);
    let k = parseInt(tokens[i + 1], 10);
    let lTok = tokens[i + 2];
    let omega;
    // Normal case: l is a plain integer, omega is the next token.
    if (/^-?\d+$/.test(lTok)) {
        const l = parseInt(lTok, 10);
        if (isNaN(h) || isNaN(k) || isNaN(l)) return null;
        omega = parseFloat(tokens[i + 3]);
        // Fields after h: k(+1) l(+2) omega(+3) 2theta(+4) psi(+5) chi(+6)
        // P1(+7) P2(+8) I(+9) sigma(+10) u1(+11) u2(+12) u3(+13) [0 0 0 0]
        const I = parseFloat(tokens[i + 9]);
        const sig = parseFloat(tokens[i + 10]);
        return makeP4PRefl(h, k, l, omega, I, sig);
    }
    // Concatenated case: l and omega are fused, e.g. "13-108.000" or
    // "-2-108.000". Split at the sign boundary between the integer l and the
    // (always negative) floating-point omega.
    const m = lTok.match(/^(-?\d+)(-\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const l = parseInt(m[1], 10);
    if (isNaN(h) || isNaN(k) || isNaN(l)) return null;
    omega = parseFloat(m[2]);
    // One token was merged, so everything after l shifts left by one:
    // I is at i+8, sigma at i+9.
    const I = parseFloat(tokens[i + 8]);
    const sig = parseFloat(tokens[i + 9]);
    return makeP4PRefl(h, k, l, omega, I, sig);
}

function makeP4PRefl(h, k, l, omega, I, sig) {
    if (isNaN(I)) return null;
    // (0,0,0) rows are direct-beam / standard measurements, not reflections.
    if (h === 0 && k === 0 && l === 0) return null;
    return {
        h, k, l,
        I,
        sig: isNaN(sig) ? 0 : Math.abs(sig),
        psi: Number.isFinite(omega) ? omega : undefined,
        // No `raw`: a P4P REF line is not in XDS_ASCII layout, so it must not
        // be copied verbatim into an XDS_ASCII output. The per-observation
        // rotation angle (omega) is carried in `psi` instead, which the
        // unmerged writer places in the PSI column.
    };
}

// Detect the format of an HKL file by scanning its lines. A file with a
// `_refln_` loop is COD (even though its data rows look SHELX-like); a file
// with a Bruker P4P header (FILEID) is P4P; otherwise XDS_ASCII (! header
// lines) or SHELX five-column.
export function detectFormat(text) {
    const lines = text.split(/\r?\n/);
    let hasCodRefln = false;
    let hasCifTag = false;
    let hasXds = false;
    let hasShelx = false;
    let hasP4PHeader = false;
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('!')) hasXds = true;
        if (line.startsWith('_')) hasCifTag = true;
        if (line.startsWith('_refln_')) hasCodRefln = true;
        if (/^FILEID\b/.test(line)) hasP4PHeader = true;
        const tokens = tokenize(line);
        if (tokens.length >= 5 && /^-?\d/.test(tokens[0])) hasShelx = true;
    }
    if (hasCodRefln) return HKL_FORMAT.COD;
    // A CIF that has no single-crystal `_refln_` loop (e.g. a powder `_pd_`
    // pattern whose numeric rows would otherwise look SHELX-like) is unusable.
    if (hasCifTag) return HKL_FORMAT.UNKNOWN;
    // P4P is recognised by its FILEID header, which is unambiguous. A P4P file
    // with no REFxx reflection records (raw DATA blocks only) is still a P4P
    // file: it simply carries no integrated reflections, so it is detected as
    // P4P (and the unit cell is read from the header) rather than being
    // misread as SHELX five-column from the numeric DATA rows.
    if (hasP4PHeader) return HKL_FORMAT.P4P;
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
 *   geometry: { startAngle, oscRange, nFrames, totalRotation } | null,
 *              // scan geometry (XDS_ASCII / P4P; null fields when absent)
 *   reflections: [{ h, k, l, I, sig, psi?, raw? }]
 *              // raw = original data line; psi = rotation angle (deg)
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
    let geometry = null;

    const format = detectFormat(text);

    if (format === HKL_FORMAT.XDS_ASCII) {
        const header = parseXdsHeader(lines);
        title = header.OUTPUT_FILE || '';
        const ucc = header.UNIT_CELL_CONSTANTS;
        if (ucc) {
            const toks = tokenize(ucc);
            if (toks.length >= 6) {
                cell = {
                    a: parseFloat(toks[0]), b: parseFloat(toks[1]), c: parseFloat(toks[2]),
                    alpha: parseFloat(toks[3]), beta: parseFloat(toks[4]), gamma: parseFloat(toks[5]),
                };
            }
        }
        if (header.SPACE_GROUP_NUMBER) spaceGroupNumber = parseInt(header.SPACE_GROUP_NUMBER, 10);
        if (header.SPACE_GROUP_NAME) spaceGroupName = header.SPACE_GROUP_NAME;
        const wl = header['X-RAY_WAVELENGTH'] ?? header.XRAY_WAVELENGTH;
        if (wl) wavelength = parseFloat(wl);
        merge = (header.MERGE || '').toUpperCase() === 'TRUE';
        friedelsLaw = ((header["FRIEDEL'S_LAW"] ?? header.FRIEDELS_LAW) || '').toUpperCase() === 'TRUE';
        geometry = parseXdsGeometry(header);

        // Column position of the rotation angle (PSI) in the data record, when
        // the header declares it (XDS always does: !ITEM_PSI=<n>).
        const psiCol = header.item_psi != null ? header.item_psi - 1 : null; // 0-based

        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith('!')) continue;
            const tokens = tokenize(line);
            const r = parseXdsLine(tokens);
            if (r) {
                // Rotation angle of this observation (degrees), the dose
                // coordinate for beam-damage analysis. Kept only when present.
                if (psiCol != null && tokens[psiCol] !== undefined) {
                    const psi = parseFloat(tokens[psiCol]);
                    if (Number.isFinite(psi)) r.psi = psi;
                }
                // Keep the original data record verbatim so an unmerged output can
                // preserve the auxiliary XDS columns (XD, YD, ZD, RLP, PEAK, CORR, PSI).
                r.raw = line;
                reflections.push(r);
            }
        }
    } else if (format === HKL_FORMAT.SHELX) {
        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith('!') || line.startsWith('#')) continue;
            const tokens = tokenize(line);
            const r = parseShelxLine(tokens);
            if (r) reflections.push(r);
        }
    } else if (format === HKL_FORMAT.COD) {
        title = 'COD entry';
        const rl = parseCodRefln(lines);
        reflections.push(...rl);
    } else if (format === HKL_FORMAT.P4P) {
        const hdr = parseP4PHeader(lines);
        title = hdr.title || '';
        cell = hdr.cell;
        wavelength = hdr.wavelength;
        for (const raw of lines) {
            const line = raw.trim();
            if (!line || !/^REF\d+\b/.test(line)) continue;
            const r = parseP4PLine(line);
            if (r) reflections.push(r);
        }
        // Scan geometry for the rotation experiment, so the per-observation
        // rotation angle (omega) can be used as a dose coordinate for the
        // beam-damage analysis. The P4P header does not store the frame
        // count, so the total rotation is the observed omega span.
        let omegaMin = null;
        let omegaMax = null;
        for (const r of reflections) {
            if (Number.isFinite(r.psi)) {
                if (omegaMin === null || r.psi < omegaMin) omegaMin = r.psi;
                if (omegaMax === null || r.psi > omegaMax) omegaMax = r.psi;
            }
        }
        if (omegaMin !== null) {
            geometry = { startAngle: omegaMin, oscRange: null, nFrames: null, totalRotation: omegaMax - omegaMin };
        }
    } else {
        throw new Error('Unrecognized HKL file format.');
    }

    return { format, title, cell, spaceGroupNumber, spaceGroupName, wavelength, merge, friedelsLaw, geometry, reflections };
}
