// Pure-JS structural validation + disorder/twinning detectors for SHELX models.
// Produces CheckCIF-style alerts (A = severe, B = should fix, C/G = advisory)
// from a .res/.ins model and an optional .lst refinement log. Works fully
// server-side (node) and needs no external program, so a report is always
// available even when PLATON cannot run on the host.

export const SHELX_KW = new Set([
    'TITL', 'CELL', 'ZERR', 'LATT', 'SYMM', 'SFAC', 'UNIT', 'HKLF', 'SIZE',
    'TEMP', 'MOLE', 'RESI', 'MOVE', 'ANIS', 'AFIX', 'HFIX', 'EQIV', 'CONN',
    'PART', 'BIND', 'FREE', 'DANG', 'BOND', 'CONF', 'MPLA', 'RTAB', 'HTAB',
    'LIST', 'ACTA', 'WGHT', 'FVAR', 'REM', 'END', 'OMIT', 'SADI', 'SAME',
    'SIMU', 'DELU', 'RIGU', 'ISOR', 'NCSY', 'SUMP', 'L.S.', 'CGLS', 'BLOC',
    'DAMP', 'STIR', 'TWIN', 'BASF', 'SWAT', 'HOPE', 'MERG', 'SPEC', 'RESC',
    'RIGU', 'SHEL', 'GRID', 'CALC', 'EXYZ', 'EADP', 'REST', 'MORE', 'DISP'
]);

// Covalent radii (Å, Cordero-ish) used only for plausibility of short contacts.
const COV = { H: 0.31, C: 0.76, N: 0.71, O: 0.66, F: 0.57, P: 1.07, S: 1.05,
    CL: 1.02, BR: 1.20, I: 1.39, B: 0.84, SI: 1.11, NI: 1.24, CU: 1.32, ZN: 1.22,
    FE: 1.32, MN: 1.39, CO: 1.26, CR: 1.39, RU: 1.46, RH: 1.42, PD: 1.39, PT: 1.36,
    AU: 1.36, AG: 1.45, OS: 1.44, IR: 1.41, MO: 1.54, W: 1.62, SE: 1.20, NA: 1.66,
    K: 2.03, CA: 1.76, MG: 1.41, LI: 1.28, AL: 1.21, GA: 1.22, SN: 1.40, PB: 1.44,
    TI: 1.60, CD: 1.44, HG: 1.32 };
const covRadius = (el) => COV[(el || '').toUpperCase()] || 1.5;

function parseAtomLine(line) {
    const t = line.trim();
    if (!t || t.startsWith('REM') || t.startsWith(';')) return null;
    const parts = t.split(/\s+/);
    if (parts.length < 5) return null;
    if (SHELX_KW.has(parts[0].toUpperCase())) return null;
    if (!/^[A-Z][A-Za-z0-9\-_']*$/.test(parts[0])) return null;
    if (!(isFinite(+parts[2]) && isFinite(+parts[3]) && isFinite(+parts[4]))) return null;
    return parts;
}

function sfacElements(lines) {
    const els = [''];
    for (const l of lines) {
        const t = l.trim();
        if (!/^SFAC/i.test(t)) continue;
        const p = t.split(/\s+/).slice(1);
        let i = 0;
        if (p.length && /^\d+$/.test(p[0])) i = 1; // SFAC n C H O ...
        for (; i < p.length; i++) if (/^[A-Z][a-z]?$/.test(p[i])) els.push(p[i].toUpperCase());
    }
    return els;
}

export function parseStructure(text) {
    const lines = (text || '').split(/\r?\n/);
    const sfac = sfacElements(lines);
    const atoms = [];
    const keys = new Set();
    const instr = { part: null, fvar: 1 };
    const instructions = [];
    let part = 0;
    for (const line of lines) {
        const t = line.trim();
        const up = t.toUpperCase();
        if (/^(REM|;)/.test(t)) continue;
        if (/^PART/i.test(t)) {
            part = parseInt(t.split(/\s+/)[1] || '0', 10) || 0;
            instr.part = part;
            instructions.push({ type: 'PART', value: part });
            continue;
        }
        if (/^TWIN/i.test(t)) instructions.push({ type: 'TWIN', text: t });
        if (/^BASF/i.test(t)) {
            instructions.push({ type: 'BASF', value: parseFloat(t.split(/\s+/)[1]) || null });
            continue;
        }
        if (/^(EADP|SAME|SADI|DELU|SIMU|RIGU|ISOR|RIGI|AFIX|FLAT|CHIV|CONF|DFIX|DANG|BUMP)\b/i.test(t)) {
            instructions.push({ type: up.split(/\s+/)[0], text: t });
            continue;
        }
        const parts = parseAtomLine(line);
        if (!parts) continue;
        const label = parts[0];
        const key = label.toUpperCase().replace(/\d+$/, '');
        const sfacIdx = parseInt(parts[1], 10);
        const element = (sfac[sfacIdx] || key.replace(/[^A-Z]/g, '').replace(/^(\D+).*/, '$1')).toUpperCase();
        const x = +parts[2], y = +parts[3], z = +parts[4];
        const occRaw = parts.length > 5 ? parseFloat(parts[5]) : 1;
        // SOF >= 10 references an FVAR free variable (e.g. 11.0 -> FVAR 1).
        const fvarRef = Math.abs(occRaw) >= 10 ? Math.abs(Math.round(occRaw / 10)) : null;
        const occ = fvarRef ? null : occRaw; // null = refined via free variable
        const uRaw = parts.length > 6 ? parseFloat(parts[6]) : null;
        atoms.push({
            label, element, x, y, z, occ, occRaw, fvarRef, u: uRaw, part
        });
        if (keys.has(label.toUpperCase())) {
            atoms[atoms.length - 1].duplicate = true;
        }
        keys.add(label.toUpperCase());
    }
    return { atoms, sfac: sfac.filter(Boolean), instructions, lines };
}

// Parse CELL/ZERR/UNIT to know cell contents & composition expectations.
export function parseCellLines(text) {
    const out = { cell: null, unit: {}, zerr: null, wght: null, twin: false, basf: null, shelxlCycles: null };
    const lines = (text || '').split(/\r?\n/);
    for (const line of lines) {
        const t = line.trim();
        const up = t.toUpperCase();
        if (/^CELL/i.test(t)) {
            const p = t.split(/\s+/);
            if (p.length >= 8) out.cell = {
                wl: parseFloat(p[1]) || null, a: +p[2], b: +p[3], c: +p[4],
                al: +p[5], be: +p[6], ga: +p[7]
            };
        } else if (/^UNIT/i.test(t)) {
            const p = t.split(/\s+/).slice(1).map(Number);
            out.unit = p; // matches SFAC order
        } else if (/^WGHT/i.test(t)) {
            out.wght = t;
        } else if (/^TWIN/i.test(t)) {
            out.twin = true;
        } else if (/^BASF/i.test(t)) {
            out.basf = parseFloat(t.split(/\s+/)[1]) || 0;
        }
    }
    return out;
}

const angle = (u, v) => {
    const d = Math.sqrt(u.reduce((s, x) => s + x * x, 0) * v.reduce((s, x) => s + x * x, 0));
    return d ? Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / d))) * 180 / Math.PI : 0;
};

// Minimum-image distance between two atoms given the (triclinic) cell.
export function minDist(a1, a2, cell) {
    const rad = Math.PI / 180;
    const { a, b, c, al, be, ga } = cell;
    const ca = Math.cos(al * rad), cb = Math.cos(be * rad), cg = Math.cos(ga * rad);
    const sg = Math.sin(ga * rad);
    const v = a * b * c * Math.sqrt(1 - ca * ca - cb * cb - cg * cg + 2 * ca * cb * cg);
    // Fractional -> Cartesian matrix
    const m = [
        [a, b * cg, c * cb],
        [0, b * sg, c * (ca - cb * cg) / sg],
        [0, 0, v / (a * b * sg)]
    ];
    const cart = (at) => {
        const dx = at.x, dy = at.y, dz = at.z;
        return [
            m[0][0] * dx + m[0][1] * dy + m[0][2] * dz,
            m[1][1] * dy + m[1][2] * dz,
            m[2][2] * dz
        ];
    };
    const p1 = cart(a1), p2 = cart(a2);
    let best = Infinity;
    for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
            for (let k = -1; k <= 1; k++) {
                const x = (a2.x + i) * m[0][0] + (a2.y + j) * m[0][1] + (a2.z + k) * m[0][2];
                const y = (a2.y + j) * m[1][1] + (a2.z + k) * m[1][2];
                const z = (a2.z + k) * m[2][2];
                const dx = p1[0] - x, dy = p1[1] - y, dz = p1[2] - z;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 < best * best) best = Math.sqrt(d2);
            }
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Disorder + twinning detectors (report-style objects).
// ---------------------------------------------------------------------------

export function detectDisorder(text) {
    const { atoms, instructions } = parseStructure(text);
    const findings = [];
    const parts = new Set();
    instructions.forEach(i => { if (i.type === 'PART') parts.add(i.value); });
    const nonZeroParts = [...parts].filter(p => p !== 0);
    const fvarRefs = atoms.filter(a => a.fvarRef);

    // 1) multiple PART blocks => modelled disorder
    if (nonZeroParts.length >= 2 || (nonZeroParts.length === 1 && atoms.some(a => a.part !== nonZeroParts[0] && a.part === 0))) {
        findings.push({
            level: 'G', kind: 'disorder',
            text: `Disorder modelled with PART instruction(s): ${nonZeroParts.join(', ')}. Verify free-variable occupancies sum sensibly on each site.`
        });
    }
    // 2) free-variable occupancies present
    if (fvarRefs.length) {
        const seen = new Map();
        fvarRefs.forEach(a => {
            const r = a.fvarRef;
            if (!seen.has(r)) seen.set(r, []);
            seen.get(r).push(a.label);
        });
        for (const [k, labs] of seen) {
            const others = atoms.filter(a => a.fvarRef !== k && !a.fvarRef);
            findings.push({
                level: 'G', kind: 'disorder',
                text: `Occupancies of ${labs.slice(0, 8).join(', ')} refine via free variable FVAR ${k}. Confirm occupancies for the corresponding disorder site sum to 1.`
            });
        }
    }
    // 3) high Ueq flags (likely disorder / unresolved static disorder)
    const byEl = {};
    atoms.forEach(a => {
        if (!byEl[a.element]) byEl[a.element] = [];
        byEl[a.element].push(a);
    });
    for (const el of Object.keys(byEl)) {
        if (el === 'H') continue;
        const arr = byEl[el];
        const maxU = Math.max(...arr.map(a => a.u || 0));
        const avgU = arr.reduce((s, a) => s + (a.u || 0), 0) / arr.length;
        if (maxU > 0.2 && avgU > 0.08) {
            const worst = arr.filter(a => a.u === maxU).map(a => a.label).slice(0, 6).join(', ');
            findings.push({
                level: 'B', kind: 'disorder',
                text: `Large displacement parameters: ${worst} (${el}) have U(eq) ≈ ${maxU.toFixed(3)} Å² (mean ${el} ${avgU.toFixed(3)}). Possible unresolved disorder — consider split positions, restraints (SIMU/DELU/RIGU/ISOR) or a fixed H scheme.`
            });
        }
    }
    return findings;
}

export function detectTwinning(text, lstText) {
    const findings = [];
    const { instructions } = parseStructure(text);
    const hasTwin = instructions.some(i => i.type === 'TWIN');
    const basf = instructions.find(i => i.type === 'BASF');
    const lst = lstText || '';

    const flackM = lst.match(/Flack\s*x\s*=\s*([\d.\-()]+)/);
    const flack = flackM ? parseFloat(flackM[1].replace(/[()]/g, '')) : null;

    if (hasTwin || basf) {
        const v = basf && basf.value != null ? ` (BASF ${basf.value})` : '';
        findings.push({
            level: 'C', kind: 'twinning',
            text: `Structure refined as a twin (TWIN instruction${v}). Confirm the twin law and that BASF converged to a sensible value.`
        });
    }
    if (flack != null && Math.abs(flack - 0.5) < 0.15) {
        findings.push({
            level: 'A', kind: 'twinning',
            text: `Flack parameter ${flack} ≈ 0.5 — the crystal may be an inversion twin (or racemically twinned). Refine a BASF (inversion twin law: '-1 0 0 0 -1 0 0 0 -1') and confirm.`
        });
    } else if (flack != null && flack > 0.25 && flack < 0.75) {
        findings.push({
            level: 'B', kind: 'twinning',
            text: `Flack parameter ${flack} is large for an absolute-structure determination. Consider inversion-twin (BASF) refinement.`
        });
    }
    if (!hasTwin && !basf && flack == null && /No Flack|centric|centrosymmetric/i.test(lst)) {
        // centrosymmetric - fine, no action
    }
    return findings;
}

// ---------------------------------------------------------------------------
// Full validation report.
// ---------------------------------------------------------------------------

export function validateStructure(text, lstText = '', opts = {}) {
    const alerts = [];
    const { atoms, sfac, instructions } = parseStructure(text);
    const cellInfo = parseCellLines(text);
    const lst = lstText || '';

    if (!atoms.length) {
        alerts.push({ level: 'A', code: 'NOMODEL', text: 'No atoms found in the structure file.' });
    }

    // --- duplicates
    const dupLabels = {};
    atoms.forEach(a => { dupLabels[a.label.toUpperCase()] = (dupLabels[a.label.toUpperCase()] || 0) + 1; });
    const dups = Object.entries(dupLabels).filter(([, n]) => n > 1);
    if (dups.length) {
        alerts.push({ level: 'A', code: 'DUPLICATE', text: `Duplicate atom labels: ${dups.map(([l, n]) => `${l}×${n}`).join(', ')}.` });
    }

    // --- hydrogens / missing H
    const nH = atoms.filter(a => a.element === 'H').length;
    const heavy = atoms.filter(a => a.element !== 'H');
    const nQ = atoms.filter(a => /^Q/i.test(a.label)).length;
    if (nQ > 20) {
        alerts.push({ level: 'B', code: 'QPEAKS', text: `${nQ} Q-peaks remain — consider assigning or removing them.` });
    } else if (nQ > 5) {
        alerts.push({ level: 'C', code: 'QPEAKS', text: `${nQ} Q-peaks remain in the model.` });
    }
    if (heavy.length && nH === 0) {
        alerts.push({ level: 'C', code: 'NO_H', text: 'No hydrogen atoms in the model — add them (HFIX) if chemically expected.' });
    }

    // --- geometry: unreasonably short contacts (excl. Q-peaks, H)
    const realHeavy = heavy.filter(a => !/^Q\d/i.test(a.label));
    if (cellInfo.cell && realHeavy.length < 200) {
        const shortContacts = [];
        for (let i = 0; i < realHeavy.length && shortContacts.length < 8; i++) {
            const ai = realHeavy[i];
            if (ai.element === 'H') continue;
            for (let j = i + 1; j < realHeavy.length; j++) {
                const aj = realHeavy[j];
                if (aj.element === 'H') continue;
                const d = minDist(ai, aj, cellInfo.cell);
                const lim = (covRadius(ai.element) + covRadius(aj.element)) * 0.6;
                if (d > 0.0001 && d < lim) {
                    shortContacts.push({ a: ai.label, b: aj.label, d, limit: lim });
                }
            }
        }
        if (shortContacts.length) {
            alerts.push({
                level: 'A', code: 'SHORT', text: `Short non-bonded contacts: ${shortContacts.map(c => `${c.a}…${c.b} ${c.d.toFixed(2)} Å`).join(', ')} — check for disorder/duplication or a wrong atom assignment.`
            });
        }
    }

    // --- ADPs: atoms with u column but very small/large
    const realAtoms = atoms.filter(a => !/^Q\d/i.test(a.label));
    const noU = realAtoms.filter(a => a.element !== 'H' && (a.u == null || a.u === 0) && !a.fvarRef);
    if (noU.length) {
        alerts.push({ level: 'C', code: 'NOU', text: `${noU.length} non-H atoms have no displacement parameter set.` });
    }
    const hugeU = realAtoms.filter(a => a.element !== 'H' && a.u != null && a.u > 0.5);
    if (hugeU.length) {
        alerts.push({ level: 'B', code: 'UHUGE', text: `Very large U: ${hugeU.map(a => a.label).join(', ')} (>0.5 Å²) — atom may be misassigned or require disorder treatment.` });
    }

    // --- cell contents from ZERR/UNIT vs atom count (rough)
    const nonHCount = atoms.filter(a => a.element !== 'H').length;
    if (cellInfo.unit && cellInfo.unit.length && sfac.length) {
        const expected = cellInfo.unit.reduce((s, v, idx) => {
            const el = sfac[idx];
            return el === 'H' ? s : s + v;
        }, 0);
        // only compare if the file actually lists atoms (a solution, not a template)
        if (nonHCount > 0 && Math.abs(expected - nonHCount) > Math.max(4, nonHCount * 0.1)) {
            alerts.push({ level: 'C', code: 'COMP', text: `Number of non-H atoms in the file (${nonHCount}) differs from the UNIT/ZERR cell contents (${expected}) — check symmetry/PART duplicates.` });
        }
    }

    // --- from .lst
    const grab = (re) => { const m = lst.match(re); return m && m[1] != null ? m[1] : null; };
    const r1 = grab(/R1\s*=\s*([\d.]+)\s+for\s+\d+\s+Fo\s*>\s*\d+sig\(Fo\)/);
    const wr = lst.match(/wR2\s*=\s*([\d.]+),\s*GooF\s*=\s*S\s*=\s*([\d.]+)/);
    const goof = wr ? wr[2] : null;
    const wr2 = wr ? wr[1] : null;
    const peak = grab(/Highest\s+peak\s*([\d.\-]+)/);
    const hole = grab(/Deepest\s+hole\s*([\d.\-]+)/);

    if (r1) {
        const v = parseFloat(r1);
        if (v > 0.10) alerts.push({ level: 'A', code: 'R1', text: `R1 = ${r1} is high for a finished small-molecule structure (>0.10). Refine further / fix the model.` });
        else if (v > 0.07) alerts.push({ level: 'B', code: 'R1', text: `R1 = ${r1} — refine further if possible.` });
    }
    if (goof) {
        const g = parseFloat(goof);
        if (Math.abs(g - 1) > 0.3) alerts.push({ level: 'A', code: 'GOOF', text: `Goodness-of-fit S = ${goof} is far from 1 — weighting or data problems.` });
        else if (Math.abs(g - 1) > 0.15) alerts.push({ level: 'B', code: 'GOOF', text: `Goodness-of-fit S = ${goof} deviates from 1 — consider WGHT optimisation.` });
    }
    if (peak) {
        const v = parseFloat(peak);
        if (v > 2.0) alerts.push({ level: 'B', code: 'PEAK', text: `Highest residual peak ${peak} e/Å³ — may indicate missed disorder/twin or incorrect atom.` });
    }
    if (hole && parseFloat(hole) < -2.0) {
        alerts.push({ level: 'B', code: 'HOLE', text: `Deepest residual hole ${hole} e/Å³.` });
    }

    // --- structure-solution specific
    if (opts.solveRun) {
        const shelxtWarn = grab(/Alert\s+[AB]\s*:/);
        if (shelxtWarn) alerts.push({ level: 'B', code: 'SOLVE', text: `Solution program reported: ${shelxtWarn}` });
    }

    const disorder = detectDisorder(text);
    const twinning = detectTwinning(text, lst);
    const all = [...alerts, ...disorder, ...twinning];
    all.forEach(a => { if (!a.code) a.code = a.kind ? a.kind.toUpperCase() : 'INFO'; });

    const count = { A: 0, B: 0, C: 0, G: 0 };
    all.forEach(a => { const lv = a.level || 'C'; count[lv] = (count[lv] || 0) + 1; });

    const atomsPresent = atoms.length > 0;
    const r1ok = !r1 || parseFloat(r1) < 0.05;
    const goofOk = !goof || Math.abs(parseFloat(goof) - 1) < 0.15;
    let verdict = 'review';
    if (atomsPresent && count.A === 0 && r1ok && goofOk && count.B <= 1) verdict = 'good';
    else if (atomsPresent && count.A === 0 && count.B <= 3) verdict = 'acceptable';
    else if (count.A > 0) verdict = 'needs-work';

    return {
        alerts: all, count,
        stats: { r1, wr2, goof, peak, hole, atoms: atoms.length, h: nH, q: nQ, sfac, twin: cellInfo.twin, basf: cellInfo.basf, wght: cellInfo.wght },
        disorder, twinning, verdict
    };
}

// Render the report as readable plain text (for UI / logs / MCP).
export function renderReport(report) {
    const L = [];
    const s = report.stats || {};
    L.push('STRUCTURE VALIDATION REPORT');
    L.push('===========================');
    L.push(`Model: ${s.atoms || 0} atoms (${s.h || 0} H${s.q ? `, ${s.q} Q-peaks` : ''})  SFAC: ${(s.sfac || []).join(' ') || 'n/a'}`);
    if (s.r1) L.push(`Refinement: R1=${s.r1}  wR2=${s.wr2 || '?'}  GooF=${s.goof || '?'}${s.twin ? `  (TWIN ${s.basf ?? ''})` : ''}`);
    L.push(`Verdict: ${report.verdict}  —  A:${report.count.A || 0}  B:${report.count.B || 0}  C:${report.count.C || 0}  G:${report.count.G || 0}`);
    L.push('');
    if (!report.alerts.length) {
        L.push('No alerts. Looks clean.');
    }
    for (const a of report.alerts) {
        L.push(`[${a.level}] ${a.code}: ${a.text}`);
    }
    if (report.disorder.length) { L.push(''); L.push('DISORDER:'); report.disorder.forEach(a => L.push(`  [${a.level}] ${a.text}`)); }
    if (report.twinning.length) { L.push(''); L.push('TWINNING:'); report.twinning.forEach(a => L.push(`  [${a.level}] ${a.text}`)); }
    return L.join('\n');
}
