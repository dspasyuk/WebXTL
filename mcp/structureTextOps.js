// Pure string helpers for the MCP server: parse/transform SHELX .ins/.res text.
// These mirror the atomic editor operations available in the WebXTL UI so that
// an AI assistant can safely edit a structure through the MCP interface.

export const SHELX_KEYWORDS = new Set([
    'TITL', 'CELL', 'ZERR', 'LATT', 'SYMM', 'SFAC', 'UNIT', 'HKLF', 'SIZE',
    'TEMP', 'MOLE', 'RESI', 'MOVE', 'ANIS', 'AFIX', 'HFIX', 'EQIV', 'CONN',
    'PART', 'BIND', 'FREE', 'DANG', 'BOND', 'CONF', 'MPLA', 'RTAB', 'HTAB',
    'LIST', 'ACTA', 'WGHT', 'FVAR', 'REM', 'END', 'OMIT', 'SADI', 'SAME',
    'SIMU', 'DELU', 'RIGU', 'ISOR', 'NCSY', 'SUMP', 'L.S.', 'CGLS', 'BLOC',
    'DAMP', 'STIR', 'TWIN', 'BASF', 'SWAT', 'HOPE', 'MERG', 'SPEC', 'RESC',
    'RIGU', 'SHEL', 'GRID', 'CALC', 'EXYZ', 'EADP'
]);

export function isAtomLine(line) {
    if (!line || !line.trim()) return false;
    const trimmed = line.trim();
    if (trimmed.startsWith('REM') || trimmed.startsWith(';')) return false;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) return false;
    const label = parts[0].toUpperCase();
    if (SHELX_KEYWORDS.has(label)) return false;
    // Atom: label type x y z [sof] [U]...
    if (!/^[A-Z]/i.test(parts[0])) return false;
    if (isNaN(parseFloat(parts[2])) || isNaN(parseFloat(parts[3])) || isNaN(parseFloat(parts[4]))) return false;
    return true;
}

export function parseSfacElements(lines) {
    // Find SFAC instruction(s): "SFAC C H O ..." and gather element symbols.
    const elements = ['?'];
    for (const line of lines) {
        const t = line.trim();
        if (!/^SFAC\b/i.test(t)) continue;
        // SFAC [C O H] or SFAC 6 C H O ...
        const parts = t.split(/\s+/).slice(1);
        // If the first token is the dispersion-unit count (a number) skip it.
        const start = parts.length && !isNaN(parseInt(parts[0])) ? 1 : 0;
        for (const p of parts.slice(start)) {
            if (/^[A-Z][a-z]?$/.test(p)) elements.push(p.toUpperCase());
        }
    }
    return elements;
}

export function atomPartsToElement(parts, sfacElements) {
    const sfacIndex = parseInt(parts[1], 10);
    if (!isNaN(sfacIndex) && sfacIndex >= 0 && sfacIndex < sfacElements.length) {
        return sfacElements[sfacIndex] || null;
    }
    // Fall back to the label's first letters (e.g. "C1", "FE1", "H1A").
    const m = parts[0].match(/^([A-Z][a-z]?)/);
    return m ? m[1].toUpperCase() : null;
}

// Split a .ins/.res document into atom lines. Returns array of indices.
export function findAtomRows(lines) {
    const rows = [];
    lines.forEach((line, i) => {
        if (isAtomLine(line)) rows.push(i);
    });
    return rows;
}

export function setOccupancy(content, value, { labels = null } = {}) {
    const lines = content.split('\n');
    const out = lines.slice();
    const sfac = parseSfacElements(lines);
    let changed = 0;
    out.forEach((line, i) => {
        if (!isAtomLine(line)) return;
        const parts = line.trim().split(/\s+/);
        const el = atomPartsToElement(parts, sfac);
        const label = parts[0].toUpperCase();
        if (labels && labels.length) {
            const wanted = labels.map(l => l.toUpperCase());
            if (!wanted.includes(label) && !(el && wanted.includes(el + ':'))) return;
        }
        // sof is token index 5. If missing, insert it.
        if (parts.length < 6) parts.push('');
        parts[5] = String(value);
        out[i] = parts.join('  ');
        changed++;
    });
    return { content: out.join('\n'), changed };
}

export function setUiso(content, value, { labels = null } = {}) {
    const lines = content.split('\n');
    const out = lines.slice();
    let changed = 0;
    out.forEach((line, i) => {
        if (!isAtomLine(line)) return;
        const parts = line.trim().split(/\s+/);
        const label = parts[0].toUpperCase();
        if (labels && labels.length && !labels.map(l => l.toUpperCase()).includes(label)) return;
        // Atom: label type x y z sof Uiso [U11..]
        if (parts.length < 6) parts.push('');  // sof missing
        if (parts.length < 7) parts.push('');  // Uiso missing
        parts[6] = String(value);
        out[i] = parts.join('  ');
        changed++;
    });
    return { content: out.join('\n'), changed };
}

export function makeIsotropic(content, { labels = null } = {}) {
    const lines = content.split('\n');
    const out = lines.slice();
    let changed = 0;
    out.forEach((line, i) => {
        if (!isAtomLine(line)) return;
        const parts = line.trim().split(/\s+/);
        const label = parts[0].toUpperCase();
        if (labels && labels.length && !labels.map(l => l.toUpperCase()).includes(label)) return;
        // Drop everything after Uiso (i.e. the 6 anisotropic Uij terms).
        if (parts.length > 7) {
            out[i] = parts.slice(0, 7).join('  ');
            changed++;
        }
    });
    return { content: out.join('\n'), changed };
}

export function killLines(content, predicate, description) {
    const lines = content.split('\n');
    const kept = [];
    const removed = [];
    lines.forEach((line, i) => {
        if (predicate(line.trim(), i)) removed.push(i + 1);
        else kept.push(line);
    });
    return { content: kept.join('\n'), removed, description };
}

export function killQPeaks(content) {
    return killLines(content,
        t => /^Q\s*\d/.test(t) && isAtomLine(t.replace(/^Q/, 'X')),
        'Q peaks');
}

export function killHydrogens(content) {
    const lines = content.split('\n');
    const sfac = parseSfacElements(lines);
    return killLines(content,
        (t) => {
            const parts = t.split(/\s+/);
            if (!isAtomLine(t)) return false;
            const el = atomPartsToElement(parts, sfac);
            return el === 'H';
        },
        'H atoms');
}

// Relabel atoms per element in document order: C1, C2, ..., FE1, ...
// Optionally restrict to a given element or to labels.
export function relabelAtoms(content, { element = null, prefix = null } = {}) {
    const lines = content.split('\n');
    const out = lines.slice();
    const sfac = parseSfacElements(lines);
    const counters = {};
    const mapping = {};
    const rows = findAtomRows(lines);
    // SHELX allows a limited set of element labels; group by element symbol.
    for (const row of rows) {
        const parts = lines[row].trim().split(/\s+/);
        const el = atomPartsToElement(parts, sfac);
        if (!el) continue;
        if (element && el !== element.toUpperCase()) continue;
        const key = el;
        if (!(key in counters)) counters[key] = 0;
        counters[key]++;
        const newLabel = (prefix || '') + key + counters[key];
        mapping[parts[0]] = newLabel;
        parts[0] = newLabel;
        out[row] = parts.join('  ');
    }
    return { content: out.join('\n'), mapping, changed: rows.length };
}

export function findDuplicateLabels(content) {
    const lines = content.split('\n');
    const seen = new Map();
    const dupes = [];
    lines.forEach((line, i) => {
        if (!isAtomLine(line)) return;
        const label = line.trim().split(/\s+/)[0].toUpperCase();
        if (seen.has(label)) {
            if (seen.get(label).count === 1) dupes.push({ label, rows: [seen.get(label).row, i + 1] });
            else dupes.find(d => d.label === label).rows.push(i + 1);
            seen.get(label).count++;
        } else {
            seen.set(label, { row: i + 1, count: 1 });
        }
    });
    return dupes;
}

// Parse the SHELX CELL/ZERR/SFAC block for a compact summary.
export function summarizeStructure(content) {
    const lines = content.split('\n');
    const sfac = parseSfacElements(lines);
    let cell = null, formula = {}, nAtoms = 0, nQ = 0;
    for (const line of lines) {
        const t = line.trim();
        const p = t.split(/\s+/);
        if (/^CELL\b/i.test(t) && p.length >= 7) {
            cell = {
                wavelength: parseFloat(p[1]) || null,
                a: parseFloat(p[2]), b: parseFloat(p[3]), c: parseFloat(p[4]),
                alpha: parseFloat(p[5]), beta: parseFloat(p[6]), gamma: parseFloat(p[7])
            };
        }
    }
    for (const row of findAtomRows(lines)) {
        const parts = lines[row].trim().split(/\s+/);
        if (/^Q/i.test(parts[0])) { nQ++; continue; }
        const el = atomPartsToElement(parts, sfac) || '?';
        formula[el] = (formula[el] || 0) + 1;
        nAtoms++;
    }
    const formulaStr = Object.entries(formula)
        .sort((a, b) => a[0] < b[0] ? -1 : 1)
        .map(([el, n]) => `${el}${n > 1 ? n : ''}`).join(' ');
    return { cell, formula: formulaStr, elements: formula, nAtoms, nQ, sfac: sfac.slice(1) };
}
