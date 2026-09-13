export const FRAGMENTS = {
  phenyl: {
    name: 'Phenyl',
    formula: 'C6',
    description: 'Aromatic 6-membered carbon ring (SHELX AFIX 66 rigid hexagon)',
    afix: 66,
    atoms: [
      { label: 'C1', element: 'C', x: 1.395, y: 0.000, z: 0.000 },
      { label: 'C2', element: 'C', x: 0.698, y: 1.208, z: 0.000 },
      { label: 'C3', element: 'C', x: -0.698, y: 1.208, z: 0.000 },
      { label: 'C4', element: 'C', x: -1.395, y: 0.000, z: 0.000 },
      { label: 'C5', element: 'C', x: -0.698, y: -1.208, z: 0.000 },
      { label: 'C6', element: 'C', x: 0.698, y: -1.208, z: 0.000 },
    ]
  },
  pyridine: {
    name: 'Pyridine',
    formula: 'C5N',
    description: '6-membered aromatic ring with N (SHELX AFIX 66 rigid hexagon)',
    afix: 66,
    atoms: [
      { label: 'C1', element: 'C', x: 1.395, y: 0.000, z: 0.000 },
      { label: 'C2', element: 'C', x: 0.698, y: 1.208, z: 0.000 },
      { label: 'C3', element: 'C', x: -0.698, y: 1.208, z: 0.000 },
      { label: 'C4', element: 'C', x: -1.395, y: 0.000, z: 0.000 },
      { label: 'C5', element: 'C', x: -0.698, y: -1.208, z: 0.000 },
      { label: 'N1', element: 'N', x: 0.698, y: -1.208, z: 0.000 },
    ]
  },
  cp: {
    name: 'Cp (cyclopentadienyl)',
    formula: 'C5',
    description: 'Cyclopentadienyl ring (SHELX AFIX 56 rigid pentagon)',
    afix: 56,
    atoms: [
      { label: 'C1', element: 'C', x: 0.0000, y: 1.2079, z: 0.000 },
      { label: 'C2', element: 'C', x: -1.1488, y: 0.3733, z: 0.000 },
      { label: 'C3', element: 'C', x: -0.7100, y: -0.9772, z: 0.000 },
      { label: 'C4', element: 'C', x: 0.7100, y: -0.9772, z: 0.000 },
      { label: 'C5', element: 'C', x: 1.1488, y: 0.3733, z: 0.000 },
    ]
  },
  cpstar: {
    name: 'Cp* (pentamethylcyclopentadienyl)',
    formula: 'C10',
    description: 'Pentamethylcyclopentadienyl (SHELX AFIX 106; 5 ring C then 5 CH3 C)',
    afix: 106,
    atoms: [
      { label: 'C1', element: 'C', x: 0.0000, y: 1.2079, z: 0.000 },
      { label: 'C2', element: 'C', x: -1.1488, y: 0.3733, z: 0.000 },
      { label: 'C3', element: 'C', x: -0.7100, y: -0.9772, z: 0.000 },
      { label: 'C4', element: 'C', x: 0.7100, y: -0.9772, z: 0.000 },
      { label: 'C5', element: 'C', x: 1.1488, y: 0.3733, z: 0.000 },
      { label: 'C6', element: 'C', x: 0.0000, y: 2.7174, z: 0.000 },
      { label: 'C7', element: 'C', x: -2.5846, y: 0.8398, z: 0.000 },
      { label: 'C8', element: 'C', x: -1.5973, y: -2.1985, z: 0.000 },
      { label: 'C9', element: 'C', x: 1.5973, y: -2.1985, z: 0.000 },
      { label: 'C10', element: 'C', x: 2.5846, y: 0.8398, z: 0.000 },
    ]
  },
  naphthalene: {
    name: 'Naphthalene',
    formula: 'C10',
    description: 'Fused bicyclic aromatic (SHELX AFIX 116, figure-of-eight order)',
    afix: 116,
    atoms: [
      { label: 'C1', element: 'C', x: -1.2038, y: 1.3900, z: 0.000 },
      { label: 'C2', element: 'C', x: -2.4077, y: 0.6950, z: 0.000 },
      { label: 'C3', element: 'C', x: -2.4077, y: -0.6950, z: 0.000 },
      { label: 'C4', element: 'C', x: -1.2038, y: -1.3900, z: 0.000 },
      { label: 'C5', element: 'C', x: 0.0000, y: -0.6950, z: 0.000 },
      { label: 'C6', element: 'C', x: 0.0000, y: 0.6950, z: 0.000 },
      { label: 'C7', element: 'C', x: 1.2038, y: 1.3900, z: 0.000 },
      { label: 'C8', element: 'C', x: 2.4077, y: 0.6950, z: 0.000 },
      { label: 'C9', element: 'C', x: 2.4077, y: -0.6950, z: 0.000 },
      { label: 'C10', element: 'C', x: 1.2038, y: -1.3900, z: 0.000 },
    ]
  },
  methyl: {
    name: 'Methyl',
    formula: 'CH3',
    description: 'Methyl carbon (SADI; add hydrogens with HFIX later)',
    atoms: [
      { label: 'C1', element: 'C', x: 0.000, y: 0.000, z: 0.000 },
    ]
  },
  ethyl: {
    name: 'Ethyl',
    formula: 'C2H5',
    description: 'Ethyl skeleton (SADI C-C)',
    atoms: [
      { label: 'C1', element: 'C', x: 0.000, y: 0.000, z: 0.000 },
      { label: 'C2', element: 'C', x: 1.530, y: 0.000, z: 0.000 },
    ]
  },
  iPr: {
    name: 'iPr (isopropyl)',
    formula: 'C3H7',
    description: 'Isopropyl skeleton (SADI; methyl...methyl not restrained)',
    skipMethylMethyl: true,
    atoms: [
      { label: 'C1', element: 'C', x: 0.000, y: 0.000, z: 0.000 },
      { label: 'C2', element: 'C', x: 0.883, y: 0.883, z: 0.883 },
      { label: 'C3', element: 'C', x: 0.883, y: -0.883, z: -0.883 },
    ]
  },
  tBu: {
    name: 'tBu (tert-butyl)',
    formula: 'C4H9',
    description: 'tert-Butyl skeleton (SADI)',
    atoms: [
      { label: 'C1', element: 'C', x: 0.000, y: 0.000, z: 0.000 },
      { label: 'C2', element: 'C', x: 0.883, y: 0.883, z: 0.883 },
      { label: 'C3', element: 'C', x: 0.883, y: -0.883, z: -0.883 },
      { label: 'C4', element: 'C', x: -0.883, y: 0.883, z: -0.883 },
    ]
  },
  cyclopropane: {
    name: 'Cyclopropane',
    formula: 'C3',
    description: '3-membered ring (SADI)',
    atoms: [
      { label: 'C1', element: 'C', x: 0.0000, y: 0.8718, z: 0.000 },
      { label: 'C2', element: 'C', x: -0.7552, y: -0.4359, z: 0.000 },
      { label: 'C3', element: 'C', x: 0.7552, y: -0.4359, z: 0.000 },
    ]
  },
  cyclobutane: {
    name: 'Cyclobutane',
    formula: 'C4',
    description: '4-membered ring (SADI)',
    atoms: [
      { label: 'C1', element: 'C', x: 0.7750, y: 0.7750, z: 0.000 },
      { label: 'C2', element: 'C', x: -0.7750, y: 0.7750, z: 0.000 },
      { label: 'C3', element: 'C', x: -0.7750, y: -0.7750, z: 0.000 },
      { label: 'C4', element: 'C', x: 0.7750, y: -0.7750, z: 0.000 },
    ]
  },
  cyclopentane: {
    name: 'Cyclopentane',
    formula: 'C5',
    description: '5-membered saturated ring (SADI)',
    atoms: [
      { label: 'C1', element: 'C', x: 0.0000, y: 1.3093, z: 0.000 },
      { label: 'C2', element: 'C', x: -1.2453, y: 0.4046, z: 0.000 },
      { label: 'C3', element: 'C', x: -0.7695, y: -1.0591, z: 0.000 },
      { label: 'C4', element: 'C', x: 0.7695, y: -1.0591, z: 0.000 },
      { label: 'C5', element: 'C', x: 1.2453, y: 0.4046, z: 0.000 },
    ]
  },
  cyclohexane: {
    name: 'Cyclohexane',
    formula: 'C6',
    description: '6-membered saturated ring, chair (SADI)',
    atoms: [
      { label: 'C1', element: 'C', x: 0.0000, y: 1.4565, z: 0.2500 },
      { label: 'C2', element: 'C', x: 1.2613, y: 0.7283, z: -0.2500 },
      { label: 'C3', element: 'C', x: 1.2613, y: -0.7283, z: 0.2500 },
      { label: 'C4', element: 'C', x: 0.0000, y: -1.4565, z: -0.2500 },
      { label: 'C5', element: 'C', x: -1.2613, y: -0.7283, z: 0.2500 },
      { label: 'C6', element: 'C', x: -1.2613, y: 0.7283, z: -0.2500 },
    ]
  },
  dcm: {
    name: 'DCM (dichloromethane)',
    formula: 'CH2Cl2',
    description: 'Dichloromethane skeleton (SADI)',
    atoms: [
      { label: 'C1', element: 'C', x: 0.000, y: 0.000, z: 0.000 },
      { label: 'Cl1', element: 'Cl', x: 1.022, y: 1.022, z: 1.022 },
      { label: 'Cl2', element: 'Cl', x: 1.022, y: -1.022, z: -1.022 },
    ]
  },
  chloroform: {
    name: 'Chloroform',
    formula: 'CHCl3',
    description: 'Chloroform skeleton (SADI)',
    atoms: [
      { label: 'C1', element: 'C', x: 0.000, y: 0.000, z: 0.000 },
      { label: 'Cl1', element: 'Cl', x: 1.022, y: 1.022, z: 1.022 },
      { label: 'Cl2', element: 'Cl', x: 1.022, y: -1.022, z: -1.022 },
      { label: 'Cl3', element: 'Cl', x: -1.022, y: 1.022, z: -1.022 },
    ]
  },
  thf: {
    name: 'THF (tetrahydrofuran)',
    formula: 'C4H8O',
    description: 'Tetrahydrofuran skeleton (SADI)',
    atoms: [
      { label: 'O1', element: 'O', x: 0.000, y: 1.170, z: 0.000 },
      { label: 'C1', element: 'C', x: 1.240, y: 0.450, z: 0.000 },
      { label: 'C2', element: 'C', x: 0.770, y: -0.960, z: 0.000 },
      { label: 'C3', element: 'C', x: -0.770, y: -0.960, z: 0.000 },
      { label: 'C4', element: 'C', x: -1.240, y: 0.450, z: 0.000 },
    ]
  },
  et2o: {
    name: 'Et2O (diethyl ether)',
    formula: 'C4H10O',
    description: 'Diethyl ether skeleton, extended anti chain (SADI)',
    atoms: [
      { label: 'O1', element: 'O', x: 0.000, y: 0.000, z: 0.000 },
      { label: 'C1', element: 'C', x: -0.536, y: -1.326, z: 0.000 },
      { label: 'C2', element: 'C', x: -2.066, y: -1.326, z: 0.000 },
      { label: 'C3', element: 'C', x: 1.430, y: 0.000, z: 0.000 },
      { label: 'C4', element: 'C', x: 2.003, y: 1.419, z: 0.000 },
    ]
  },
  pentane: {
    name: 'Pentane',
    formula: 'C5H12',
    description: 'n-Pentane skeleton (SADI)',
    atoms: [
      { label: 'C1', element: 'C', x: 0.000, y: 0.000, z: 0.000 },
      { label: 'C2', element: 'C', x: 1.530, y: 0.000, z: 0.000 },
      { label: 'C3', element: 'C', x: 2.103, y: 1.419, z: 0.000 },
      { label: 'C4', element: 'C', x: 3.633, y: 1.419, z: 0.000 },
      { label: 'C5', element: 'C', x: 4.206, y: 2.838, z: 0.000 },
    ]
  },
  hexane: {
    name: 'Hexane',
    formula: 'C6H14',
    description: 'n-Hexane skeleton (SADI)',
    atoms: [
      { label: 'C1', element: 'C', x: 0.000, y: 0.000, z: 0.000 },
      { label: 'C2', element: 'C', x: 1.530, y: 0.000, z: 0.000 },
      { label: 'C3', element: 'C', x: 2.103, y: 1.419, z: 0.000 },
      { label: 'C4', element: 'C', x: 3.633, y: 1.419, z: 0.000 },
      { label: 'C5', element: 'C', x: 4.206, y: 2.838, z: 0.000 },
      { label: 'C6', element: 'C', x: 5.736, y: 2.838, z: 0.000 },
    ]
  },
  mecn: {
    name: 'MeCN (acetonitrile)',
    formula: 'C2H3N',
    description: 'Acetonitrile skeleton (SADI)',
    atoms: [
      { label: 'C1', element: 'C', x: 0.000, y: 0.000, z: 0.000 },
      { label: 'C2', element: 'C', x: 1.460, y: 0.000, z: 0.000 },
      { label: 'N1', element: 'N', x: 2.620, y: 0.000, z: 0.000 },
    ]
  }
};
