import type { components } from "./api-schema.generated";

type UniverseNode = components["schemas"]["UniverseNode"];

function stableHash(value: string) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export function layoutUniverse(nodes: UniverseNode[]) {
  const groups = new Map<string, UniverseNode[]>();
  nodes.forEach((node) => groups.set(node.community_id, [...(groups.get(node.community_id) ?? []), node]));
  const communities = [...groups.entries()].sort(([a, aMembers], [b, bMembers]) => bMembers.length - aMembers.length || a.localeCompare(b));
  const positions = new Map<string, { x: number; y: number }>();
  const golden = Math.PI * (3 - Math.sqrt(5));
  communities.forEach(([communityId, members], communityIndex) => {
    const progress = communityIndex === 0 ? 0 : Math.sqrt(communityIndex / Math.max(1, communities.length - 1));
    const centerAngle = communityIndex * golden + (stableHash(communityId) % 360) * Math.PI / 180;
    const centerX = 500 + Math.cos(centerAngle) * 335 * progress;
    const centerY = 310 + Math.sin(centerAngle) * 205 * progress;
    const ordered = [...members].sort((a, b) => b.affinity - a.affinity || a.id.localeCompare(b.id));
    const spread = Math.min(340, 42 + Math.sqrt(ordered.length) * 32);
    const phase = (stableHash(communityId) % 628) / 100;
    ordered.forEach((node, index) => {
      const localProgress = ordered.length === 1 ? 0 : Math.sqrt(index / Math.max(1, ordered.length - 1));
      const angle = phase + index * golden;
      positions.set(node.id, {
        x: Math.max(34, Math.min(966, centerX + Math.cos(angle) * spread * localProgress)),
        y: Math.max(30, Math.min(590, centerY + Math.sin(angle) * spread * .68 * localProgress)),
      });
    });
  });
  return positions;
}
