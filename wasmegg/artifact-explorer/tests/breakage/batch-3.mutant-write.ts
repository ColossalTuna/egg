// SEAM-18 mutation: the writer's makespanSeconds changes meaning (raw instead of floored).
import { projectSolvedVisit as real } from '../../src/lib/plan/write';
export * from '../../src/lib/plan/write';
export function projectSolvedVisit(args: Parameters<typeof real>[0]) {
  const out = real(args);
  return { ...out, makespanSeconds: out.rawMakespanSeconds };
}
