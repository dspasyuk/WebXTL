// Copyright (c) 2026 Denis Spasyuk. MIT License.
// Laue classes for xrdspace. The eleven centrosymmetric point groups are built
// from representative space groups in the space-groups.js dictionary, so we
// never hard-code a potentially inconsistent symmetry table.

import { opsToReciprocalMatrices } from './op-math.js';

// Representative space groups (id in the dictionary) for each Laue class.
// 2/m uses all three settings (unique b / c / a).
const LAUE_REPS = {
    '-1':   [2],        // P -1
    '2/m':  [10],       // P 1 2/m 1, P 1 1 2/m, P 2/m 1 1
    'mmm':  [47],       // P m m m
    '4/m':  [83],       // P 4/m
    '4/mmm': [123],     // P 4/m m m
    '-3':   [147],      // P -3 (hexagonal axes)
    '-3m':  [164],      // P -3 m 1 (hexagonal axes)
    '6/m':  [175],      // P 6/m
    '6/mmm': [191],     // P 6/m m m
    'm-3':  [200],      // P m -3
    'm-3m': [221],      // P m -3 m
};

export const LAUE_CRYSTAL_SYSTEM = {
    '-1': 'triclinic',
    '2/m': 'monoclinic',
    'mmm': 'orthorhombic',
    '4/m': 'tetragonal',
    '4/mmm': 'tetragonal',
    '-3': 'trigonal',
    '-3m': 'trigonal',
    '6/m': 'hexagonal',
    '6/mmm': 'hexagonal',
    'm-3': 'cubic',
    'm-3m': 'cubic',
};

// Laue classes compatible with each crystal system (from the unit-cell metric).
export const LAUE_BY_SYSTEM = {
    triclinic: ['-1'],
    monoclinic: ['2/m'],
    orthorhombic: ['mmm'],
    tetragonal: ['4/m', '4/mmm'],
    trigonal: ['-3', '-3m'],
    // Hexagonal axes can host either hexagonal or trigonal (hexagonal setting)
    // space groups, so both Laue classes are candidates.
    hexagonal: ['-3', '-3m', '6/m', '6/mmm'],
    cubic: ['m-3', 'm-3m'],
};

function matKey(m) {
    let out = '';
    for (let i = 0; i < 3; i++) {
        if (i) out += '|';
        for (let j = 0; j < 3; j++) {
            if (j) out += ',';
            out += Math.round(m[i][j] * 1e6) / 1e6;
        }
    }
    return out;
}

// Build the Laue groups from the dictionary data.
export function buildLaueGroups(sgData) {
    const groups = [];
    for (const [name, ids] of Object.entries(LAUE_REPS)) {
        const settings = [];
        for (const id of ids) {
            const rep = sgData.find(g => g.id === id);
            if (!rep) continue;
            const ops = opsToReciprocalMatrices(rep.s);
            settings.push({ name, id, hm: rep.hm, ops, order: ops.length });
        }
        if (!settings.length) continue;
        // Primary setting = the first (for 2/m it is the unique-b setting).
        const primary = settings[0];
        const opsSet = new Set();
        for (const o of primary.ops) opsSet.add(matKey(o.M));
        groups.push({
            name,
            crystalSystem: LAUE_CRYSTAL_SYSTEM[name],
            order: primary.order,
            settings,
            opsSet,
        });
    }
    return groups;
}

// Compute the Laue class of a space group from its symmetry operations.
// Returns a Laue group name or null.
export function sgLaueClass(sgOps, laueGroups) {
    const set = new Set();
    for (const { M } of opsToReciprocalMatrices(sgOps)) {
        set.add(matKey(M));
    }
    // Add the product with inversion to close the point group for
    // non-centrosymmetric space groups.
    const I = [[-1, 0, 0], [0, -1, 0], [0, 0, -1]];
    const invert = (m) => {
        const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
            out[i][j] = m[i][0] * I[0][j] + m[i][1] * I[1][j] + m[i][2] * I[2][j];
        }
        return out;
    };
    const keys = [...set];
    for (const key of keys) {
        const rows = key.split('|');
        const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let i = 0; i < 3; i++) {
            const cells = rows[i].split(',');
            for (let j = 0; j < 3; j++) m[i][j] = parseFloat(cells[j]);
        }
        set.add(matKey(invert(m)));
    }
    for (const lg of laueGroups) {
        if (lg.opsSet.size === set.size && [...set].every(k => lg.opsSet.has(k))) {
            return lg.name;
        }
    }
    return null;
}
