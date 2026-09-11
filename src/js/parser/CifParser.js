// Copyright (c) 2026 Denis Spasyuk. MIT License.
//
// CIF / PDBx-mmCIF parser for the 3D viewer.
//
// Handles both conventions in the wild:
//   - CIF1 / small-molecule (COD):  `_cell_length_a`, `_atom_site_fract_x`
//   - CIF2 / PDBx-mmCIF (RCSB):     `_cell.length_a`, `_atom_site.Cartn_x`
//     plus `_atom_site.type_symbol`, model numbers, alt-locs and the
//     `_space_group_symop.operation_xyz` symmetry loop.
//
// Output (same shape the viewer already consumes):
//   { title, cell: {a,b,c,alpha,beta,gamma}, spaceGroup, symmetry: [op...],
//     atoms: [{ label, element, x, y, z, occupancy, uiso }],
//     truncated, totalAtoms }
// where atom x/y/z are FRACTIONAL. Cartesian mmCIF coordinates are converted
// to fractional with the cell; when no (or a dummy cryo-EM 1x1x1) cell is
// present a synthetic orthorhombic cell is built from the coordinate bounding
// box so the structure still renders.
//
// Memory: loops are processed row-by-row (no giant intermediate row array),
// element/label strings are interned, and only the fields the viewer uses are
// kept. A `maxAtoms` option caps the number of stored atoms so a 10^6-atom
// assembly cannot exhaust the browser heap.

const DEG = Math.PI / 180;

// The primary array lives on the instance; a bare Array (not null) keeps V8 in
// fast-elements mode while we push millions of atoms.
const DEFAULT_MAX_ATOMS = Infinity;

// Parse a CIF numeric value ("1.234(5)", ".0276", "?") to a float.
function cifNumber(value) {
    if (value === undefined || value === null) return NaN;
    const s = String(value).trim().replace(/^['"]|['"]$/g, '');
    if (s === '' || s === '?' || s === '.') return NaN;
    return parseFloat(s.split('(')[0]);
}

// Element symbol from a CIF string, normalising "SE" -> "Se", "cl" -> "Cl".
function normaliseElement(sym) {
    if (!sym) return null;
    const s = String(sym).trim().replace(/[^A-Za-z]/g, '');
    if (!s) return null;
    return s[0].toUpperCase() + s.slice(1).toLowerCase();
}

export class CifParser {
    constructor() {
        this.data = this._emptyData();
        this._coordType = null;
        this._maxAtoms = DEFAULT_MAX_ATOMS;
        this._internMap = new Map();
    }

    _emptyData() {
        return {
            title: '',
            cell: { a: 0, b: 0, c: 0, alpha: 90, beta: 90, gamma: 90 },
            spaceGroup: null,
            atoms: [],
            symmetry: [],
            truncated: false,
            totalAtoms: 0,
        };
    }

    // Deduplicate the repeated small strings (atom labels, element symbols,
    // chain/comp ids) that otherwise allocate millions of identical strings.
    _intern(s) {
        const m = this._internMap;
        let v = m.get(s);
        if (v === undefined) { v = s; m.set(s, v); }
        return v;
    }

    parse(content, options = {}) {
        this.data = this._emptyData();
        this._coordType = null;
        this._internMap = new Map();
        this._maxAtoms = (Number.isFinite(options.maxAtoms) && options.maxAtoms > 0)
            ? options.maxAtoms
            : DEFAULT_MAX_ATOMS;

        let text = content == null ? '' : String(content);
        // Avoid copying the whole (possibly 100s of MB) file when it already
        // uses Unix line endings.
        if (text.indexOf('\r') !== -1) text = text.replace(/\r\n?/g, '\n');
        const lines = text.split('\n');

        // CIF2/mmCIF replaces the category separator '_' with '.', so fold
        // every tag to the CIF1 spelling the dispatch below understands.
        const normTag = (t) => t.replace(/\./g, '_');

        let i = 0;
        while (i < lines.length) {
            const raw = lines[i];
            const trimmed = raw.trim();

            if (trimmed === '' || trimmed.startsWith('#')) { i++; continue; }

            if (trimmed.startsWith('data_')) {
                this.data.title = trimmed.substring(5).trim();
                i++;
                continue;
            }

            if (trimmed.toLowerCase() === 'loop_') {
                i = this._readLoop(lines, i + 1, normTag);
                continue;
            }

            if (trimmed.startsWith('_')) {
                const tokens = this._tokenize(trimmed);
                const tag = normTag(tokens[0]);
                let value = tokens.slice(1).join(' ').trim();
                if (tokens.length === 1) {
                    // Value may sit on the following line, or be a
                    // semicolon-delimited text block.
                    let j = i + 1;
                    while (j < lines.length && lines[j].trim() === '') j++;
                    if (j < lines.length) {
                        const next = lines[j];
                        if (next.trim().startsWith(';')) {
                            const block = [];
                            const first = next.trim().slice(1);
                            if (first) block.push(first);
                            j++;
                            while (j < lines.length && !lines[j].startsWith(';')) block.push(lines[j++]);
                            value = block.join('\n').trim();
                            i = j;
                        } else {
                            const nt = next.trim();
                            if (!nt.startsWith('_') && !nt.startsWith('loop_') && !nt.startsWith('data_')) {
                                value = nt;
                                i = j;
                            }
                        }
                    }
                }
                this._processTag(tag, value);
                i++;
                continue;
            }

            // Semicolon text block or stray line: skip.
            i++;
        }

        this._finalizeCoordinates();
        return this.data;
    }

    // --- low-level CIF scanner -------------------------------------------------

    _tokenize(line) {
        const out = [];
        const n = line.length;
        let i = 0;
        while (i < n) {
            while (i < n && /\s/.test(line[i])) i++;
            if (i >= n) break;
            const ch = line[i];
            if (ch === "'" || ch === '"') {
                i++;
                let s = '';
                while (i < n && line[i] !== ch) {
                    // CIF escapes a quote by doubling it.
                    if (line[i] === ch && line[i + 1] === ch) { s += ch; i += 2; continue; }
                    s += line[i++];
                }
                if (i < n) i++;
                out.push(s);
            } else {
                let s = '';
                while (i < n && !/\s/.test(line[i])) s += line[i++];
                out.push(s);
            }
        }
        return out;
    }

    // Read the headers of a loop starting at `start`, choose a row handler and
    // stream the data rows through it. Returns the index of the first line
    // after the loop. Rows are never collected into an array, so huge
    // `_atom_site` loops do not allocate millions of token arrays up front.
    _readLoop(lines, start, normTag) {
        let i = start;
        const headers = [];
        while (i < lines.length) {
            const t = lines[i].trim();
            if (t.startsWith('_')) {
                for (const tok of t.split(/\s+/)) {
                    if (tok.startsWith('_')) headers.push(normTag(tok));
                }
                i++;
            } else if (t === '' || t.startsWith('#')) {
                i++;
            } else {
                break;
            }
        }

        const indices = {};
        for (let h = 0; h < headers.length; h++) indices[headers[h]] = h;
        const handler = this._loopHandler(indices);

        while (i < lines.length) {
            const tt = lines[i].trim();
            if (tt === '' || tt.startsWith('#')) { i++; continue; }
            if (tt.startsWith('_') || tt.toLowerCase() === 'loop_' || tt.startsWith('data_')) break;
            if (handler) {
                const tokens = this._tokenize(tt);
                if (tokens.length) handler(tokens);
            }
            i++;
        }
        return i;
    }

    // Build a per-row handler for a loop based on its headers. Unknown loops
    // return null (rows are skipped without tokenizing).
    _loopHandler(indices) {
        const has = (...keys) => keys.some(k => indices[k] !== undefined);

        if (has('_symmetry_equiv_pos_as_xyz', '_space_group_symop_operation_xyz')) {
            return this._symmetryRowHandler(indices);
        }

        // Coordinates: fractional (CIF1) or Cartesian (mmCIF). Exclude the
        // _atom_site_aniso_* loops which share the prefix.
        const hasFract = has('_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z');
        const hasCart = has('_atom_site_Cartn_x', '_atom_site_Cartn_y', '_atom_site_Cartn_z');
        if (hasFract || hasCart) {
            return this._atomRowHandler(indices, hasFract ? 'fract' : 'cart');
        }
        return null;
    }

    _processTag(tag, value) {
        const num = cifNumber(value);
        switch (tag) {
            case '_cell_length_a': this.data.cell.a = num; break;
            case '_cell_length_b': this.data.cell.b = num; break;
            case '_cell_length_c': this.data.cell.c = num; break;
            case '_cell_angle_alpha': this.data.cell.alpha = num; break;
            case '_cell_angle_beta': this.data.cell.beta = num; break;
            case '_cell_angle_gamma': this.data.cell.gamma = num; break;
            case '_symmetry_space_group_name_H-M':
            case '_space_group_name_H-M_alt': {
                const sg = String(value).trim().replace(/^['"]|['"]$/g, '');
                this.data.spaceGroup = (sg === '' || sg === '?' || sg === '.') ? null : sg;
                break;
            }
            default:
                break;
        }
    }

    _symmetryRowHandler(indices) {
        const xyzIdx = indices['_symmetry_equiv_pos_as_xyz']
            ?? indices['_space_group_symop_operation_xyz'];
        if (xyzIdx === undefined) return null;
        const symmetry = this.data.symmetry;
        return (row) => {
            const op = row[xyzIdx];
            if (op && op !== '?' && op !== '.') symmetry.push(String(op).trim());
        };
    }

    _atomRowHandler(indices, coordType) {
        const idx = coordType === 'fract'
            ? [indices['_atom_site_fract_x'], indices['_atom_site_fract_y'], indices['_atom_site_fract_z']]
            : [indices['_atom_site_Cartn_x'], indices['_atom_site_Cartn_y'], indices['_atom_site_Cartn_z']];

        const typeIdx = indices['_atom_site_type_symbol'];
        const labelIdx = indices['_atom_site_label'] ?? indices['_atom_site_label_atom_id'];
        const atomIdIdx = indices['_atom_site_label_atom_id'];
        const altIdx = indices['_atom_site_label_alt_id'];
        const occIdx = indices['_atom_site_occupancy'];
        const uIsoIdx = indices['_atom_site_U_iso_or_equiv'];
        const bIsoIdx = indices['_atom_site_B_iso_or_equiv'];
        const modelIdx = indices['_atom_site_pdbx_PDB_model_num'];

        this._coordType = coordType;
        const atoms = this.data.atoms;
        const maxAtoms = this._maxAtoms;
        let firstModel = null;

        return (row) => {
            // Only the first model (NMR/mmCIF ensembles otherwise pile up).
            if (modelIdx !== undefined && row[modelIdx] !== undefined) {
                const model = row[modelIdx];
                if (firstModel === null) firstModel = model;
                else if (model !== firstModel) return;
            }

            // Skip alternate conformers other than the primary one.
            if (altIdx !== undefined) {
                const alt = row[altIdx];
                if (alt !== undefined && alt !== '' && alt !== '.' && alt !== '?' && alt !== 'A' && alt !== '1') return;
            }

            const x = cifNumber(row[idx[0]]);
            const y = cifNumber(row[idx[1]]);
            const z = cifNumber(row[idx[2]]);
            if (!(x === x) || !(y === y) || !(z === z)) return; // NaN check

            this.data.totalAtoms++;

            if (atoms.length >= maxAtoms) { this.data.truncated = true; return; }

            const rawLabel = labelIdx !== undefined ? row[labelIdx] : undefined;
            const rawAtomId = atomIdIdx !== undefined ? row[atomIdIdx] : undefined;
            const label = rawLabel !== undefined ? this._intern(rawLabel)
                : (rawAtomId !== undefined ? this._intern(rawAtomId) : null);

            let element = typeIdx !== undefined ? normaliseElement(row[typeIdx]) : null;
            if (!element) {
                const base = (rawAtomId || rawLabel || '').replace(/[^A-Za-z]/g, '');
                element = normaliseElement(base.slice(0, 2)) || normaliseElement(base[0]) || 'X';
            }
            element = this._intern(element);

            let occupancy = occIdx !== undefined ? cifNumber(row[occIdx]) : NaN;
            if (!(occupancy === occupancy)) occupancy = 1.0;

            // Store the isotropic displacement as Uiso (mmCIF/PDB report B).
            let uiso = NaN;
            if (uIsoIdx !== undefined) uiso = cifNumber(row[uIsoIdx]);
            if (!(uiso === uiso) && bIsoIdx !== undefined) {
                const b = cifNumber(row[bIsoIdx]);
                if (b === b) uiso = b / (8 * Math.PI * Math.PI);
            }
            if (!(uiso === uiso)) uiso = 0;

            atoms.push({ label, element, x, y, z, occupancy, uiso });
        };
    }

    // --- coordinate finalisation ----------------------------------------------

    _finalizeCoordinates() {
        if (this._coordType !== 'cart' || !this.data.atoms.length) return;

        const cell = this.data.cell;
        const lengthsOk = [cell.a, cell.b, cell.c].every(v => Number.isFinite(v) && v > 0);
        const anglesOk = [cell.alpha, cell.beta, cell.gamma].every(Number.isFinite);
        // Many cryo-EM / integrative mmCIF entries use a dummy 1x1x1 cell; treat
        // it as "no cell" and fall back to the coordinate bounding box.
        const dummy = lengthsOk
            && Math.abs(cell.a - 1) < 1e-3 && Math.abs(cell.b - 1) < 1e-3 && Math.abs(cell.c - 1) < 1e-3;
        const validCell = lengthsOk && anglesOk && !dummy;

        if (validCell) {
            // Inline the fractional conversion to avoid allocating a temporary
            // {x,y,z} object per atom (millions of atoms).
            const a = cell.a, b = cell.b, c = cell.c;
            const ca = Math.cos(cell.alpha * DEG);
            const cb = Math.cos(cell.beta * DEG);
            const cg = Math.cos(cell.gamma * DEG);
            const sg = Math.sin(cell.gamma * DEG);
            const vol = a * b * c * Math.sqrt(Math.max(0,
                1 - ca * ca - cb * cb - cg * cg + 2 * ca * cb * cg));
            const m11 = a, m12 = b * cg, m13 = c * cb;
            const m22 = b * sg, m23 = c * (ca - cb * cg) / sg;
            const m33 = vol / (a * b * sg);

            const atoms = this.data.atoms;
            for (let i = 0; i < atoms.length; i++) {
                const atom = atoms[i];
                const xc = atom.x, yc = atom.y, zc = atom.z;
                const zf = zc / m33;
                const yf = (yc - m23 * zf) / m22;
                const xf = (xc - m12 * yf - m13 * zf) / m11;
                atom.x = xf; atom.y = yf; atom.z = zf;
            }
            return;
        }

        // No usable cell (e.g. computed models): synthesise an orthorhombic
        // cell from the coordinate bounding box and normalise into it.
        const atoms = this.data.atoms;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < atoms.length; i++) {
            const atom = atoms[i];
            if (atom.x < minX) minX = atom.x; if (atom.x > maxX) maxX = atom.x;
            if (atom.y < minY) minY = atom.y; if (atom.y > maxY) maxY = atom.y;
            if (atom.z < minZ) minZ = atom.z; if (atom.z > maxZ) maxZ = atom.z;
        }
        const pad = 2.0;
        const sizeX = (maxX - minX) + pad * 2;
        const sizeY = (maxY - minY) + pad * 2;
        const sizeZ = (maxZ - minZ) + pad * 2;

        this.data.cell = { a: sizeX, b: sizeY, c: sizeZ, alpha: 90, beta: 90, gamma: 90 };
        for (let i = 0; i < atoms.length; i++) {
            const atom = atoms[i];
            atom.x = (atom.x - minX + pad) / sizeX;
            atom.y = (atom.y - minY + pad) / sizeY;
            atom.z = (atom.z - minZ + pad) / sizeZ;
        }
    }
}

// Convert a Cartesian point (PDB orthogonal frame: a||x, b in the xy-plane)
// to fractional coordinates by inverting the standard fractional->Cartesian
// matrix with back-substitution.
export function cartesianToFractional(cell, { x: xc, y: yc, z: zc }) {
    const a = cell.a, b = cell.b, c = cell.c;
    const ca = Math.cos(cell.alpha * DEG);
    const cb = Math.cos(cell.beta * DEG);
    const cg = Math.cos(cell.gamma * DEG);
    const sg = Math.sin(cell.gamma * DEG);

    const vol = a * b * c * Math.sqrt(Math.max(0,
        1 - ca * ca - cb * cb - cg * cg + 2 * ca * cb * cg));

    const m11 = a;
    const m12 = b * cg;
    const m13 = c * cb;
    const m22 = b * sg;
    const m23 = c * (ca - cb * cg) / sg;
    const m33 = vol / (a * b * sg);

    const z = zc / m33;
    const y = (yc - m23 * z) / m22;
    const x = (xc - m12 * y - m13 * z) / m11;
    return { x, y, z };
}
