export const FRAGMENTS = {
  phenyl: {
    name: 'Phenyl',
    formula: 'C6',
    description: 'Aromatic 6-membered carbon ring',
    atoms: [
      { label: 'C1', element: 'C', x: 1.395, y: 0.000, z: 0.000 },
      { label: 'C2', element: 'C', x: 0.698, y: 1.208, z: 0.000 },
      { label: 'C3', element: 'C', x: -0.698, y: 1.208, z: 0.000 },
      { label: 'C4', element: 'C', x: -1.395, y: 0.000, z: 0.000 },
      { label: 'C5', element: 'C', x: -0.698, y: -1.208, z: 0.000 },
      { label: 'C6', element: 'C', x: 0.698, y: -1.208, z: 0.000 },
    ]
  },
  tBu: {
    name: 't-Bu',
    formula: 'C(CH3)3',
    description: 'tert-Butyl group (4 carbons)',
    atoms: [
      { label: 'C1', element: 'C', x: 0.000, y: 0.000, z: 0.000 },
      { label: 'C2', element: 'C', x: 0.883, y: 0.883, z: 0.883 },
      { label: 'C3', element: 'C', x: 0.883, y: -0.883, z: -0.883 },
      { label: 'C4', element: 'C', x: -0.883, y: 0.883, z: -0.883 },
    ]
  },
  iPr: {
    name: 'iPr',
    formula: 'CH(CH3)2',
    description: 'Isopropyl group (3 carbons)',
    atoms: [
      { label: 'C1', element: 'C', x: 0.000, y: 0.000, z: 0.000 },
      { label: 'C2', element: 'C', x: 0.883, y: 0.883, z: 0.883 },
      { label: 'C3', element: 'C', x: 0.883, y: -0.883, z: -0.883 },
    ]
  },
  methyl: {
    name: 'Methyl',
    formula: 'CH3',
    description: 'Methyl group',
    atoms: [
      { label: 'C1', element: 'C', x: 0.000, y: 0.000, z: 0.000 },
      { label: 'H1', element: 'H', x: 0.883, y: 0.883, z: 0.883 },
      { label: 'H2', element: 'H', x: 0.883, y: -0.883, z: -0.883 },
      { label: 'H3', element: 'H', x: -0.883, y: 0.883, z: -0.883 },
    ]
  },
  ethyl: {
    name: 'Ethyl',
    formula: 'CH2CH3',
    description: 'Ethyl group (2 carbons)',
    atoms: [
      { label: 'C1', element: 'C', x: 0.000, y: 0.000, z: 0.000 },
      { label: 'C2', element: 'C', x: 0.000, y: 1.530, z: 0.000 },
    ]
  },
  carboxyl: {
    name: 'Carboxyl',
    formula: 'COOH',
    description: 'Carboxylic acid group',
    atoms: [
      { label: 'C1', element: 'C', x: 0.000, y: 0.000, z: 0.000 },
      { label: 'O1', element: 'O', x: 0.000, y: 1.230, z: 0.000 },
      { label: 'O2', element: 'O', x: 1.230, y: -0.600, z: 0.000 },
    ]
  },
  amino: {
    name: 'Amino',
    formula: 'NH2',
    description: 'Amino group',
    atoms: [
      { label: 'N1', element: 'N', x: 0.000, y: 0.000, z: 0.000 },
      { label: 'H1', element: 'H', x: 0.883, y: 0.883, z: 0.883 },
      { label: 'H2', element: 'H', x: 0.883, y: -0.883, z: -0.883 },
    ]
  },
  nitro: {
    name: 'Nitro',
    formula: 'NO2',
    description: 'Nitro group',
    atoms: [
      { label: 'N1', element: 'N', x: 0.000, y: 0.000, z: 0.000 },
      { label: 'O1', element: 'O', x: 0.000, y: 1.220, z: 0.000 },
      { label: 'O2', element: 'O', x: 1.130, y: -0.400, z: 0.000 },
    ]
  },
  carbonyl: {
    name: 'Carbonyl',
    formula: 'C=O',
    description: 'Carbonyl group',
    atoms: [
      { label: 'C1', element: 'C', x: 0.000, y: 0.000, z: 0.000 },
      { label: 'O1', element: 'O', x: 0.000, y: 1.230, z: 0.000 },
    ]
  },
  cf3: {
    name: 'CF3',
    formula: 'CF3',
    description: 'Trifluoromethyl group',
    atoms: [
      { label: 'C1', element: 'C', x: 0.000, y: 0.000, z: 0.000 },
      { label: 'F1', element: 'F', x: 0.883, y: 0.883, z: 0.883 },
      { label: 'F2', element: 'F', x: 0.883, y: -0.883, z: -0.883 },
      { label: 'F3', element: 'F', x: -0.883, y: 0.883, z: -0.883 },
    ]
  },
  pyridine: {
    name: 'Pyridine',
    formula: 'C5H5N',
    description: 'Pyridine ring (6-membered with N)',
    atoms: [
      { label: 'C1', element: 'C', x: 1.395, y: 0.000, z: 0.000 },
      { label: 'C2', element: 'C', x: 0.698, y: 1.208, z: 0.000 },
      { label: 'C3', element: 'C', x: -0.698, y: 1.208, z: 0.000 },
      { label: 'C4', element: 'C', x: -1.395, y: 0.000, z: 0.000 },
      { label: 'C5', element: 'C', x: -0.698, y: -1.208, z: 0.000 },
      { label: 'N1', element: 'N', x: 0.698, y: -1.208, z: 0.000 },
    ]
  }
};
