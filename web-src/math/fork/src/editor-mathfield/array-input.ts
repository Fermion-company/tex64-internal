import type { _Model } from '../editor-model/model-private';

const COLUMN_ENVIRONMENTS = new Set([
  'array',
  'matrix',
  'pmatrix',
  'bmatrix',
  'Bmatrix',
  'vmatrix',
  'Vmatrix',
  'smallmatrix',
]);

/** The root math field uses `lines`; Return must never turn it into a draft. */
export function canInsertArrayRow(model: _Model): boolean {
  const environmentName = model.parentEnvironment?.environmentName;
  return typeof environmentName === 'string' && environmentName !== 'lines';
}

/** Columns are only meaningful for an explicit matrix or array. */
export function canInsertArrayColumn(model: _Model): boolean {
  const environmentName = model.parentEnvironment?.environmentName;
  return typeof environmentName === 'string' && COLUMN_ENVIRONMENTS.has(environmentName);
}
