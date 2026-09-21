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
            const value = sp === -1 ? '' : line.slice(sp + 1).trim();

            if (value === ';') {
                // Multi-line ;-block starting on the next line.
                const buf = [];
                i++;
                while (i < lines.length && lines[i].trim() !== ';') { buf.push(lines[i]); i++; }
                i++; // skip closing ';'
                kv[key] = buf.join('\n').trim();
                continue;
            }

            if (value === '') {
                // CIF allows the value to sit on the following line; SHELX wraps
                // long items this way (e.g. _chemical_formula_sum).
                const nt = i + 1 < lines.length ? lines[i + 1].trim() : '';
                if (nt === ';') {
                    const buf = [];
                    i += 2; // skip key line and opening ';'
                    while (i < lines.length && lines[i].trim() !== ';') { buf.push(lines[i]); i++; }
                    i++; // skip closing ';'
                    kv[key] = buf.join('\n').trim();
                    continue;
                }
                if (nt && !nt.startsWith('_') && nt !== 'loop_' && !nt.startsWith('data_')) {
                    kv[key] = nt;
                    i += 2; // skip key line and value line
                    continue;
                }
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

// Deprecated (pre-2010) symmetry keys -> current space-group keys. Used both to
// upgrade the data block and to translate the publication form values, so the
// published CIF follows current CIF syntax.
const SG_RENAMES = [
    ['_symmetry_cell_setting', '_space_group_crystal_system'],
    ['_symmetry_space_group_name_Hall', '_space_group_name_Hall'],
    ['_symmetry_space_group_name_H-M', '_space_group_name_H-M_alt'],
];

// Rewrite a {key: value} map so legacy symmetry keys become the current
// space-group keys.
function normalizeValueKeys(values) {
    const out = {};
    for (const [k, v] of Object.entries(values || {})) {
        let key = k;
        for (const [from, to] of SG_RENAMES) {
            if (key === from) { key = to; break; }
        }
        out[key] = v;
    }
    return out;
}

// Extract the main data block, keeping the embedded .res, .hkl and .fab files
// that SHELXL stores in _shelx_res_file / _shelx_hkl_file / _shelx_fab_file
// (their checksums depend on the exact bytes, so those text fields are copied
// verbatim). Space-group keys are upgraded to current syntax; blank runs are
// collapsed and PLATON-squeeze keys are dropped outside of text fields only.
export function extractMainBlock(cifText) {
    const lines = cifText.split(/\r?\n/);

    // Start of the data block.
    let start = lines.findIndex(l => l.trim().startsWith('data_'));
    if (start === -1) start = 0;

    // End just after the last embedded-file checksum, so the structure model,
    // structure factors and the .fab mask (all required by validation) are kept.
    // The .fab text field itself contains the source PLATON/SQUEEZE comments, but
    // those are inside a ;-block and therefore copied verbatim, not parsed.
    let end = -1;
    for (let n = start + 1; n < lines.length; n++) {
        if (/^_(shelx_)?(hkl|res|fab)_checksum\b/i.test(lines[n].trim())) end = n + 1;
    }
    if (end === -1) {
        // No embedded files: end at the next top-level data block or EOF.
        end = lines.length;
        let inText = false;
        for (let n = start + 1; n < lines.length; n++) {
            const t = lines[n].trim();
            if (lines[n].startsWith(';')) { inText = !inText; continue; }
            if (!inText && t.startsWith('data_')) { end = n; break; }
        }
    }

    const block = lines.slice(start, end);

    const cleaned = [];
    let inText = false;
    let blank = 0;
    for (const line of block) {
        const t = line.trim();

        // Toggle ;-delimited text fields (multi-line values, embedded files).
        if (line.startsWith(';')) {
            inText = !inText;
            blank = 0;
            cleaned.push(line);
            continue;
        }
        if (inText) { cleaned.push(line); continue; }

        if (t.toLowerCase().includes('_platon_squeeze')) continue;

        let out = line;
        for (const [from, to] of SG_RENAMES) {
            if (t.startsWith(from)) { out = line.replace(from, to); break; }
        }

        if (out.trim() === '') {
            blank++;
            if (blank <= 1) cleaned.push(out);
        } else {
            blank = 0;
            cleaned.push(out);
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
// - Missing keys: inserted next to others of the same CIF category (e.g. a new
//   _diffrn_radiation_source goes after the last existing _diffrn_* key), so
//   template values do not pile up at the end of the file. Keys with no anchor
//   in the block are appended.
export function applyValuesToBlock(block, values) {
    const out = [];
    const consumed = new Set();
    let inText = false;
    let i = 0;
    while (i < block.length) {
        const line = block[i];
        const t = line.trim();

        // Copy ;-delimited text fields (e.g. embedded .res/.hkl) verbatim so
        // their checksums stay valid; never treat their content as CIF keys.
        if (line.startsWith(';')) {
            inText = !inText;
            out.push(line);
            i++;
            continue;
        }
        if (inText) { out.push(line); i++; continue; }

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

    // Insert the remaining values next to their CIF category siblings.
    const groups = new Map();
    for (const [k, v] of Object.entries(values)) {
        if (consumed.has(k)) continue;
        const m = /^_([^_]+)/.exec(k);
        const category = m ? m[1] : '';
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push([k, v]);
    }
    for (const [category, entries] of groups) {
        const newLines = entries.map(([k, v]) => formatKeyValue(k, v));
        const idx = category ? lastKeyIndexOutsideText(out, category) : -1;
        if (idx === -1) out.push(...newLines);
        else out.splice(idx + 1, 0, ...newLines);
    }
    return out;
}

// Index of the last line outside a ;-text field whose key belongs to `category`
// (e.g. category 'diffrn' matches _diffrn_*), or -1 if none. Prevents new values
// from being inserted inside an embedded .res/.hkl/.fab text field.
function lastKeyIndexOutsideText(lines, category) {
    const re = new RegExp('^_' + escapeRegExp(category) + '(_|$)');
    let inText = false;
    let idx = -1;
    for (let n = 0; n < lines.length; n++) {
        const line = lines[n];
        if (line.startsWith(';')) { inText = !inText; continue; }
        if (!inText && re.test(line.trim())) idx = n;
    }
    return idx;
}

function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Append a user-supplied PLATON SQUEEZE fragment (the _platon_squeeze_details
// text field and/or the void loop) verbatim at the end of the data block. It is
// kept as pasted so it stays valid CIF; only outer whitespace is trimmed.
function appendPlatonSqueeze(fragment) {
    const text = String(fragment || '').replace(/^\s+|\s+$/g, '');
    if (!text) return '';
    return '\n' + text + '\n';
}

// Extract a checkCIF alert code ("PLAT420") from an alert line such as
// "PLAT420_ALERT_2_B D-H Bond Without Acceptor ...". Falls back to the first
// all-caps token (e.g. "RINTA01").
function vrfAlertCode(alert) {
    const s = String(alert || '');
    const m = s.match(/\b([A-Z][A-Z0-9]*)_ALERT/);
    if (m) return m[1];
    const token = s.trim().split(/\s+/)[0] || '';
    return /^[A-Z][A-Z0-9]*$/.test(token) ? token : 'ALERT';
}

// Word-wrap free text to a maximum line length. Existing line breaks are kept;
// long words are hard-split. CIF readers are happiest with lines <= 80 chars.
function wrapText(text, width = 80) {
    const out = [];
    for (const raw of String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')) {
        const line = raw.replace(/\s+$/, '');
        if (line.length <= width) { out.push(line); continue; }
        let current = '';
        for (const word of line.split(/\s+/)) {
            let w = word;
            while (w.length > width) {
                if (current) { out.push(current); current = ''; }
                out.push(w.slice(0, width));
                w = w.slice(width);
            }
            if (!current) current = w;
            else if (current.length + 1 + w.length <= width) current += ' ' + w;
            else { out.push(current); current = w; }
        }
        out.push(current);
    }
    return out;
}

// Build a "Validation Reply Form" (VRF) block from {alert, response} pairs.
// Format used by checkCIF/publCIF:
//   _vrf_<alertcode>_<dataname>
//   ;
//   PROBLEM: <alert line>
//   RESPONSE: <explanation>
//   ;
// PROBLEM/RESPONSE text is wrapped at 80 characters so no CIF line is too long.
// Returned as lines ready to splice into the structure data block.
function buildVrfLines(replies, dataName) {
    const items = (replies || []).filter(r => r && (String(r.alert || '').trim() || String(r.response || '').trim()));
    if (!items.length) return [];
    const suffix = String(dataName || 'structure').replace(/[^A-Za-z0-9_]/g, '_') || 'structure';
    const lines = ['# start Validation Reply Form'];
    const used = new Set();
    items.forEach((r) => {
        const alert = String(r.alert || '').trim();
        const response = String(r.response || '').trim();
        let name = `_vrf_${vrfAlertCode(alert)}_${suffix}`;
        let n = 2;
        while (used.has(name)) { name = `_vrf_${vrfAlertCode(alert)}_${suffix}_${n++}`; }
        used.add(name);
        lines.push(name);
        lines.push(';');
        lines.push(...wrapText(`PROBLEM: ${alert}`));
        lines.push(...wrapText(`RESPONSE: ${response}`));
        lines.push(';');
    });
    lines.push('# end Validation Reply Form');
    return lines;
}

// Data name of the structure block (first "data_..." line).
function blockDataName(block) {
    const line = (block || []).find(l => l.trim().startsWith('data_'));
    return line ? line.trim().slice(5).trim() : '';
}

// Insert the VRF immediately after the structure block's data_ identifier.
function withVrf(block, replies) {
    const lines = buildVrfLines(replies, blockDataName(block));
    if (!lines.length) return block;
    const at = block.findIndex(l => l.trim().startsWith('data_'));
    const pos = at === -1 ? 0 : at + 1;
    return [...block.slice(0, pos), ...lines, ...block.slice(pos)];
}

// Build a publish CIF from templates (mirrors the Python "Prepare cif for publication"):
//   publish.cif = user template (data_global) + main block with device values applied.
// options: { userTemplate, deviceValues, extraValues, platonSqueeze, alertReplies }
// extraValues come from the manual form and are auto-quoted via checkValue().
export function buildPublishCifFromTemplates(cifText, options = {}) {
    const mainBlock = extractMainBlock(cifText);
    const deviceValues = options.deviceValues || {};
    const extraValues = {};
    for (const [k, v] of Object.entries(options.extraValues || {})) {
        if (v === undefined || v === null || String(v).trim() === '') continue;
        extraValues[k] = checkValue(v);
    }
    const values = normalizeValueKeys({ ...deviceValues, ...extraValues });
    let updatedBlock = applyValuesToBlock(mainBlock, values);
    updatedBlock = withVrf(updatedBlock, options.alertReplies);

    let out = '';
    if (options.userTemplate) {
        out += options.userTemplate.replace(/\s+$/, '') + '\n\n';
    }
    out += updatedBlock.join('\n') + '\n';
    out += appendPlatonSqueeze(options.platonSqueeze);
    return out;
}

// Build a clean, publication-ready CIF from a SHELXL .cif (manual mode, no templates).
// options: { includeGlobal: bool, global: {...}, platonSqueeze: string, alertReplies: [{alert, response}] }
export function buildPublishCif(cifText, options = {}) {
    let cleaned = extractMainBlock(cifText);
    cleaned = withVrf(cleaned, options.alertReplies);

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
    out += appendPlatonSqueeze(options.platonSqueeze);
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

// Strip one layer of CIF quoting from a scalar value.
function unquote(v) {
    let s = String(v == null ? '' : v).trim();
    if (s.length >= 2) {
        const a = s[0], b = s[s.length - 1];
        if ((a === "'" && b === "'") || (a === '"' && b === '"')) s = s.slice(1, -1).trim();
    }
    return s;
}

function get(kv, key, fallback = '?') {
    const v = kv[key];
    if (v === undefined || v === '' || v === '?') return fallback;
    return unquote(v);
}

// First non-empty, non-'?' value among the given keys (unquoted).
function firstOf(kv, keys, fallback = '?') {
    for (const k of keys) {
        const v = get(kv, k, '');
        if (v) return v;
    }
    return fallback;
}

function pct(v) {
    const n = parseFloat(v);
    if (isNaN(n)) return '?';
    return (n * 100).toFixed(1) + ' %';
}

// Table 1 rows (label/value) of the crystallographic report, taken from the
// parsed CIF key/values. Exported so the mapping can be unit-tested.
export function crystalDataPairs(kv, dataName) {
    const a = get(kv, '_cell_length_a'), b = get(kv, '_cell_length_b'), c = get(kv, '_cell_length_c');
    const al = get(kv, '_cell_angle_alpha'), be = get(kv, '_cell_angle_beta'), ga = get(kv, '_cell_angle_gamma');
    return [
        ['Identification code', get(kv, '_chemical_name_common', dataName)],
        ['Chemical formula', firstOf(kv, ['_chemical_formula_sum', '_chemical_formula_moiety'])],
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
    children.push(keyValueTable(crystalDataPairs(kv, dataName)));

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
