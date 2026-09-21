import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    extractMainBlock,
    buildPublishCifFromTemplates,
    buildPublishCif,
    applyValuesToBlock,
    checkValue,
    parseCif,
    crystalDataPairs
} from '../publish.js';

let failures = 0;
const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

const RES_BLOCK = [
    'TITL test',
    'CELL 1 2 3 90 90 90',
    '',
    'C1 1 0.1 0.2 0.3 11 0.05',
].join('\n');

const HKL_BLOCK = [
    '   1   0   0   10.0   2.0',
    '   0   1   0    5.0   1.0',
].join('\n');

const CIF = [
    'data_test',
    '_chemical_formula_sum            \'C2 H6\'',
    '_symmetry_cell_setting           orthorhombic',
    '_symmetry_space_group_name_H-M   \'P 2 2 21\'',
    '_space_group_IT_number           17',
    '_refine_diff_density_rms         0.01',
    '_shelx_res_file',
    ';',
    RES_BLOCK,
    ';',
    '_shelx_res_checksum   123',
    '_shelx_hkl_file',
    ';',
    HKL_BLOCK,
    ';',
    '_shelx_hkl_checksum   456',
    '# SQUEEZE RESULTS (Version = 151020)',
    'loop_',
    '  _platon_missing_refln_index_h',
    '    0    1    0     0.804',
    '_platon_squeeze_void_probe_radius   1.20',
    '',
    'data_second',
    '_some_key  1',
].join('\n');

// --- extractMainBlock: keeps embedded .res/.hkl, upgrades SG keys, drops PLATON.
const block = extractMainBlock(CIF);
const txt = block.join('\n');
check('starts at data block', block[0], 'data_test');
check('keeps _shelx_res_file', txt.includes('_shelx_res_file'), true);
check('keeps _shelx_hkl_file', txt.includes('_shelx_hkl_file'), true);
check('ends after hkl checksum', block[block.length - 1], '_shelx_hkl_checksum   456');
check('drops platon', /_platon/i.test(txt), false);
check('drops second data block', txt.includes('data_second'), false);
check('upgrades cell setting', txt.includes('_space_group_crystal_system'), true);
check('upgrades H-M', txt.includes('_space_group_name_H-M_alt'), true);
check('no legacy symmetry keys', /_symmetry_/.test(txt), false);

// Embedded .res must be byte-identical (checksums depend on it).
const resIn = CIF.slice(CIF.indexOf('_shelx_res_file'), CIF.indexOf('_shelx_res_checksum'));
const resOut = txt.slice(txt.indexOf('_shelx_res_file'), txt.indexOf('_shelx_res_checksum'));
check('res block identical', resOut, resIn);
const hklIn = CIF.slice(CIF.indexOf('_shelx_hkl_file'), CIF.indexOf('_shelx_hkl_checksum'));
const hklOut = txt.slice(txt.indexOf('_shelx_hkl_file'), txt.indexOf('_shelx_hkl_checksum'));
check('hkl block identical', hklOut, hklIn);

// --- buildPublishCifFromTemplates: form values applied with modern keys.
const out = buildPublishCifFromTemplates(CIF, {
    userTemplate: 'data_global\n_publ_section_title\n;\nTest\n;',
    extraValues: {
        '_symmetry_cell_setting': 'orthorhombic',
        '_symmetry_space_group_name_H-M': 'P n a 21',
        '_cell_measurement_reflns_used': '12345',
        '_cell_measurement_theta_min': '2.50',
        '_cell_measurement_theta_max': '28.40',
        '_chemical_absolute_configuration': 'ad',
    },
});
check('template block prepended', out.startsWith('data_global'), true);
check('has res', out.includes('_shelx_res_file'), true);
check('has hkl', out.includes('_shelx_hkl_file'), true);
check('no legacy keys in output', /_symmetry_/.test(out), false);
const lineValue = (text, key) => {
    const line = text.split('\n').find(l => l.trim().startsWith(key));
    return line ? line.trim().slice(key.length).trim() : null;
};
check('cell setting written modern', lineValue(out, '_space_group_crystal_system'), "'orthorhombic'");
check('H-M written modern', lineValue(out, '_space_group_name_H-M_alt'), "'P n a 21'");
check('reflns used written', lineValue(out, '_cell_measurement_reflns_used'), '12345');
check('theta min written', lineValue(out, '_cell_measurement_theta_min'), '2.50');
check('theta max written', lineValue(out, '_cell_measurement_theta_max'), '28.40');
check('absolute config written', lineValue(out, '_chemical_absolute_configuration'), "'ad'");

// --- Manual mode also keeps the embedded files.
const manual = buildPublishCif(CIF, { includeGlobal: false });
check('manual keeps res', manual.includes('_shelx_res_file'), true);

// --- No embedded checksums: end at the next data block.
const plain = ['data_a', '_cell_length_a   1.0', '', '', 'data_b', '_cell_length_a   2.0'].join('\n');
const plainBlock = extractMainBlock(plain);
check('plain ends before second block', plainBlock, ['data_a', '_cell_length_a   1.0']);

// --- checkValue quoting.
check('checkValue numeric', checkValue('1.5'), '1.5');
check('checkValue text', checkValue('P n a 21'), "'P n a 21'");
check('checkValue unknown', checkValue('?'), '?');

// --- applyValuesToBlock does not touch embedded text fields.
const withVal = applyValuesToBlock(block, { '_chemical_formula_sum': "'C2 H6'" });
check('apply keeps res', withVal.join('\n').slice(withVal.join('\n').indexOf('_shelx_res_file'), withVal.join('\n').indexOf('_shelx_res_checksum')), resIn);

// --- Missing keys are inserted next to their CIF category, not at the end.
const SECTION_CIF = [
    'data_test',
    '_cell_length_a   10.0',
    '_cell_volume     1000.0',
    '_diffrn_ambient_temperature   100',
    '_diffrn_radiation_wavelength  0.71073',
    '_exptl_crystal_colour         red',
    '_shelx_res_file',
    ';',
    'TITL t',
    '_diffrn_radiation_monochromator   fake-in-text',
    ';',
    '_shelx_res_checksum   1',
    '_shelx_hkl_file',
    ';',
    '   1   0   0   10.0   2.0',
    ';',
    '_shelx_hkl_checksum   2',
    '_shelx_fab_file',
    ';',
    '    0    2    0    183.90',
    ';',
    '_shelx_fab_checksum   3',
].join('\n');
const sectionBlock = applyValuesToBlock(extractMainBlock(SECTION_CIF), {
    '_diffrn_radiation_source': 'sealed tube',
    '_diffrn_radiation_monochromator': 'graphite',
    '_new_category_key': 'x',
});
const sbTxt = sectionBlock.join('\n');
check('template diffrn source inserted', sbTxt.includes('_diffrn_radiation_source'), true);
check('no diffrn values at end', sectionBlock.slice(-3).some(l => /_diffrn_/.test(l)), false);
const sIdx = sectionBlock.findIndex(l => l.trim().startsWith('_diffrn_radiation_wavelength'));
check('diffrn source after last diffrn key', sectionBlock[sIdx + 1].trim().startsWith('_diffrn_radiation_source'), true);
check('monochromator right after source', sectionBlock[sIdx + 2].trim().startsWith('_diffrn_radiation_monochromator'), true);
check('exptl key still after diffrn', sectionBlock[sIdx + 3].trim().startsWith('_exptl_crystal_colour'), true);
check('unknown category appended at end', sectionBlock[sectionBlock.length - 1].trim().startsWith('_new_category_key'), true);
const resStart = sectionBlock.findIndex(l => l.trim().startsWith('_shelx_res_file'));
const monoIdx = sectionBlock.findIndex(l => /^_diffrn_radiation_monochromator\s+graphite/.test(l.trim()));
check('monochromator not inserted inside text field', monoIdx !== -1 && monoIdx < resStart, true);
check('in-text monochromator untouched', sectionBlock.some(l => l.includes('fake-in-text')), true);
check('fab file retained', extractMainBlock(SECTION_CIF).some(l => l.trim().startsWith('_shelx_fab_file')), true);
check('fab checksum retained', extractMainBlock(SECTION_CIF).some(l => l.trim().startsWith('_shelx_fab_checksum')), true);

// --- PLATON SQUEEZE details fragment appended verbatim.
const SQ = [
    '_platon_squeeze_details',
    ';',
    'The SQUEEZE procedure was applied to treat regions of highly disordered solvent.',
    ';',
    '',
    'loop_',
    '  _platon_squeeze_void_nr',
    '   1 -0.000  0.155  0.250        25         1 \'?\'',
    '_platon_squeeze_void_probe_radius                  1.20',
].join('\n');
const outSq = buildPublishCifFromTemplates(CIF, { platonSqueeze: SQ });
check('squeeze appended at end', outSq.trimEnd().endsWith('_platon_squeeze_void_probe_radius                  1.20'), true);
check('squeeze appears once', outSq.split('_platon_squeeze_details').length - 1, 1);
check('squeeze description kept', outSq.includes('highly disordered solvent'), true);
check('no squeeze when blank', buildPublishCifFromTemplates(CIF, { platonSqueeze: '   ' }).includes('_platon_squeeze'), false);
check('manual mode squeeze', buildPublishCif(CIF, { includeGlobal: false, platonSqueeze: SQ }).includes('_platon_squeeze_void_probe_radius'), true);

// --- CheckCIF alert explanations -> Validation Reply Form.
const vrf = buildPublishCifFromTemplates(CIF, {
    alertReplies: [
        { alert: 'PLAT420_ALERT_2_B D-H Bond Without Acceptor  O6       --H6       .     Please Check', response: 'The H atom was placed geometrically; no acceptor is available.' },
        { alert: 'PLAT420_ALERT_2_B Another one', response: 'Second reply.' },
        { alert: 'PLAT029_ALERT_3_B low completeness', response: 'Limited by the experiment.' },
    ],
});
check('vrf markers present', vrf.includes('# start Validation Reply Form') && vrf.includes('# end Validation Reply Form'), true);
check('vrf first entry name', vrf.includes('_vrf_PLAT420_test'), true);
check('vrf duplicate code disambiguated', vrf.includes('_vrf_PLAT420_test_2'), true);
check('vrf second code', vrf.includes('_vrf_PLAT029_test'), true);
check('vrf problem line', vrf.includes('PROBLEM: PLAT420_ALERT_2_B D-H Bond Without Acceptor'), true);
check('vrf response line', vrf.includes('RESPONSE: The H atom was placed geometrically'), true);

const vrfLines = vrf.split('\n');
const dataIdx = vrfLines.findIndex(l => l.trim() === 'data_test');
check('vrf right after data block', vrfLines[dataIdx + 1], '# start Validation Reply Form');

check('no vrf when empty', buildPublishCifFromTemplates(CIF, { alertReplies: [{ alert: '', response: '' }] }).includes('_vrf_'), false);
check('manual mode vrf', buildPublishCif(CIF, { includeGlobal: false, alertReplies: [{ alert: 'PLAT001_ALERT_1_A x', response: 'y' }] }).includes('_vrf_PLAT001_'), true);

// --- VRF lines must be wrapped to <= 80 characters.
const longAlert = 'PLAT420_ALERT_2_B D-H Bond Without Acceptor  O6       --H6       .     Please Check';
const longResponse = 'The proton H6 was located in the difference map and refined with a riding model; '
    + 'the closest potential acceptor lies at 3.21 A, which is longer than the sum of the van der Waals '
    + 'radii, so no hydrogen bond is present in this structure.';
const wrapped = buildPublishCifFromTemplates(CIF, {
    alertReplies: [{ alert: longAlert, response: longResponse }],
}).split('\n');
const vStart = wrapped.findIndex(l => l.includes('# start Validation Reply Form'));
const vEnd = wrapped.findIndex(l => l.includes('# end Validation Reply Form'));
const wrappedVrf = wrapped.slice(vStart, vEnd + 1);
const tooLong = wrappedVrf.filter(l => l.length > 80);
check('all vrf lines <= 80 chars', tooLong, []);
check('wrapped response keeps text', wrappedVrf.join(' ').includes('closest potential acceptor lies at 3.21 A'), true);
check('wrapped problem starts with prefix', wrappedVrf.some(l => l.startsWith('PROBLEM: PLAT420_ALERT_2_B')), true);

// --- parseCif: value on the following line (as SHELX writes
// _chemical_formula_sum) and bare-key ;-blocks.
const NL_CIF = [
    'data_nl',
    '_chemical_formula_moiety          ?',
    '_chemical_formula_sum',
    " 'C17 H27 Br2 N Ni O2 P' ",
    '_chemical_formula_weight          526.89',
    '_publ_section_title',
    ';',
    'Title line',
    ';',
    '_cell_length_a   10.0',
].join('\n');
const parsedNl = parseCif(NL_CIF);
check('next-line value parsed', parsedNl.kv['_chemical_formula_sum'], "'C17 H27 Br2 N Ni O2 P'");
check('next-line formula in report data', crystalDataPairs(parsedNl.kv, parsedNl.dataName).find(p => p[0] === 'Chemical formula')[1], 'C17 H27 Br2 N Ni O2 P');
check('bare-key text block parsed', parsedNl.kv['_publ_section_title'], 'Title line');
check('next key still parsed', parsedNl.kv['_cell_length_a'], '10.0');

// Real SHELX CIFs wrap the formula onto the next line; the report must show it.
const here = path.dirname(fileURLToPath(import.meta.url));
const realCif = fs.readFileSync(path.join(here, '../projects/example/example.cif'), 'utf8');
const realParsed = parseCif(realCif);
const realFormula = crystalDataPairs(realParsed.kv, realParsed.dataName).find(p => p[0] === 'Chemical formula')[1];
check('example.cif formula present', realFormula, 'C17 H27 Br2 N Ni O2 P');

console.log(failures ? `\n${failures} failure(s)` : '\nall tests passed');
process.exit(failures ? 1 : 0);
