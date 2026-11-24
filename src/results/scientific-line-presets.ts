const shared = {
  color: '#249972',
  markerBorder: 0.8,
  pageWidthMm: 90,
  axisColor: '#283238',
  axisWidth: 0.75,
  referenceColor: '#a5b3b7',
  referenceWidth: 0.6,
  font: 'Arial',
  baseSize: 7,
  lineWidth: 1.5,
  markerSize: 5,
  inwardTicks: true,
  ratio: 1,
  showZero: true,
  showSelectedLabel: true,
  frameOffsets: { right: .002927, left: .01887, top: .043607, bottom: -.016673 },
  titleSize: 12, axisSize: 12, yAxisSize: 11.5, tickSize: 9, annotationSize: 9, legendSize: 10,
} as const;

/** The two point-line styles submitted in the interactive preset editor. */
export const scientificLinePresets = {
  hollow: { ...shared, label: '空心', hollow: true },
  solid: { ...shared, label: '实心', hollow: false },
} as const;

export type ScientificLinePresetId = keyof typeof scientificLinePresets;
export type ScientificLinePreset = typeof scientificLinePresets[ScientificLinePresetId];

export const defaultScientificLinePreset: ScientificLinePresetId = 'hollow';
