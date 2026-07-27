import { ei, useSearch } from 'lib';
import { artifactTiers } from './artifacts';
import { missions } from './missions';
import { parseTankIds } from './tank-ids';
export { missions };

export const artifacts = artifactTiers.map(artifact => ({
  ...artifact,
  display: `${artifact.name} (T${artifact.tier_number})`,
}));
export const legendaryArtifacts = artifactTiers
  .filter(artifact => {
    if (!artifact.effects) return false;

    for (const rarity of artifact.effects) {
      if (rarity.afx_rarity === ei.ArtifactSpec.Rarity.LEGENDARY) {
        return true;
      }
    }
    return false;
  })
  .map(artifact => ({
    ...artifact,
    display: `${artifact.name} (T${artifact.tier_number})`,
  }));
export const artifactIds = artifacts.map(artifact => artifact.id);
export const artifactIdToArtifact = new Map(artifacts.map(artifact => [artifact.id, artifact]));

// The tank route's id list, restricted to ids that name a real artifact. The
// param is hand-editable, so an id can parse fine and still resolve to nothing;
// passing one on reaches getArtifactTierPropsFromId(), which throws. Both the
// selector and the planner have to drop the same ids, or the URL and the Share
// link end up describing different plans — hence one helper rather than the
// filter written out twice. It lives here rather than in tank-ids.ts so that
// stays a pure string routine with no dependency on artifact data.
export function parseKnownTankIds(param: string | undefined | null): string[] {
  return parseTankIds(param).filter(id => artifactIdToArtifact.has(id));
}
export const missionIds = missions.map(mission => mission.missionTypeId);
export const missionIdToMission = new Map(missions.map(mission => [mission.missionTypeId, mission]));

const { search: searchArtifacts } = useSearch(artifacts, 'id', ['display']);
const { search: searchLegendaryArtifacts } = useSearch(legendaryArtifacts, 'id', ['display']);
const { search: searchMissions } = useSearch(missions, 'missionTypeId', ['name']);
export { searchArtifacts, searchLegendaryArtifacts, searchMissions };
