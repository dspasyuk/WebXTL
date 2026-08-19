import {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    WidthType, AlignmentType, BorderStyle, HeadingLevel, PageOrientation,
    VerticalAlign, TableLayoutType
} from 'docx';

// ---------------------------------------------------------------------------
// CIF parsing
// ---------------------------------------------------------------------------

// Parse a CIF text into a structured object.
// Returns { dataName, kv: {key: value}, loops: [{headers, rows}] }
export function parseCif(text) {
    const lines = text.split(/\r?\n/);
    const kv = {};
    const loops = [];
    let dataName = '';
    let i = 0;

    while (i < lines.length) {
        const raw = lines[i];
        const line = raw.trim();

        if (line.startsWith('data_')) {
            dataName = line.slice(5).trim();
            i++;
            continue;
        }

        if (line === 'loop_') {
            const headers = [];
            i++;
            while (i < lines.length && lines[i].trim().startsWith('_')) {
                headers.push(lines[i].trim());
                i++;
            }
            const rows = [];
            while (i < lines.length) {
                const rl = lines[i].trim();
                if (rl === '' || rl === 'loop_' || rl.startsWith('data_') || rl.startsWith('_')) {
                    break;
                }
                rows.push(rl.split(/\s+/));
                i++;
            }
            loops.push({ headers, rows });
            continue;
        }

        if (line.startsWith('_')) {
            const sp = line.indexOf(' ');
            const key = sp === -1 ? line : line.slice(0, sp).trim();
            let value = sp === -1 ? '' : line.slice(sp + 1).trim();
            if (value === ';') {
                // multi-line value
                const buf = [];
                i++;
                while (i < lines.length && lines[i].trim() !== ';') {
                    buf.push(lines[i]);
                    i++;
                }
                i++; // skip closing ';'
                value = buf.join('\n').trim();
            }
            kv[key] = value;
            i++;
            continue;
        }

        i++;
    }

    return { dataName, kv, loops };
}

// Find a loop whose headers contain a given key.
function findLoop(loops, key) {
    return loops.find(l => l.headers.some(h => h.startsWith(key)));
}

// ---------------------------------------------------------------------------
// Publish CIF generation
// ---------------------------------------------------------------------------

const SG_RENAMES = [
    ['_space_group_crystal_system', '_symmetry_cell_setting'],
    ['_space_group_name_Hall', '_symmetry_space_group_name_Hall'],
    ['_space_group_name_H-M_alt', '_symmetry_space_group_name_H-M'],
];

// Extract and clean the main data block (data_ ... _refine_diff_density_rms).
// Returns an array of lines with space-group keys renamed and PLATON squeeze removed.
export function extractMainBlock(cifText) {
    const lines = cifText.split(/\r?\n/);

    // Locate the data block boundaries.
    let start = 0;
    let end = lines.length - 1;
    for (let n = 0; n < lines.length; n++) {
        const l = lines[n].trim();
        if (l.startsWith('data_')) start = n;
        if (l.startsWith('_refine_diff_density_rms')) end = n + 1;
    }

    let block = lines.slice(start, end + 1);

    // Rename space-group keys to standard symmetry keys.
    block = block.map(l => {
        const t = l.trim();
        for (const [from, to] of SG_RENAMES) {
            if (t.startsWith(from)) {
                return l.replace(from, to);
            }
        }
        return l;
    });

    // Drop PLATON squeeze lines if present.
    if (block.some(l => l.toLowerCase().includes('_platon_squeeze'))) {
        block = block.filter(l => !l.toLowerCase().includes('_platon_squeeze'));
    }

    // Collapse runs of blank lines and trim.
    const cleaned = [];
    let blank = 0;
    for (const l of block) {
        if (l.trim() === '') {
            blank++;
            if (blank <= 1) cleaned.push('');
        } else {
            blank = 0;
            cleaned.push(l);
        }
    }
    while (cleaned.length && cleaned[0] === '') cleaned.shift();
    while (cleaned.length && cleaned[cleaned.length - 1] === '') cleaned.pop();
    return cleaned;
}

// Parse a .dev file (one "key value" per line) into an object.
export function parseDevFile(text) {
    const dict = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const sp = line.indexOf(' ');
        if (sp === -1) continue;
        const key = line.slice(0, sp).trim();
        const value = line.slice(sp + 1).trim();
        if (key.startsWith('_')) dict[key] = value;
    }
    return dict;
}

function formatKeyValue(key, value, multilineBody) {
    if (multilineBody) {
        return `${key.padEnd(33)} ;\n${multilineBody.join('\n')}\n;`;
    }
    return `${key.padEnd(33)} ${value}`;
}

// Quote a CIF value if it is not numeric, not already quoted, and not '?'.
// Mirrors the Python check_values() behaviour.
export function checkValue(value) {
    const v = String(value ?? '').trim();
    if (v === '' || v === '?') return v;
    if (v.includes("'") || v.includes('"')) return v;
    // Numeric (optionally with esd in parentheses) -> leave as-is.
    if (/^[-+]?[\d.]+(\(\d+\))?$/.test(v)) return v;
    return `'${v}'`;
}

// Apply a key->value dict to a block of CIF lines.
// - Existing single-line keys: value replaced (33-char key column preserved).
// - Existing multi-line (;) keys: whole block replaced by the new single-line value.
// - Missing keys: appended at the end.
export function applyValuesToBlock(block, values) {
    const out = [];
    const consumed = new Set();
    let i = 0;
    while (i < block.length) {
        const line = block[i];
        const t = line.trim();
        const sp = t.indexOf(' ');
        const isKey = t.startsWith('_');
        const key = isKey ? (sp === -1 ? t : t.slice(0, sp)) : null;

        if (key && Object.prototype.hasOwnProperty.call(values, key)) {
            consumed.add(key);
            const newValue = values[key];
            const valuePart = sp === -1 ? '' : t.slice(sp + 1).trim();

            if (sp === -1 || valuePart === ';') {
                // Multi-line ;-block: consume until the closing ';'.
                i++;
                if (i < block.length && block[i].trim() === ';') i++; // opening ';'
                while (i < block.length && block[i].trim() !== ';') i++;
                i++; // closing ';'
                out.push(formatKeyValue(key, newValue));
            } else {
                out.push(formatKeyValue(key, newValue));
                i++;
            }
            continue;
        }
        out.push(line);
        i++;
    }
    for (const [k, v] of Object.entries(values)) {
        if (!consumed.has(k)) out.push(formatKeyValue(k, v));
    }
    return out;
}

// Build a publish CIF from templates (mirrors the Python "Prepare cif for publication"):
//   publish.cif = user template (data_global) + main block with device values applied.
// options: { userTemplate: string, deviceValues: {key: value}, extraValues: {key: value} }
// extraValues come from the manual form and are auto-quoted via checkValue().
export function buildPublishCifFromTemplates(cifText, options = {}) {
    const mainBlock = extractMainBlock(cifText);
    const deviceValues = options.deviceValues || {};
    const extraValues = {};
    for (const [k, v] of Object.entries(options.extraValues || {})) {
        if (v === undefined || v === null || String(v).trim() === '') continue;
        extraValues[k] = checkValue(v);
    }
    const values = { ...deviceValues, ...extraValues };
    const updatedBlock = applyValuesToBlock(mainBlock, values);

    let out = '';
    if (options.userTemplate) {
        out += options.userTemplate.replace(/\s+$/, '') + '\n\n';
    }
    out += updatedBlock.join('\n') + '\n';
    return out;
}

// Build a clean, publication-ready CIF from a SHELXL .cif (manual mode, no templates).
// options: { includeGlobal: bool, global: {author, address, email, title, abstract, references, figureCaptions, tableLegends} }
export function buildPublishCif(cifText, options = {}) {
    const cleaned = extractMainBlock(cifText);

    let out = '';

    if (options.includeGlobal) {
        const g = options.global || {};
        out += 'data_global\n';
        out += '#==============================================================================\n';
        out += '#                          1. SUBMISSION DETAILS\n';
        out += '#==============================================================================\n';
        out += `_publ_contact_author_name   '${g.author || '?'}'\n`;
        out += `_publ_contact_author_address\n;${g.address ? '\n' + g.address.split('\n').map(s => '   ' + s).join('\n') : '\n   ?'}\n;\n`;
        out += `_publ_contact_author_email  '${g.email || '?'}'\n`;
        out += '#==============================================================================\n';
        out += '#                        3. TITLE AND AUTHOR LIST\n';
        out += '#==============================================================================\n';
        out += `_publ_section_title\n;${g.title ? '\n' + g.title : '\n   ?'}\n;\n`;
        out += `_publ_section_abstract\n;${g.abstract ? '\n' + g.abstract : '\n   To be filled at the time of submission'}\n;\n`;
        out += `_publ_section_exptl_refinement\n;${g.refinement ? '\n' + g.refinement : '\n   All non-H atoms were refined with anisotropic displacement parameters. The H atoms were generated geometrically and refined in the riding model approximation.'}\n;\n`;
        out += `_publ_section_figure_captions\n;${g.figureCaptions ? '\n' + g.figureCaptions : '\n   Fig 1 Ortep view of the title compound. Thermal ellipsoids are shown at 50% probability levels.'}\n;\n`;
        out += `_publ_section_table_legends\n;${g.tableLegends ? '\n' + g.tableLegends : '\n   Table 1. Crystal data and structure refinement for the title compound.'}\n;\n`;
        out += `_publ_section_references\n;${g.references ? '\n' + g.references : '\n   Sheldrick, G. M. (2015). SHELXL. Program for crystal structure refinement. University of G\\u00f6ttingen, Germany.'}\n;\n`;
        out += '\n';
    }

    out += cleaned.join('\n') + '\n';
    return out;
}

// ---------------------------------------------------------------------------
// DOCX report generation
// ---------------------------------------------------------------------------

const thinBorder = { style: BorderStyle.SINGLE, size: 4, color: '999999' };
const cellBorders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

function cell(text, { bold = false, width, align = AlignmentType.LEFT, shading } = {}) {
    return new TableCell({
        borders: cellBorders,
        width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
        verticalAlign: VerticalAlign.CENTER,
        shading: shading ? { fill: shading } : undefined,
        children: [
            new Paragraph({
                alignment: align,
                children: [new TextRun({ text: String(text ?? ''), bold, size: 18 })],
            }),
        ],
    });
}

function headerRow(labels, widths) {
    return new TableRow({
        tableHeader: true,
        children: labels.map((l, idx) => cell(l, { bold: true, align: AlignmentType.CENTER, shading: 'D9E1F2', width: widths && widths[idx] })),
    });
}

function dataRow(values, widths, aligns) {
    return new TableRow({
        children: values.map((v, idx) => cell(v, {
            align: aligns && aligns[idx] ? aligns[idx] : AlignmentType.LEFT,
            width: widths && widths[idx],
        })),
    });
}

function makeTable(rows, widths, aligns) {
    return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        layout: TableLayoutType.FIXED,
        rows,
    });
}

function heading(text, level = HeadingLevel.HEADING_2) {
    return new Paragraph({ heading: level, spacing: { before: 240, after: 120 }, children: [new TextRun({ text, bold: true })] });
}

function para(text, opts = {}) {
    return new Paragraph({
        alignment: opts.align,
        spacing: { after: opts.after ?? 80 },
        children: [new TextRun({ text, bold: opts.bold, italics: opts.italics, size: opts.size ?? 20 })],
    });
}

// Two-column key/value table (Table 1).
function keyValueTable(pairs) {
    const rows = [];
    for (const [k, v] of pairs) {
        rows.push(new TableRow({
            children: [
                cell(k, { bold: true, width: 45, shading: 'F2F2F2' }),
                cell(v, { width: 55 }),
            ],
        }));
    }
    return makeTable(rows);
}

function get(kv, key, fallback = '?') {
    const v = kv[key];
    if (v === undefined || v === '' || v === '?') return fallback;
    return v;
}

function pct(v) {
    const n = parseFloat(v);
    if (isNaN(n)) return '?';
    return (n * 100).toFixed(1) + ' %';
}

// Build the full crystallographic report as a DOCX buffer.
export async function buildReportDocx(cifText, options = {}) {
    const { dataName, kv, loops } = parseCif(cifText);
    const title = options.title || get(kv, '_chemical_name_common', dataName || 'Structure');

    const atomLoop = findLoop(loops, '_atom_site_label');
    const bondLoop = findLoop(loops, '_geom_bond_atom_site_label_1');
    const angleLoop = findLoop(loops, '_geom_angle_atom_site_label_1');
    const hbondLoop = findLoop(loops, '_geom_hbond_atom_site_label_D');

    const children = [];

    // Title
    children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({ text: 'Crystallographic Report', bold: true, size: 32 })],
    }));
    children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 300 },
        children: [new TextRun({ text: title, bold: true, size: 26 })],
    }));

    // ---- Table 1: Crystal data and structure refinement ----
    children.push(heading('Table 1. Crystal data and structure refinement'));
    const a = get(kv, '_cell_length_a'), b = get(kv, '_cell_length_b'), c = get(kv, '_cell_length_c');
    const al = get(kv, '_cell_angle_alpha'), be = get(kv, '_cell_angle_beta'), ga = get(kv, '_cell_angle_gamma');
    const pairs = [
        ['Identification code', get(kv, '_chemical_name_common', dataName)],
        ['Chemical formula', get(kv, '_chemical_formula_sum')],
        ['Molecular weight', get(kv, '_chemical_formula_weight')],
        ['Temperature (K)', get(kv, '_diffrn_ambient_temperature')],
        ['Wavelength (\u00C5)', get(kv, '_diffrn_radiation_wavelength')],
        ['Crystal system; space group', `${get(kv, '_symmetry_cell_setting', get(kv, '_space_group_crystal_system'))} ; ${get(kv, '_symmetry_space_group_name_H-M', get(kv, '_space_group_name_H-M_alt'))}`],
        ['Unit cell (\u00C5, \u00B0)', `a = ${a}, b = ${b}, c = ${c}, \u03B1 = ${al}, \u03B2 = ${be}, \u03B3 = ${ga}`],
        ['Volume (\u00C5\u00B3)', get(kv, '_cell_volume')],
        ['Z; calculated density (g/cm\u00B3)', `${get(kv, '_cell_formula_units_Z')}; ${get(kv, '_exptl_crystal_density_diffrn')}`],
        ['Absorption coefficient (\u00B9/mm)', get(kv, '_exptl_absorpt_coefficient_mu')],
        ['F(000)', get(kv, '_exptl_crystal_F_000')],
        ['Theta range for data collection (\u00B0)', `${get(kv, '_diffrn_reflns_theta_min')} to ${get(kv, '_diffrn_reflns_theta_max')}`],
        ['Limiting indices', `${get(kv, '_diffrn_reflns_limit_h_min')} \u2264 h \u2264 ${get(kv, '_diffrn_reflns_limit_h_max')}, ${get(kv, '_diffrn_reflns_limit_k_min')} \u2264 k \u2264 ${get(kv, '_diffrn_reflns_limit_k_max')}, ${get(kv, '_diffrn_reflns_limit_l_min')} \u2264 l \u2264 ${get(kv, '_diffrn_reflns_limit_l_max')}`],
        ['Reflections collected / unique', `${get(kv, '_diffrn_reflns_number')} / ${get(kv, '_reflns_number_total')} [R(int) = ${get(kv, '_diffrn_reflns_av_R_equivalents')}]`],
        ['Completeness to theta max', pct(get(kv, '_diffrn_measured_fraction_theta_max'))],
        ['Refinement method', 'Full-matrix least-squares on F\u00B2'],
        ['Data / restraints / parameters', `${get(kv, '_refine_ls_number_reflns')} / ${get(kv, '_refine_ls_number_restraints')} / ${get(kv, '_refine_ls_number_parameters')}`],
        ['Goodness of fit on F\u00B2', get(kv, '_refine_ls_goodness_of_fit_ref')],
        ['Final R indices [I > 2\u03C3(I)]', `R1 = ${get(kv, '_refine_ls_R_factor_gt')}; wR2 = ${get(kv, '_refine_ls_wR_factor_gt')}`],
        ['Final R indices [all data]', `R1 = ${get(kv, '_refine_ls_R_factor_all')}; wR2 = ${get(kv, '_refine_ls_wR_factor_ref')}`],
        ['Largest diff. peak and hole (e/\u00C5\u00B3)', `${get(kv, '_refine_diff_density_max')} and ${get(kv, '_refine_diff_density_min')}`],
    ];
    children.push(keyValueTable(pairs));

    // ---- Table 2: Atomic coordinates (heavy atoms) ----
    if (atomLoop) {
        const h = atomLoop.headers;
        const idx = {
            label: h.indexOf('_atom_site_label'),
            sym: h.indexOf('_atom_site_type_symbol'),
            x: h.indexOf('_atom_site_fract_x'),
            y: h.indexOf('_atom_site_fract_y'),
            z: h.indexOf('_atom_site_fract_z'),
            u: h.indexOf('_atom_site_U_iso_or_equiv'),
            occ: h.indexOf('_atom_site_occupancy'),
        };
        const heavy = atomLoop.rows.filter(r => r[idx.sym] !== 'H');
        const hydro = atomLoop.rows.filter(r => r[idx.sym] === 'H');

        children.push(heading('Table 2. Fractional atomic coordinates and isotropic/equivalent displacement parameters'));
        children.push(para('x10\u2074 for x, y, z; x10\u00B3 for U(eq). U(eq) is one third of the trace of the orthogonalized Uij tensor.', { italics: true, size: 18 }));
        const widths = [18, 14, 22, 22, 22, 16, 10];
        const aligns = [AlignmentType.LEFT, AlignmentType.CENTER, AlignmentType.RIGHT, AlignmentType.RIGHT, AlignmentType.RIGHT, AlignmentType.RIGHT, AlignmentType.CENTER];
        const rows = [headerRow(['Atom', 'Site', 'x', 'y', 'z', 'U(eq)/Uiso', 'Occ.'], widths)];
        for (const r of heavy) {
            rows.push(dataRow([r[idx.label], r[idx.sym], r[idx.x], r[idx.y], r[idx.z], r[idx.u], r[idx.occ]], widths, aligns));
        }
        children.push(makeTable(rows, widths, aligns));

        // ---- Table 5: Hydrogen coordinates ----
        if (hydro.length) {
            children.push(heading('Table 3. Hydrogen atom coordinates'));
            const rowsH = [headerRow(['Atom', 'Site', 'x', 'y', 'z', 'Uiso', 'Occ.'], widths)];
            for (const r of hydro) {
                rowsH.push(dataRow([r[idx.label], r[idx.sym], r[idx.x], r[idx.y], r[idx.z], r[idx.u], r[idx.occ]], widths, aligns));
            }
            children.push(makeTable(rowsH, widths, aligns));
        }
    }

    // ---- Table: Bond lengths ----
    if (bondLoop) {
        const h = bondLoop.headers;
        const i1 = h.indexOf('_geom_bond_atom_site_label_1');
        const i2 = h.indexOf('_geom_bond_atom_site_label_2');
        const id = h.indexOf('_geom_bond_distance');
        const isym = h.indexOf('_geom_bond_site_symmetry_2');
        children.push(heading('Table 4. Bond lengths (\u00C5)'));
        const widths = [25, 25, 25, 25];
        const aligns = [AlignmentType.LEFT, AlignmentType.LEFT, AlignmentType.RIGHT, AlignmentType.CENTER];
        const rows = [headerRow(['Atom 1', 'Atom 2', 'Distance', 'Sym.'], widths)];
        for (const r of bondLoop.rows) {
            const sym = (isym >= 0 && r[isym] && r[isym] !== '.') ? r[isym] : '';
            rows.push(dataRow([r[i1], r[i2], r[id], sym], widths, aligns));
        }
        children.push(makeTable(rows, widths, aligns));
    }

    // ---- Table: Bond angles ----
    if (angleLoop) {
        const h = angleLoop.headers;
        const i1 = h.indexOf('_geom_angle_atom_site_label_1');
        const i2 = h.indexOf('_geom_angle_atom_site_label_2');
        const i3 = h.indexOf('_geom_angle_atom_site_label_3');
        const ia = h.indexOf('_geom_angle');
        children.push(heading('Table 5. Bond angles (\u00B0)'));
        const widths = [25, 25, 25, 25];
        const aligns = [AlignmentType.LEFT, AlignmentType.LEFT, AlignmentType.LEFT, AlignmentType.RIGHT];
        const rows = [headerRow(['Atom 1', 'Atom 2', 'Atom 3', 'Angle'], widths)];
        for (const r of angleLoop.rows) {
            rows.push(dataRow([r[i1], r[i2], r[i3], r[ia]], widths, aligns));
        }
        children.push(makeTable(rows, widths, aligns));
    }

    // ---- Table: Hydrogen bonds ----
    if (hbondLoop) {
        const h = hbondLoop.headers;
        const iD = h.indexOf('_geom_hbond_atom_site_label_D');
        const iH = h.indexOf('_geom_hbond_atom_site_label_H');
        const iA = h.indexOf('_geom_hbond_atom_site_label_A');
        const iDH = h.indexOf('_geom_hbond_distance_DH');
        const iHA = h.indexOf('_geom_hbond_distance_HA');
        const iDA = h.indexOf('_geom_hbond_distance_DA');
        const iAng = h.indexOf('_geom_hbond_angle_DHA');
        children.push(heading('Table 6. Hydrogen bonds (\u00C5, \u00B0)'));
        const widths = [14, 14, 14, 16, 16, 16, 16];
        const aligns = [AlignmentType.LEFT, AlignmentType.LEFT, AlignmentType.LEFT, AlignmentType.RIGHT, AlignmentType.RIGHT, AlignmentType.RIGHT, AlignmentType.RIGHT];
        const rows = [headerRow(['D', 'H', 'A', 'D\u2013H', 'H\u2026A', 'D\u2026A', 'D\u2013H\u2026A'], widths)];
        for (const r of hbondLoop.rows) {
            rows.push(dataRow([r[iD], r[iH], r[iA], r[iDH], r[iHA], r[iDA], r[iAng]], widths, aligns));
        }
        children.push(makeTable(rows, widths, aligns));
    }

    const doc = new Document({
        sections: [{
            properties: {
                page: {
                    size: { orientation: PageOrientation.PORTRAIT },
                    margin: { top: 720, bottom: 720, left: 720, right: 720 },
                },
            },
            children,
        }],
    });

    return Packer.toBuffer(doc);
}
