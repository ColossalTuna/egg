import { allMissionTypes, ei, MissionType } from 'lib';
import DurationType = ei.MissionInfo.DurationType;

// The game's caps on the two epic researches the optimizer reads. The UI holds its inputs to these,
// and the plan reader rejects anything outside them, but a level can still arrive from stale
// storage or a hand-edited file.
export const MAX_FTL_LEVEL = 60;
export const MAX_ZEROG_LEVEL = 10;

// Duration falls by 1% per FTL level, so a level past 100 would price a mission at zero or negative
// seconds. Clamping here keeps every duration the optimizer sees positive and matching what the game
// would fly at its own cap, whatever level the caller passes.
export function clampFTLLevel(level: number): number {
  return Number.isFinite(level) ? Math.min(MAX_FTL_LEVEL, Math.max(0, level)) : 0;
}

class ClampedMissionType extends MissionType {
  override boostedDurationSecondsAtLevel(level: number): number {
    return super.boostedDurationSecondsAtLevel(clampFTLLevel(level));
  }
}

export const missions: MissionType[] = allMissionTypes
  .filter(m => m.durationType !== DurationType.TUTORIAL)
  .map(m => new ClampedMissionType(m.shipType, m.durationType));
