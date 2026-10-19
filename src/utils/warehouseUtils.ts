export interface ZoneItem {
  id: string;
  name: string;
  parent_id: string | null;
  system_type?: string;
  code?: string;
}

export interface PositionWithZone {
  id: string;
  code: string;
  lot_id?: string | null;
  zone_id?: string | null;
  zone_ids?: string[];
  [key: string]: any;
}

/**
 * Groups zones and positions based on common numeric suffixes in bin names.
 * This is used for the "Gom ô" (Ô Gộp) feature matching http://localhost:3000/warehouses/assign.
 */
export function groupWarehouseData(
  zones: ZoneItem[] = [],
  positions: PositionWithZone[] = []
): {
  zones: ZoneItem[];
  virtualToRealMap: Map<string, string[]>;
} {
  try {
    if (!zones) zones = [];
    if (!positions) positions = [];

    // 1. Build lookup maps
    const parentToChildren = new Map<string, ZoneItem[]>();
    zones.forEach(z => {
      if (z && z.parent_id && z.parent_id !== '') {
        const list = parentToChildren.get(z.parent_id) || [];
        list.push(z);
        parentToChildren.set(z.parent_id, list);
      }
    });

    const finalZones: ZoneItem[] = [];
    const zoneIdMap = new Map<string, string>(); // Old ID -> New Virtual ID
    const processedOldZoneIds = new Set<string>();

    const getChildren = (parentId: string): ZoneItem[] => {
      return parentToChildren.get(parentId) || [];
    };

    // 2. Recursive function to process zones level by level
    const processZoneRecursively = (zone: ZoneItem) => {
      if (!zone || processedOldZoneIds.has(zone.id)) return;

      finalZones.push(zone);
      processedOldZoneIds.add(zone.id);

      const children = getChildren(zone.id);
      if (children.length === 0) return;

      const zoneName = zone.name || '';
      const isGroupingContainer =
        /D[ÃãYy]|S[Ảả]nh|K[Ệệ]|KHU|S[Àà]NH|CH[Ũũ]|PH[Òò]NG/i.test(zoneName) ||
        zoneName.toUpperCase().includes('DÃY');

      if (isGroupingContainer) {
        const binGroups: Record<string, ZoneItem[]> = {};
        children.forEach(c => {
          const cName = c.name || '';
          const match = cName.match(/\d+$/);
          const suffix = match ? match[0] : cName;
          binGroups[suffix] = binGroups[suffix] || [];
          binGroups[suffix].push(c);
        });

        Object.entries(binGroups)
          .sort(([suffixA], [suffixB]) =>
            suffixA.localeCompare(suffixB, undefined, { numeric: true })
          )
          .forEach(([suffix, members]) => {
            const firstMember = members[0];
            if (!firstMember) return;

            const firstMemberName = firstMember.name || '';
            const isBinPattern =
              firstMemberName.toUpperCase().startsWith('Ô ') || members.length > 1;

            if (isBinPattern) {
              // MERGE BIN CASE: Create a virtual bin ("Ô suffix")
              const safeSuffix = suffix.replace(/[^a-zA-Z0-9]/g, '_');
              const vBinId = `v-bin-${zone.id}-${safeSuffix}`;

              finalZones.push({
                ...firstMember,
                id: vBinId,
                parent_id: zone.id,
                name:
                  members.length > 1 || !firstMemberName.startsWith('Ô ')
                    ? `Ô ${suffix}`
                    : firstMemberName,
                code: `Ô ${suffix}`
              });

              // Now group the "Levels" (Tầng) inside these merged bins
              const levelGroups: Record<string, ZoneItem[]> = {};
              members.forEach(m => {
                const mChildren = getChildren(m.id);
                mChildren.forEach(lvl => {
                  const lvlName = lvl.name || '';
                  const key = lvlName.trim().toUpperCase();
                  levelGroups[key] = levelGroups[key] || [];
                  levelGroups[key].push(lvl);
                });
                processedOldZoneIds.add(m.id);
                zoneIdMap.set(m.id, vBinId);
              });

              // Create Virtual Levels under the Virtual Bin
              Object.entries(levelGroups)
                .sort(([lvlA], [lvlB]) =>
                  lvlA.localeCompare(lvlB, undefined, { numeric: true })
                )
                .forEach(([lvlName, lMembers]) => {
                  const firstLvl = lMembers[0];
                  if (!firstLvl) return;

                  const safeLvlName = lvlName.replace(/[^a-zA-Z0-9]/g, '_');
                  const vLvlId = `v-lvl-${vBinId}-${safeLvlName}`;
                  finalZones.push({
                    ...firstLvl,
                    id: vLvlId,
                    parent_id: vBinId,
                    name: firstLvl.name
                  });

                  lMembers.forEach(lm => {
                    zoneIdMap.set(lm.id, vLvlId);
                    processedOldZoneIds.add(lm.id);
                  });
                });
            } else {
              processZoneRecursively(firstMember);
            }
          });
      } else {
        const sortedChildren = [...children].sort((a, b) =>
          (a.name || '').localeCompare(b.name || '', undefined, { numeric: true })
        );
        sortedChildren.forEach(c => processZoneRecursively(c));
      }
    };

    // Process from roots (warehouses)
    const roots = zones
      .filter(z => z && (!z.parent_id || z.parent_id === ''))
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }));
    roots.forEach(processZoneRecursively);

    zones.forEach(z => {
      if (z && !processedOldZoneIds.has(z.id)) finalZones.push(z);
    });

    // 3. Build Virtual to Real mapping
    const virtualToRealMap = new Map<string, string[]>();
    zoneIdMap.forEach((vId, realId) => {
      const list = virtualToRealMap.get(vId) || [];
      list.push(realId);
      virtualToRealMap.set(vId, list);
    });

    return {
      zones: finalZones,
      virtualToRealMap
    };
  } catch (error) {
    console.error('Error in groupWarehouseData:', error);
    return { zones, virtualToRealMap: new Map() };
  }
}
