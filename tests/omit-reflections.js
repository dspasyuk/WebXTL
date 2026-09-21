import {
    parseMostDisagreeableReflections,
    omitInstructionsFromLst,
    mergeOmitInstructions,
    OMIT_ERROR_ESD_THRESHOLD
} from '../src/js/compute/omitReflections.js';

let failures = 0;
const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

check('threshold is 9', OMIT_ERROR_ESD_THRESHOLD, 9);

// Synthetic "Most Disagreeable Reflections" table (format as written by SHELXL).
const LST = [
    '  Some earlier log text',
    '  Recommended weighting scheme:  WGHT    0.0724    0.0000',
    '',
    ' Most Disagreeable Reflections (* if suppressed or used for Rfree).',
    ' Error/esd is calculated as sqrt(wD^2/<wD^2>) where w is given by the weight',
    ' formula, D = Fo^2-Fc^2 and <> refers to the average over all reflections.',
    '',
    '      h   k   l          Fo^2          Fc^2    Error/esd  Fc/Fc(max)  Resolution(A)',
    '',
    '      4   0   6       3827.76        668.06      11.20       0.051       2.97',
    '     -3   1   3       2075.68        391.66      10.37       0.039       4.70',
    '      3   1   3       2039.48        406.93      10.07       0.040       4.70',
    '      0   0  14        552.77         78.73       9.32       0.018       1.69 *',
    '      0   6   1        353.45         42.68       8.85       0.013       4.15',
    '',
    ' Bond lengths and angles'
].join('\n');

const parsed = parseMostDisagreeableReflections(LST);
check('rows parsed', parsed.length, 5);
check('first row', parsed[0], { h: 4, k: 0, l: 6, fo2: 3827.76, fc2: 668.06, errorEsd: 11.20, flagged: false });
check('negative indices', [parsed[1].h, parsed[1].k, parsed[1].l], [-3, 1, 3]);
check('star flagged row', parsed[3].flagged, true);

const { instructions } = omitInstructionsFromLst(LST);
check('instructions', instructions, ['OMIT 4 0 6', 'OMIT -3 1 3', 'OMIT 3 1 3', 'OMIT 0 0 14']);

// A table whose entries are all below the threshold yields nothing.
const clean = LST.replace(/1[01]\.\d\d/g, '5.00').replace('9.32', '4.50');
check('clean lst omits nothing', omitInstructionsFromLst(clean).instructions, []);

// Merging inserts after UNIT and is idempotent.
const res = [
    'TITL test',
    'CELL 0.71073 10 10 10 90 90 90',
    'LATT -1',
    'SFAC C',
    'UNIT 1',
    'C1 1 0.1 0.1 0.1 11 0.05',
    'HKLF 4',
    'END'
].join('\n');
const merged = mergeOmitInstructions(res, instructions);
check('merge changed', merged.changed, true);
check('merge inserted count', merged.inserted.length, 4);
const outLines = merged.text.split('\n');
check('omit right after UNIT', outLines.slice(0, 10), [
    'TITL test', 'CELL 0.71073 10 10 10 90 90 90', 'LATT -1', 'SFAC C', 'UNIT 1',
    'OMIT 4 0 6', 'OMIT -3 1 3', 'OMIT 3 1 3', 'OMIT 0 0 14',
    'C1 1 0.1 0.1 0.1 11 0.05'
]);
check('HKLF preserved', outLines[10], 'HKLF 4');
const again = mergeOmitInstructions(merged.text, instructions);
check('merge idempotent', again.changed, false);

// No UNIT -> fall back to just before HKLF.
const noUnit = mergeOmitInstructions('TITL t\nSFAC C\nC1 1 0 0 0 11 0.05\nHKLF 4\nEND', ['OMIT 4 0 6']);
check('fallback before HKLF', noUnit.text.split('\n')[3], 'OMIT 4 0 6');

// Existing hand-written OMIT lines are preserved, only new ones added.
const res2 = 'TITL t\nOMIT 4 0 6\nEND';
const merged2 = mergeOmitInstructions(res2, instructions);
check('merge skips existing', merged2.inserted, ['OMIT -3 1 3', 'OMIT 3 1 3', 'OMIT 0 0 14']);
check('merge keeps user line', merged2.text.split('\n')[1], 'OMIT 4 0 6');

// Scale-style OMIT (fewer than 3 indices) is not treated as a per-reflection omit.
const scaleOmit = mergeOmitInstructions('TITL t\nOMIT -3 50\nUNIT 1\nEND', ['OMIT 4 0 6']);
check('scale omit kept and new one added', scaleOmit.text.split('\n').slice(1, 4), ['OMIT -3 50', 'UNIT 1', 'OMIT 4 0 6']);

console.log(failures ? `\n${failures} failure(s)` : '\nall tests passed');
process.exit(failures ? 1 : 0);
