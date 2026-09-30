// Copyright (c) 2026 Denis Spasyuk. MIT License.
// xrdspace model reset: transform a SHELX .res/.ins atom model between space
// groups. When a space group is *forced*, this expands the model's asymmetric
// unit under the current group's symmetry to reconstruct the full cell content,
// then reduces that content to an asymmetric unit under the target group.
//   - moving to a HIGHER-symmetry (super) group collapses symmetry-related
//     molecules  -> "remove redundant molecules",
//   - moving to a LOWER-symmetry (sub) group keeps the generated partners
//     -> "add symmetry-related molecules".
// Only the fractional coordinates change (same unit cell). Optional origin
// shift can be supplied. Q peaks and disordered PART partners are preserved.

import { parseOperation, mul3, LATT_CENTERING, centeringTranslations, shelxSymmGenerators } from './op-math.js';
import { loadSpaceGroups, resolveSpaceGroup, centeringOf } from './index.js';

// SHELX instruction keywords that are not atom lines.
const SHELX_KEYWORDS = new Set([
    'TITL', 'CELL', 'ZERR', 'LATT', 'SYMM', 'SFAC', 'UNIT', 'HKLF', 'SIZE',
    'TEMP', 'MOLE', 'RESI', 'MOVE', 'ANIS', 'AFIX', 'HFIX', 'EQIV', 'CONN',
    'PART', 'BIND', 'FREE', 'DANG', 'BOND', 'CONF', 'MPLA', 'RTAB', 'HTAB',
    'LIST', 'ACTA', 'WGHT', 'FVAR', 'REM', 'END', 'OMIT', 'SADI', 'SAME',
    'SIMU', 'DELU', 'RIGU', 'ISOR', 'NCSY', 'SUMP', 'L.S.', 'CGLS', 'BLOC',
    'DAMP', 'STIR', 'TWIN', 'BASF', 'SWAT', 'HOPE', 'MERG', 'SPEC', 'RESC',
    'RIGU', 'SHEL', 'GRID', 'CALC', 'EXYZ', 'EADP', 'REST', 'MORE', 'DISP',
    'L.S.', 'NEUT', 'ANSC', 'CELL', 'SAVE', 'MERG'
]);

// Lattice-centering translations for SHELX LATT numbers (1=P, 2=I, 3=R,
// 4=F, 5=A, 6=B, 7=C; sign ignored).
function centeringVectors(latt) {
    return centeringTranslations(Math.abs(latt) || 1);
}

const I3 = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const mI3 = () => [[-1, 0, 0], [0, -1, 0], [0, 0, -1]];

// Compose affine ops: op2 after op1  (op2(op1(x))).
function composeOps(o2, o1) {
    const R = mul3(o2.R, o1.R);
    const t = [
        o2.R[0][0] * o1.t[0] + o2.R[0][1] * o1.t[1] + o2.R[0][2] * o1.t[2] + o2.t[0],
        o2.R[1][0] * o1.t[0] + o2.R[1][1] * o1.t[1] + o2.R[1][2] * o1.t[2] + o2.t[1],
        o2.R[2][0] * o1.t[0] + o2.R[2][1] * o1.t[1] + o2.R[2][2] * o1.t[2] + o2.t[2],
    ];
    return { R, t };
}

// Capitalise an element symbol for consistency (cl -> Cl, CL -> Cl). Not used
// when SFAC symbols are stored uppercased, but kept for label fallbacks.
function capElement(s) {
    if (!s) return '?';
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function fracNorm(x) {
    let r = x - Math.floor(x);
    // Snap accumulated floating-point drift back onto exact fractions.
    if (r < 1e-9) r = 0;
    else if (r > 1 - 1e-9) r = 0;
    return r;
}

// Normalise an affine op: translations are only defined modulo lattice
// translations, so reduce each component to [0,1) before dedup.
function normOp(op) {
    return {
        R: op.R,
        t: [fracNorm(op.t[0]), fracNorm(op.t[1]), fracNorm(op.t[2])],
    };
}

function wrapAtom(a) {
    return { ...a, x: fracNorm(a.x), y: fracNorm(a.y), z: fracNorm(a.z) };
}

function applyOp(a, op) {
    const R = op.R, t = op.t;
    return {
        ...a,
        x: R[0][0] * a.x + R[0][1] * a.y + R[0][2] * a.z + t[0],
        y: R[1][0] * a.x + R[1][1] * a.y + R[1][2] * a.z + t[1],
        z: R[2][0] * a.x + R[2][1] * a.y + R[2][2] * a.z + t[2],
    };
}

function opKey(op) {
    const n = normOp(op);
    return n.R.map(r => r.join(',')).join('|') + ':' + n.t.map(v => Math.round(v * 1e9) / 1e9).join(',');
}

// Build the full general-position operator list (identity + inversion + SYMM
// generators + centering translations, closed under composition). In SHELX a
// POSITIVE LATT indicates a centrosymmetric group and the program itself adds
// the inversion; a negative LATT is non-centrosymmetric.
export function opsFromLattSymm(latt, symmLines = []) {
    const generators = [];
    if (Math.abs(latt) >= 1) generators.push({ R: I3(), t: [0, 0, 0] });
    if (latt > 0) generators.push({ R: mI3(), t: [0, 0, 0] });
    for (const line of symmLines) {
        const p = parseOperation(line);
        if (p) generators.push({ R: p.R, t: p.t });
    }
    for (const c of centeringVectors(latt)) {
        generators.push({ R: I3(), t: c });
    }

    // Closure: multiply until stable.
    const ops = [];
    const seen = new Set();
    const add = (op) => {
        const k = opKey(op);
        if (seen.has(k)) return;
        seen.add(k);
        ops.push(op);
    };
    generators.forEach(add);
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 400) {
        changed = false;
        const L = ops.length;
        for (let i = 0; i < L; i++) {
            for (let j = 0; j < L; j++) {
                const before = seen.size;
                add(composeOps(ops[i], ops[j]));
                if (seen.size !== before) changed = true;
                if (seen.size > 384) return ops;
            }
        }
    }
    return ops;
}

// Parse CELL/ZERR/SFAC/LATT/SYMM and atom lines from a SHELX .res/.ins text.
// Atom lines may use '=' continuation (anisotropic blocks) - they are merged.
export function parseShelxModel(text) {
    const lines = (text || '').split(/\r?\n/);
    const model = {
        title: '', cell: null, zerr: null, sfac: [], latt: 1, symm: [],
        atoms: [], instructions: [], atomLines: [], warnings: [],
    };

    const sfacIndex = (el) => {
        const i = model.sfac.findIndex(s => s.toUpperCase() === (el || '').toUpperCase());
        return i >= 0 ? i + 1 : -1;
    };

    let i = 0;
    while (i < lines.length) {
        let line = lines[i];
        const rawLine = line;
        const trimmed = line.trim();
        if (!trimmed) { i++; continue; }
        const parts = trimmed.split(/\s+/);
        const cmd = parts[0].toUpperCase();

        if (cmd === 'TITL') { model.title = trimmed.slice(4).trim(); i++; continue; }
        if (cmd === 'CELL') {
            model.cell = {
                wavelength: parseFloat(parts[1]),
                a: parseFloat(parts[2]), b: parseFloat(parts[3]), c: parseFloat(parts[4]),
                alpha: parseFloat(parts[5]), beta: parseFloat(parts[6]), gamma: parseFloat(parts[7]),
            };
            i++; continue;
        }
        if (cmd === 'ZERR') { model.zerr = trimmed; i++; continue; }
        if (cmd === 'LATT') { model.latt = parseInt(parts[1], 10) || 1; i++; continue; }
        if (cmd === 'SYMM') { model.symm.push(trimmed.slice(4).trim()); i++; continue; }
        if (cmd === 'SFAC') {
            // SFAC may carry element names (and dispersion constants elsewhere).
            // Accept 1-2 letter symbols in any case and normalise to SHELXL's
            // uppercase style (C, H, CL, BR, NI, ...).
            for (let j = 1; j < parts.length; j++) {
                if (/^[A-Za-z]{1,2}$/.test(parts[j])) model.sfac.push(parts[j].toUpperCase());
            }
            i++; continue;
        }

        // Try to parse an atom line. Atoms start with a letter; their 2nd token
        // is the sfac index and tokens 3-5 are numeric x,y,z.
        const isAtomCandidate = /^[A-Za-z]/.test(parts[0])
            && SHELX_KEYWORDS.has(parts[0].toUpperCase()) === false
            && parts.length >= 5 && !isNaN(parseFloat(parts[1]))
            && !isNaN(parseFloat(parts[2])) && !isNaN(parseFloat(parts[3])) && !isNaN(parseFloat(parts[4]));

        if (isAtomCandidate) {
            // Merge '=' continuations into one token list.
            const tokens = [...parts];
            while (i + 1 < lines.length && tokens[tokens.length - 1] === '=') {
                tokens.pop();
                i++;
                tokens.push(...lines[i].trim().split(/\s+/));
            }
            const x = parseFloat(tokens[2]);
            const y = parseFloat(tokens[3]);
            const z = parseFloat(tokens[4]);
            const sfacIdx = parseInt(tokens[1], 10);
            const el = model.sfac[sfacIdx - 1]
                || (tokens[0].match(/^([A-Za-z]{1,2})/) ? tokens[0].match(/^([A-Za-z]{1,2})/)[1].toUpperCase() : 'C');
            const isQ = /^Q\d*/i.test(tokens[0]);
            const atom = {
                label: tokens[0],
                element: isQ ? 'Q' : el,
                x, y, z,
                occupancy: parts.length > 5 ? parseFloat(parts[5]) : 1.0,
                tokens,
                rawLine,
                lineIndex: model.atoms.length,
                part: null,   // filled by PART scanning pass below
            };
            model.atoms.push(atom);
            model.atomLines.push(atom);
            i++;
            continue;
        }

        // Everything else (REM, WGHT, AFIX, LIST, HKLF, UNIT, PART, etc.) kept as-is.
        model.instructions.push({ cmd, line: rawLine });
        i++;
    }

    // Annotate PART context so disordered partners survive reduction intact.
    let part = 0;
    for (const l of lines) {
        const t = l.trim().toUpperCase();
        if (t.startsWith('PART')) part = parseInt(t.split(/\s+/)[1], 10) || 0;
    }
    for (const a of model.atoms) a.part = part;

    return model;
}

// Build the metric tensor for fractional-distance comparisons.
function metricFromCell(cell) {
    const d2r = Math.PI / 180;
    const ca = Math.cos(cell.alpha * d2r), cb = Math.cos(cell.beta * d2r), cc = Math.cos(cell.gamma * d2r);
    return { g11: cell.a ** 2, g22: cell.b ** 2, g33: cell.c ** 2, g12: cell.a * cell.b * cc, g13: cell.a * cell.c * cb, g23: cell.b * cell.c * ca };
}

// Minimum-image fractional distance^2 between two points (metric-aware).
function fracDist2(a, b, metric) {
    let best = Infinity;
    for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
            for (let k = -1; k <= 1; k++) {
                const dx = (a.x - b.x + i);
                const dy = (a.y - b.y + j);
                const dz = (a.z - b.z + k);
                const d2 = dx * dx * metric.g11 + dy * dy * metric.g22 + dz * dz * metric.g33
                    + 2 * dx * dy * metric.g12 + 2 * dx * dz * metric.g13 + 2 * dy * dz * metric.g23;
                if (d2 < best) best = d2;
            }
        }
    }
    return best;
}

// Two atoms are "the same site" if same element (or both Q) and essentially
// same position.
function sameSite(a, b, metric, tolDist2) {
    if ((a.element === 'Q') !== (b.element === 'Q')) return false;
    if (a.element !== 'Q' && a.element !== b.element) return false;
    // Respect PART disorder: atoms in different PARTs are distinct sites.
    if (a.part && b.part && a.part !== b.part) return false;
    return fracDist2(a, b, metric) <= tolDist2;
}

// Apply origin shift to every atom.
function shiftAtoms(atoms, shift) {
    if (!shift || (!shift[0] && !shift[1] && !shift[2])) return atoms;
    return atoms.map(a => ({ ...a, x: a.x + shift[0], y: a.y + shift[1], z: a.z + shift[2] }));
}

/**
 * Expand `atoms` (treated as an asymmetric unit) by every operator in `ops`
 * to reconstruct the full cell content. Whole-molecule images are kept only
 * once (site-level dedup). Q peaks are copied without site-dedup collisions
 * between different original labels.
 */
export function expandAsu(atoms, ops, cell, { tolDist = 0.05 } = {}) {
    const metric = metricFromCell(cell);
    const tolDist2 = tolDist * tolDist;
    const out = [];
    const seen = [];  // kept reference sites

    for (const a of atoms) {
        for (const op of ops) {
            const im = wrapAtom(applyOp(a, op));
            const isQ = a.element === 'Q';
            // Skip an image that coincides with an already-kept non-Q site.
            let dup = false;
            if (!isQ) {
                for (const k of seen) {
                    if (sameSite(k, im, metric, tolDist2)) { dup = true; break; }
                }
            }
            if (!dup) {
                out.push(im);
                if (!isQ) seen.push(im);
            }
        }
    }
    // Wrap
    return out.map(wrapAtom);
}

/**
 * Reduce a full-cell-content atom list to an asymmetric unit under `ops`.
 * Atoms that are related to an earlier-kept site by one of the operators are
 * dropped. Q peaks are kept (not symmetry-reduced).
 */
export function reduceToAsu(atoms, ops, cell, { tolDist = 0.05 } = {}) {
    const metric = metricFromCell(cell);
    const tolDist2 = tolDist * tolDist;
    const kept = [];
    const qCounters = {};

    // Index by element for speed.
    const buckets = {};
    for (const a of atoms) {
        const k = a.element;
        if (!buckets[k]) buckets[k] = [];
        buckets[k].push(a);
    }

    for (const a of atoms) {
        const isQ = a.element === 'Q';
        if (isQ) {
            // Keep Q peaks but give them unique labels downstream.
            qCounters[a.label] = (qCounters[a.label] || 0) + 1;
            kept.push(a);
            continue;
        }
        // Check whether some already-kept site of the same element can reach `a`
        // via one of the operators (an existing orbit member).
        let redundant = false;
        for (const k of kept) {
            if (k.element !== a.element) continue;
            for (const op of ops) {
                const img = wrapAtom(applyOp(k, op));
                if (sameSite(img, a, metric, tolDist2)) { redundant = true; break; }
            }
            if (redundant) break;
        }
        if (!redundant) kept.push(a);
    }
    return kept.map(wrapAtom);
}

// --- Public entry point -----------------------------------------------------

/**
 * Transform a SHELX model into `targetSG` (space-group object with .hm/.s ops,
 * or an id/HM string). Returns
 *   { ok, error?, hm, ops, atoms (new ASU), removed, added, report, res }
 * `currentLatt`/`currentSymm` default to the model's own LATT/SYMM when the
 * .res carries them. `originShift` is an optional [dx,dy,dz] applied first.
 */
export function transformModelToSpaceGroup(modelText, targetSG,
    { currentLatt = null, currentSymm = null, originShift = null, tolDist = 0.05 } = {}) {
    let sg;
    try {
        const data = loadSpaceGroups();
        sg = typeof targetSG === 'string' || typeof targetSG === 'number'
            ? resolveSpaceGroup(data, targetSG)
            : (targetSG && targetSG.s ? targetSG : null);
        if (!sg) return { ok: false, error: `Space group not found: ${targetSG}` };
    } catch (e) {
        return { ok: false, error: e.message };
    }

    const parsed = parseShelxModel(modelText);
    if (!parsed.cell || !parsed.cell.a) {
        return { ok: false, error: 'No CELL parameters found in the model file.' };
    }
    if (!parsed.atoms.length) {
        return { ok: false, error: 'No atoms found in the model file (load a refined .res/.ins).' };
    }

    const latt = currentLatt != null ? currentLatt : parsed.latt;
    const symm = currentSymm || parsed.symm;
    const oldOps = opsFromLattSymm(latt, symm);
    const newOps = (sg.s || []).map(parseOperation).filter(Boolean);

    const atoms0 = shiftAtoms(parsed.atoms, originShift);

    // Full cell content under the OLD group.
    const full = expandAsu(atoms0, oldOps, parsed.cell, { tolDist });
    // ASU under the NEW group.
    const asu = reduceToAsu(full, newOps, parsed.cell, { tolDist });

    const countAtoms = (list) => list.filter(a => a.element !== 'Q').length;
    const nOld = countAtoms(atoms0);
    const nFull = countAtoms(full);
    const nNew = countAtoms(asu);
    const added = nNew - nOld;      // >0 => we ADDED symmetry partners
    const removed = nOld - nNew;    // >0 => we REMOVED redundant molecules

    const res = rebuildShelx(parsed, sg, asu, latt, symm, originShift);

    return {
        ok: true,
        hm: sg.hm,
        sgId: sg.id,
        nOldAsu: nOld,
        nFull: nFull,
        nNewAsu: nNew,
        removed,
        added,
        fullOps: oldOps.length,
        newOps: newOps.length,
        atoms: asu,
        res,
        report: [
            `Current space group: LATT ${latt} with ${parsed.symm.length} SYMM line(s) → ${oldOps.length} general positions.`,
            `Target space group: ${sg.hm} (No. ${sg.id}) with ${newOps.length} general positions.`,
            `Model asymmetric unit: ${nOld} atoms.`,
            `Full cell content reconstructed under current symmetry: ${nFull} atoms.`,
            `New asymmetric unit under ${sg.hm}: ${nNew} atoms`,
            added > 0 ? `  → added ${added} symmetry-related atom(s) (lower symmetry).`
                : removed > 0 ? `  → removed ${removed} redundant atom(s) (higher symmetry).`
                : '  → no change in content.',
        ].join('\n'),
    };
}

// Format a small number with a fixed width typical of SHELX atom lines.
function fmtNum(v, w = 8) {
    return Number(v).toFixed(4).padStart(w);
}

// Rebuild a .res/.ins with the target space group's LATT/SYMM and the new ASU.
// Header instructions (WGHT, REM, restraints, etc.) are carried over.
export function rebuildShelx(parsed, sg, atoms, oldLatt, oldSymm, originShift = null) {
    const lattNum = Math.abs(oldLatt) || 1;
    const centeringLetter = centeringOf(sg);
    // SHELX: positive LATT = centrosymmetric (SHELX adds inversion), negative = non-centrosymmetric.
    const lattSign = isCentro(sg) ? 1 : -1;
    const lattVal = lattSign * (LATT_CENTERING[centeringLetter] || lattNum);

    const out = [];
    if (parsed.title) {
        // Strip any trailing " in <spacegroup>" phrases then append the new one.
        const cleanTitle = parsed.title.replace(/(\s+in\s+[A-Za-z0-9_ /()-]*)+$/i, '').replace(/\s*$/, '');
        out.push(`TITL ${cleanTitle} in ${sg.hm}`);
    }
    if (parsed.cell) {
        const c = parsed.cell;
        out.push(`CELL ${Number(c.wavelength || 0.71073).toFixed(5)} ${c.a} ${c.b} ${c.c} ${c.alpha} ${c.beta} ${c.gamma}`);
    }
    if (parsed.zerr) out.push(parsed.zerr);
    out.push(`LATT ${lattVal}`);
    for (const op of shelxSymmOpsForSg(sg)) out.push(`SYMM ${op}`);

    // SFAC element list follows the DECLARATION order from the input file
    // (filtered to elements still present), so scattering-factor indices stay
    // stable. Q peaks use index 1 (SHELXL ignores their scattering type).
    const declared = parsed.sfac.map(s => s.toUpperCase());
    const present = new Set(atoms.filter(a => a.element !== 'Q').map(a => a.element.toUpperCase()));
    const elements = declared.filter(e => present.has(e));
    // If the model declares no SFAC, fall back to discovery order.
    if (!elements.length) {
        const seen = new Set();
        for (const a of atoms) {
            if (a.element === 'Q') continue;
            const e = a.element.toUpperCase();
            if (!seen.has(e)) { seen.add(e); elements.push(e); }
        }
    }
    const sfacIdx = new Map(elements.map((e, i) => [e, i + 1]));
    const sfacIndexOf = (el) => {
        if (el === 'Q') return 1;
        return sfacIdx.get(el.toUpperCase()) || 1;
    };

    if (elements.length) {
        out.push('SFAC ' + elements.join(' '));
        // UNIT must equal the number of atoms per element in the FULL unit cell
        // (SHELXL uses it for cell-content/electron checks). Re-expand the new
        // ASU under the target symmetry to count the true cell content.
        const targetOps = (sg.s || []).map(parseOperation).filter(Boolean);
        const full = expandAsu(atoms, targetOps, parsed.cell, { tolDist: 0.05 });
        const unit = elements.map(el => {
            const n = full.filter(a => a.element.toUpperCase() === el).length;
            return Math.max(1, Math.round(n));
        });
        out.push('UNIT ' + unit.join(' '));
    }

    // Pass through useful refinement instructions from the old file.
    const keep = [];
    for (const ins of parsed.instructions) {
        if (['REM', 'WGHT', 'LIST', 'ACTA', 'BOND', 'CONF', 'FMAP', 'PLAN',
            'HTAB', 'OMIT', 'ISOR', 'SIMU', 'DELU', 'RIGU', 'SADI', 'SAME',
            'DFIX', 'DANG', 'FLAT', 'CHIV', 'EADP', 'EXYZ', 'AFIX', 'HFIX',
            'TWIN', 'BASF', 'MERG', 'SIZE', 'TEMP', 'NEUT', 'ANIS', 'CONN',
            'RTAB', 'MPLA', 'RESI', 'MOVE', 'MOLE', 'GRID', 'CALC'].includes(ins.cmd)) {
            keep.push(ins.line);
        }
    }
    if (keep.length) out.push(...keep);

    // New ASU atoms, re-numbered cleanly; scattering-factor index is emitted
    // for each element (SHELXL needs it in column 2), and the original U
    // columns (iso or anisotropic block) are carried over.
    const counters = {};
    const qCounters = {};
    const writeAtom = (a) => {
        let label;
        if (a.element === 'Q') {
            qCounters.Q = (qCounters.Q || 0) + 1;
            label = 'Q' + qCounters.Q;
        } else {
            const el = a.element.toUpperCase();
            counters[el] = (counters[el] || 0) + 1;
            label = el + counters[el];
        }
        const occ = (a.occupancy != null ? a.occupancy : 1.0);
        const tail = (a.tokens && a.tokens.slice(6)) || [];
        const isAniso = tail.length >= 6;
        // SHELXL atom records are column-position sensitive: the label must
        // start at column 1 (no leading spaces), the scattering-factor index
        // right after, then x y z occ (each ~8-char field) and U.
        let line = `${label}  ${String(sfacIndexOf(a.element))}  ${fmtNum(a.x)}${fmtNum(a.y)}${fmtNum(a.z)}${fmtNum(occ)}`;
        if (isAniso) {
            const u = tail.slice();
            const first = u.splice(0, 3).join('  ');
            line += '  ' + first + (u.length ? '  =' : '');
            out.push(line);
            while (u.length) {
                const chunk = u.splice(0, 3).join('  ');
                out.push('        ' + chunk + (u.length ? '  =' : ''));
            }
            return;
        }
        if (tail.length) line += '  ' + tail.join('  ');
        out.push(line);
    };
    for (const a of atoms) writeAtom(a);
    out.push('HKLF 4');
    out.push('END');
    return out.join('\n') + '\n';
}

function isCentro(sg) {
    // Centrosymmetric if an op is the pure inversion or ops come in pairs.
    const inv = [[-1, 0, 0], [0, -1, 0], [0, 0, -1]];
    return (sg.s || []).some(op => {
        const p = parseOperation(op);
        if (!p) return false;
        let ok = true;
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
            if (Math.abs(p.R[i][j] - inv[i][j]) > 1e-9) ok = false;
        }
        return ok;
    });
}

// Return SYMM lines (SHELX convention: identity omitted; for centrosymmetric
// groups one op per inversion pair; lattice centering carried by LATT).
function shelxSymmOpsForSg(sg) {
    const centro = isCentro(sg);
    const centeringLetter = centeringOf(sg);
    const lattType = LATT_CENTERING[centeringLetter] || 1;
    const ops = (sg.s || []).map(parseOperation).filter(Boolean);
    const gens = shelxSymmGenerators(ops, { centrosymmetric: centro, latt: lattType });
    return gens.map(p => {
        const parts = [];
        for (let i = 0; i < 3; i++) parts.push(formatComponent(p.R[i], p.t[i]));
        return parts.join(', ');
    });
}

// Format "-x, 1/2+y, 1/2-z" (uppercase, fraction first).
function formatComponent(row, t) {
    const frac = (v) => {
        const denoms = [1, 2, 3, 4, 6, 8, 12];
        for (const d of denoms) {
            const n = Math.round(v * d);
            if (Math.abs(n - v * d) < 1e-9) return `${n}/${d}`;
        }
        return String(v);
    };
    const out = [];
    if (Math.abs(t) > 1e-9) {
        out.push((t < 0 ? '-' : '') + frac(Math.abs(t)));
    }
    const vars = [['X', row[0]], ['Y', row[1]], ['Z', row[2]]];
    for (const [name, coeff] of vars) {
        if (Math.abs(coeff) < 1e-9) continue;
        const sign = coeff < 0 ? '-' : (out.length ? '+' : '');
        const mag = Math.abs(coeff);
        out.push(sign + (Math.abs(mag - 1) < 1e-9 ? name : frac(mag) + name));
    }
    return out.join('') || '0';
}

