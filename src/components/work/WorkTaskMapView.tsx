import React, { useState, useMemo, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { Ionicons, Feather } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { groupWarehouseData, ZoneItem as BaseZoneItem } from '../../utils/warehouseUtils';
import { decodeSTT } from '../../utils/numberUtils';
import type { WorkExportTaskItem } from '../../screens/WorkScreen';

interface WorkMapZone extends BaseZoneItem {
  is_hall?: boolean;
  display_order?: number;
}

interface WorkMapPosition {
  id: string;
  code: string;
  lot_id?: string | null;
  zone_id?: string | null;
  zone_ids?: string[];
  [key: string]: any;
}

interface WorkTaskMapViewProps {
  taskItems: WorkExportTaskItem[];
  zones: WorkMapZone[];
  positions: WorkMapPosition[];
  onHaSanh: (item: WorkExportTaskItem) => void;
  onHaSanhAll?: (items: WorkExportTaskItem[]) => void;
}

interface ZoneStats {
  total: number;
  pending: number;
  moved: number;
  totalQty: number;
  unit: string;
}

function formatStt(stt: number | string | null | undefined): string | null {
  if (stt === null || stt === undefined || stt === '') return null;
  if (typeof stt === 'number') return decodeSTT(stt) || String(stt);
  const num = Number(stt);
  if (!Number.isNaN(num) && /^\d+$/.test(String(stt)) && num > 1000) {
    return decodeSTT(num) || String(stt);
  }
  return String(stt);
}

function getPriorityBadge(priority: number) {
  switch (priority) {
    case 1:
      return { label: 'UT1', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.16)', border: '#ef4444' };
    case 2:
      return { label: 'UT2', color: '#eab308', bg: 'rgba(234, 179, 8, 0.16)', border: '#eab308' };
    case 3:
      return { label: 'UT3', color: '#a16207', bg: 'rgba(161, 98, 7, 0.18)', border: '#a16207' };
    case 4:
      return { label: 'UT4', color: '#a855f7', bg: 'rgba(168, 85, 247, 0.16)', border: '#a855f7' };
    default:
      return null;
  }
}

export const WorkTaskMapView: React.FC<WorkTaskMapViewProps> = ({
  taskItems,
  zones: rawZones,
  positions: rawPositions,
  onHaSanh,
  onHaSanhAll,
}) => {
  const { colors, isDark } = useTheme();
  const [subTab, setSubTab] = useState<'stats' | 'map'>('stats');
  const [expandedStatsZones, setExpandedStatsZones] = useState<Record<string, boolean>>({});

  const [selectedWhId, setSelectedWhId] = useState<string | null>(null);
  const [selectedAisleId, setSelectedAisleId] = useState<string | null>(null);
  const [selectedBinId, setSelectedBinId] = useState<string | null>(null);
  const [activeLevelFilter, setActiveLevelFilter] = useState<string>('ALL');
  const [expandedLevels, setExpandedLevels] = useState<Record<string, boolean>>({});

  // Gom ô giống Sơ Đồ Kho
  const { zones, virtualToRealMap } = useMemo(() => {
    return groupWarehouseData(rawZones || [], rawPositions || []);
  }, [rawZones, rawPositions]);

  const realToVirtualZone = useMemo(() => {
    const map = new Map<string, string>();
    virtualToRealMap.forEach((realIds, vId) => {
      realIds.forEach(rId => map.set(rId, vId));
    });
    return map;
  }, [virtualToRealMap]);

  // Map position_id / position_code -> WorkExportTaskItem
  const taskItemByPos = useMemo(() => {
    const map = new Map<string, WorkExportTaskItem>();
    taskItems.forEach(it => {
      if (it.position_id) map.set(it.position_id, it);
      if (it.position_code) map.set(it.position_code.toUpperCase(), it);
    });
    return map;
  }, [taskItems]);

  const { zoneMap, childrenMap, directPositionsMap } = useMemo(() => {
    const zMap = new Map<string, WorkMapZone>();
    const cMap = new Map<string, WorkMapZone[]>();
    const pMap = new Map<string, WorkMapPosition[]>();

    zones.forEach(z => {
      zMap.set(z.id, z);
      if (z.parent_id) {
        const list = cMap.get(z.parent_id) || [];
        list.push(z);
        cMap.set(z.parent_id, list);
      }
    });

    cMap.forEach(list => {
      list.sort((a, b) =>
        (a.name || '').localeCompare(b.name || '', undefined, { numeric: true })
      );
    });

    (rawPositions || []).forEach(p => {
      const zIds = Array.isArray(p.zone_ids) ? p.zone_ids : p.zone_id ? [p.zone_id] : [];
      const rawZId = zIds[zIds.length - 1] || zIds[0];
      if (!rawZId) return;
      const targetZId = zMap.has(rawZId) ? rawZId : realToVirtualZone.get(rawZId) || rawZId;
      const list = pMap.get(targetZId) || [];
      list.push(p);
      pMap.set(targetZId, list);
    });

    pMap.forEach(list => {
      list.sort((a, b) =>
        (a.code || '').localeCompare(b.code || '', undefined, { numeric: true })
      );
    });

    return { zoneMap: zMap, childrenMap: cMap, directPositionsMap: pMap };
  }, [zones, rawPositions, realToVirtualZone]);

  const zoneExportStats = useMemo(() => {
    const cache = new Map<string, ZoneStats>();

    const compute = (zoneId: string): ZoneStats => {
      if (cache.has(zoneId)) return cache.get(zoneId)!;
      let total = 0;
      let pending = 0;
      let moved = 0;
      let totalQty = 0;
      let unit = '';

      const directPos = directPositionsMap.get(zoneId) || [];
      directPos.forEach(p => {
        const m =
          taskItemByPos.get(p.id) || (p.code ? taskItemByPos.get(p.code.toUpperCase()) : undefined);
        if (m) {
          total++;
          totalQty += Number(m.quantity) || 0;
          if (!unit && m.unit) unit = m.unit;
          if (m.display_status === 'Moved to Hall') moved++;
          else pending++;
        }
      });

      const children = childrenMap.get(zoneId) || [];
      children.forEach(c => {
        const sub = compute(c.id);
        total += sub.total;
        pending += sub.pending;
        moved += sub.moved;
        totalQty += sub.totalQty;
        if (!unit && sub.unit) unit = sub.unit;
      });

      const res: ZoneStats = { total, pending, moved, totalQty, unit };
      cache.set(zoneId, res);
      return res;
    };

    zones.forEach(z => compute(z.id));
    return cache;
  }, [zones, directPositionsMap, childrenMap, taskItemByPos]);

  const rootWarehouses = useMemo(() => {
    return zones
      .filter(z => !z.parent_id && (zoneExportStats.get(z.id)?.total || 0) > 0)
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }));
  }, [zones, zoneExportStats]);

  const summaryStats = useMemo(() => {
    const totalQty = taskItems.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
    const unit = taskItems.find(it => it.unit)?.unit || 'Thùng';
    const pendingCount = taskItems.filter(it => it.display_status !== 'Moved to Hall').length;
    return {
      totalQty,
      unit,
      totalPositions: taskItems.length,
      pendingCount,
      warehousesCount: rootWarehouses.length,
    };
  }, [taskItems, rootWarehouses.length]);

  const jumpToMap = (
    whId: string | null,
    aisleId: string | null = null,
    binId: string | null = null,
    levelId: string | null = null
  ) => {
    setSelectedWhId(whId);
    setSelectedAisleId(aisleId);
    setSelectedBinId(binId);
    if (levelId) {
      setTimeout(() => {
        setActiveLevelFilter(levelId);
        setExpandedLevels({ [levelId]: true });
      }, 0);
    }
    setSubTab('map');
  };

  const toggleAllStatsTree = (expand: boolean) => {
    if (!expand) {
      setExpandedStatsZones({});
      return;
    }
    const next: Record<string, boolean> = {};
    rootWarehouses.forEach(wh => {
      next[wh.id] = true;
      const aisles = (childrenMap.get(wh.id) || []).filter(
        a => (zoneExportStats.get(a.id)?.total || 0) > 0
      );
      aisles.forEach(a => {
        next[a.id] = true;
        const bins = (childrenMap.get(a.id) || []).filter(
          b => (zoneExportStats.get(b.id)?.total || 0) > 0
        );
        bins.forEach(b => {
          next[b.id] = true;
          const lvls = (childrenMap.get(b.id) || []).filter(
            l => (zoneExportStats.get(l.id)?.total || 0) > 0
          );
          lvls.forEach(l => {
            next[l.id] = true;
          });
        });
      });
    });
    setExpandedStatsZones(next);
  };

  const activeAisles = useMemo(() => {
    if (!selectedWhId) return [];
    return (childrenMap.get(selectedWhId) || []).filter(
      c => (zoneExportStats.get(c.id)?.total || 0) > 0
    );
  }, [selectedWhId, childrenMap, zoneExportStats]);

  const activeBins = useMemo(() => {
    if (!selectedAisleId) return [];
    return (childrenMap.get(selectedAisleId) || []).filter(
      c => (zoneExportStats.get(c.id)?.total || 0) > 0
    );
  }, [selectedAisleId, childrenMap, zoneExportStats]);

  const activeLevels = useMemo(() => {
    if (!selectedBinId) return [];
    const children = childrenMap.get(selectedBinId) || [];
    if (children.length > 0) {
      return children
        .map(lvl => ({
          id: lvl.id,
          name: lvl.name,
          positions: directPositionsMap.get(lvl.id) || [],
          stats: zoneExportStats.get(lvl.id) || {
            total: 0,
            pending: 0,
            moved: 0,
            totalQty: 0,
            unit: '',
          },
        }))
        .filter(lvl => lvl.stats.total > 0);
    }
    const binObj = zoneMap.get(selectedBinId);
    const binStats = zoneExportStats.get(selectedBinId) || {
      total: 0,
      pending: 0,
      moved: 0,
      totalQty: 0,
      unit: '',
    };
    if (binStats.total === 0) return [];
    return [
      {
        id: selectedBinId,
        name: binObj?.name || 'Danh sách ô',
        positions: directPositionsMap.get(selectedBinId) || [],
        stats: binStats,
      },
    ];
  }, [selectedBinId, childrenMap, directPositionsMap, zoneExportStats, zoneMap]);

  useEffect(() => {
    if (!selectedBinId) return;
    setActiveLevelFilter('ALL');
    const initial: Record<string, boolean> = {};
    activeLevels.forEach(lvl => {
      if (lvl.stats.total > 0) initial[lvl.id] = true;
    });
    setExpandedLevels(initial);
  }, [selectedBinId, activeLevels]);

  const unmappedTaskItems = useMemo(() => {
    const mappedIds = new Set<string>();
    (rawPositions || []).forEach(p => {
      const m =
        taskItemByPos.get(p.id) || (p.code ? taskItemByPos.get(p.code.toUpperCase()) : undefined);
      if (m) mappedIds.add(m.id);
    });
    return taskItems.filter(it => !mappedIds.has(it.id));
  }, [rawPositions, taskItems, taskItemByPos]);

  const selectedWh = selectedWhId ? zoneMap.get(selectedWhId) : null;
  const selectedAisle = selectedAisleId ? zoneMap.get(selectedAisleId) : null;
  const selectedBin = selectedBinId ? zoneMap.get(selectedBinId) : null;

  const displayedLevels = useMemo(() => {
    if (activeLevelFilter === 'ALL') return activeLevels;
    return activeLevels.filter(l => l.id === activeLevelFilter);
  }, [activeLevels, activeLevelFilter]);

  const totalPositionsInBin = useMemo(
    () => activeLevels.reduce((sum, l) => sum + l.positions.length, 0),
    [activeLevels]
  );

  const toggleAllLevels = (expand: boolean) => {
    const next: Record<string, boolean> = {};
    activeLevels.forEach(lvl => {
      next[lvl.id] = expand;
    });
    setExpandedLevels(next);
  };

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: 32 }}
      showsVerticalScrollIndicator={false}
    >
      {/* Thanh 2 tab giống Sơ Đồ Kho: "Thống kê phân bổ" | "Sơ đồ vị trí" */}
      <View
        style={[
          styles.subTabBar,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <TouchableOpacity
          onPress={() => setSubTab('stats')}
          style={[
            styles.subTabBtn,
            subTab === 'stats' && { backgroundColor: '#facc15' },
          ]}
        >
          <Feather
            name="bar-chart-2"
            size={14}
            color={subTab === 'stats' ? '#0f172a' : colors.textMuted}
          />
          <Text
            style={[
              styles.subTabText,
              { color: subTab === 'stats' ? '#0f172a' : colors.textSecondary },
            ]}
          >
            Thống kê phân bổ
          </Text>
          <View
            style={[
              styles.subTabBadge,
              {
                backgroundColor:
                  subTab === 'stats' ? 'rgba(15, 23, 42, 0.16)' : 'rgba(245, 158, 11, 0.16)',
              },
            ]}
          >
            <Text
              style={{
                fontSize: 10,
                fontWeight: '800',
                color: subTab === 'stats' ? '#0f172a' : '#d97706',
              }}
            >
              {summaryStats.totalQty.toLocaleString('vi-VN')}
            </Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => setSubTab('map')}
          style={[
            styles.subTabBtn,
            subTab === 'map' && { backgroundColor: '#059669' },
          ]}
        >
          <Feather
            name="map-pin"
            size={14}
            color={subTab === 'map' ? '#ffffff' : colors.textMuted}
          />
          <Text
            style={[
              styles.subTabText,
              { color: subTab === 'map' ? '#ffffff' : colors.textSecondary },
            ]}
          >
            Sơ đồ vị trí
          </Text>
        </TouchableOpacity>
      </View>

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* TAB 1: BẢNG THỐNG KÊ PHÂN BỔ LỆNH XUẤT                             */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {subTab === 'stats' && (
        <View style={{ gap: 10 }}>
          {/* Card Tổng hợp 3 chỉ số */}
          <View
            style={[
              styles.summaryCard,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            <View style={styles.summaryHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 }}>
                <Feather name="bar-chart-2" size={12} color="#f59e0b" />
                <Text style={styles.summaryTitle} numberOfLines={1}>
                  PHÂN BỔ LỆNH XUẤT
                </Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <TouchableOpacity onPress={() => toggleAllStatsTree(true)}>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: '#38bdf8' }}>Mở rộng</Text>
                </TouchableOpacity>
                <Text style={{ fontSize: 10, color: colors.textMuted }}>•</Text>
                <TouchableOpacity onPress={() => toggleAllStatsTree(false)}>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textMuted }}>
                    Thu gọn
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.kpiRow}>
              <View
                style={[
                  styles.kpiBox,
                  {
                    backgroundColor: isDark ? 'rgba(180, 83, 9, 0.16)' : '#fffbeb',
                    borderColor: isDark ? 'rgba(245, 158, 11, 0.35)' : '#fde68a',
                  },
                ]}
              >
                <Text style={styles.kpiLabel}>TỔNG XUẤT</Text>
                <Text style={[styles.kpiValue, { color: '#f59e0b' }]}>
                  {summaryStats.totalQty.toLocaleString('vi-VN')}
                </Text>
                <Text style={styles.kpiSub} numberOfLines={1}>
                  {summaryStats.unit}
                </Text>
              </View>

              <View
                style={[
                  styles.kpiBox,
                  {
                    backgroundColor: isDark ? 'rgba(5, 150, 105, 0.16)' : '#ecfdf5',
                    borderColor: isDark ? 'rgba(16, 185, 129, 0.35)' : '#a7f3d0',
                  },
                ]}
              >
                <Text style={styles.kpiLabel}>VỊ TRÍ LẤY</Text>
                <Text style={[styles.kpiValue, { color: '#10b981' }]}>
                  {summaryStats.totalPositions}
                </Text>
                <Text style={styles.kpiSub}>cần hạ {summaryStats.pendingCount} ô</Text>
              </View>

              <View
                style={[
                  styles.kpiBox,
                  {
                    backgroundColor: isDark ? 'rgba(2, 132, 199, 0.16)' : '#f0f9ff',
                    borderColor: isDark ? 'rgba(56, 189, 248, 0.35)' : '#bae6fd',
                  },
                ]}
              >
                <Text style={styles.kpiLabel}>SỐ KHO</Text>
                <Text style={[styles.kpiValue, { color: '#0ea5e9' }]}>
                  {summaryStats.warehousesCount}
                </Text>
                <Text style={styles.kpiSub}>kho có hàng</Text>
              </View>
            </View>
          </View>

          {/* Danh sách Kho dạng Accordion kèm nút Sơ đồ */}
          {rootWarehouses.map(wh => {
            const whStats = zoneExportStats.get(wh.id) || {
              total: 0,
              pending: 0,
              moved: 0,
              totalQty: 0,
              unit: summaryStats.unit,
            };
            const isWhExpanded = Boolean(expandedStatsZones[wh.id]);
            const aisles = (childrenMap.get(wh.id) || []).filter(
              a => (zoneExportStats.get(a.id)?.total || 0) > 0
            );

            return (
              <View
                key={wh.id}
                style={[
                  styles.whAccordionCard,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                ]}
              >
                <TouchableOpacity
                  activeOpacity={0.75}
                  onPress={() =>
                    setExpandedStatsZones(prev => ({ ...prev, [wh.id]: !prev[wh.id] }))
                  }
                  style={styles.whAccordionHeader}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                    <Feather
                      name={isWhExpanded ? 'chevron-down' : 'chevron-right'}
                      size={16}
                      color={isWhExpanded ? '#10b981' : colors.textMuted}
                    />
                    <View style={styles.whCircleIcon}>
                      <Ionicons name="business" size={14} color="#10b981" />
                    </View>
                    <Text style={[styles.whAccordionTitle, { color: colors.text }]} numberOfLines={1}>
                      {wh.name}
                    </Text>
                  </View>

                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ fontSize: 12, fontWeight: '800', color: '#f59e0b' }}>
                      {whStats.totalQty.toLocaleString('vi-VN')} {whStats.unit || summaryStats.unit}
                    </Text>
                    <Text style={{ fontSize: 10, color: colors.textMuted }}>
                      {whStats.total} ô {whStats.pending > 0 ? `(cần hạ ${whStats.pending})` : '(đã hạ)'}
                    </Text>
                  </View>
                </TouchableOpacity>

                {isWhExpanded && aisles.length > 0 && (
                  <View
                    style={[
                      styles.aisleListWrap,
                      {
                        borderTopColor: colors.border,
                        backgroundColor: isDark ? 'rgba(2, 6, 23, 0.35)' : '#f8fafc',
                      },
                    ]}
                  >
                    {aisles.map(aisle => {
                      const aStats = zoneExportStats.get(aisle.id) || {
                        total: 0,
                        pending: 0,
                        moved: 0,
                        totalQty: 0,
                        unit: whStats.unit,
                      };
                      const isAisleExpanded = Boolean(expandedStatsZones[aisle.id]);
                      const bins = (childrenMap.get(aisle.id) || []).filter(
                        b => (zoneExportStats.get(b.id)?.total || 0) > 0
                      );

                      return (
                        <View
                          key={aisle.id}
                          style={[
                            styles.aisleCard,
                            { backgroundColor: colors.surface, borderColor: colors.border },
                          ]}
                        >
                          <TouchableOpacity
                            activeOpacity={0.75}
                            onPress={() =>
                              setExpandedStatsZones(prev => ({
                                ...prev,
                                [aisle.id]: !prev[aisle.id],
                              }))
                            }
                            style={styles.aisleHeader}
                          >
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                              <Feather
                                name={isAisleExpanded ? 'chevron-down' : 'chevron-right'}
                                size={14}
                                color={isAisleExpanded ? '#38bdf8' : colors.textMuted}
                              />
                              <Text style={{ fontSize: 12, fontWeight: '800', color: colors.text }}>
                                {aisle.name}
                              </Text>
                              <Text style={{ fontSize: 10, color: colors.textMuted }}>
                                ({aStats.total} ô)
                              </Text>
                            </View>

                            <Text style={{ fontSize: 12, fontWeight: '800', color: '#f59e0b' }}>
                              {aStats.totalQty.toLocaleString('vi-VN')}{' '}
                              {aStats.unit || summaryStats.unit}
                            </Text>
                          </TouchableOpacity>

                          {isAisleExpanded && bins.length > 0 && (
                            <View
                              style={{
                                borderTopWidth: 1,
                                borderTopColor: colors.border,
                                padding: 6,
                                gap: 6,
                              }}
                            >
                              {bins.map(bin => {
                                const bStats = zoneExportStats.get(bin.id) || {
                                  total: 0,
                                  pending: 0,
                                  moved: 0,
                                  totalQty: 0,
                                  unit: aStats.unit,
                                };
                                const isBinExpanded = Boolean(expandedStatsZones[bin.id]);
                                const rawLvlChildren = (childrenMap.get(bin.id) || []).filter(
                                  l => (zoneExportStats.get(l.id)?.total || 0) > 0
                                );
                                const binLevels =
                                  rawLvlChildren.length > 0
                                    ? rawLvlChildren.map(l => ({
                                        id: l.id,
                                        name: l.name,
                                        positions: directPositionsMap.get(l.id) || [],
                                        stats: zoneExportStats.get(l.id)!,
                                      }))
                                    : [
                                        {
                                          id: bin.id,
                                          name: bin.name,
                                          positions: directPositionsMap.get(bin.id) || [],
                                          stats: bStats,
                                        },
                                      ];

                                return (
                                  <View
                                    key={bin.id}
                                    style={{
                                      borderRadius: 10,
                                      borderWidth: 1,
                                      borderColor: isBinExpanded
                                        ? 'rgba(16, 185, 129, 0.45)'
                                        : colors.border,
                                      backgroundColor: isDark
                                        ? 'rgba(2, 6, 23, 0.55)'
                                        : '#f8fafc',
                                      overflow: 'hidden',
                                    }}
                                  >
                                    {/* Hàng Ô kệ */}
                                    <TouchableOpacity
                                      activeOpacity={0.75}
                                      onPress={() =>
                                        setExpandedStatsZones(prev => ({
                                          ...prev,
                                          [bin.id]: !prev[bin.id],
                                        }))
                                      }
                                      style={{
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        paddingHorizontal: 9,
                                        paddingVertical: 8,
                                        gap: 6,
                                      }}
                                    >
                                      <View
                                        style={{
                                          flexDirection: 'row',
                                          alignItems: 'center',
                                          gap: 5,
                                          flex: 1,
                                        }}
                                      >
                                        <Feather
                                          name={isBinExpanded ? 'chevron-down' : 'chevron-right'}
                                          size={13}
                                          color={isBinExpanded ? '#10b981' : colors.textMuted}
                                        />
                                        <Text
                                          style={{
                                            fontSize: 12,
                                            fontWeight: '800',
                                            color: colors.text,
                                          }}
                                          numberOfLines={1}
                                        >
                                          {bin.name}
                                        </Text>
                                        <Text
                                          style={{ fontSize: 10, color: colors.textMuted }}
                                          numberOfLines={1}
                                        >
                                          ({bStats.total} ô • {binLevels.length} tầng)
                                        </Text>
                                      </View>

                                      <Text
                                        style={{
                                          fontSize: 12,
                                          fontWeight: '800',
                                          color: '#10b981',
                                        }}
                                        numberOfLines={1}
                                      >
                                        {bStats.totalQty.toLocaleString('vi-VN')}{' '}
                                        {bStats.unit || summaryStats.unit}
                                      </Text>
                                    </TouchableOpacity>

                                    {/* Danh sách Tầng trong Ô */}
                                    {isBinExpanded && (
                                      <View style={{ paddingHorizontal: 7, paddingBottom: 7, gap: 6 }}>
                                        {binLevels.map(lvl => {
                                          const lvlExpanded = Boolean(expandedStatsZones[lvl.id]);
                                          const lvlExportPositions = lvl.positions
                                            .map(p => {
                                              const match =
                                                taskItemByPos.get(p.id) ||
                                                (p.code
                                                  ? taskItemByPos.get(p.code.toUpperCase())
                                                  : undefined);
                                              return match ? { pos: p, match } : null;
                                            })
                                            .filter(Boolean) as {
                                            pos: WorkMapPosition;
                                            match: WorkExportTaskItem;
                                          }[];

                                          return (
                                            <View
                                              key={lvl.id}
                                              style={{
                                                borderRadius: 9,
                                                borderWidth: 1,
                                                borderColor: colors.border,
                                                backgroundColor: colors.surface,
                                                overflow: 'hidden',
                                              }}
                                            >
                                              {/* Hàng Tầng gọn đúng 2 dòng, nút Hạ hết cao cân đối */}
                                              <View
                                                style={{
                                                  flexDirection: 'row',
                                                  alignItems: 'stretch',
                                                  justifyContent: 'space-between',
                                                  paddingHorizontal: 8,
                                                  paddingVertical: 6,
                                                  gap: 6,
                                                }}
                                              >
                                                <TouchableOpacity
                                                  onPress={() =>
                                                    setExpandedStatsZones(prev => ({
                                                      ...prev,
                                                      [lvl.id]: !prev[lvl.id],
                                                    }))
                                                  }
                                                  style={{
                                                    flexDirection: 'row',
                                                    alignItems: 'center',
                                                    gap: 5,
                                                    flex: 1,
                                                  }}
                                                >
                                                  <Feather
                                                    name={
                                                      lvlExpanded
                                                        ? 'chevron-down'
                                                        : 'chevron-right'
                                                    }
                                                    size={12}
                                                    color={
                                                      lvlExpanded ? '#f59e0b' : colors.textMuted
                                                    }
                                                  />
                                                  <View style={{ flex: 1, gap: 2 }}>
                                                    <View
                                                      style={{
                                                        flexDirection: 'row',
                                                        alignItems: 'center',
                                                        gap: 5,
                                                      }}
                                                    >
                                                      <View
                                                        style={{
                                                          flexDirection: 'row',
                                                          alignItems: 'center',
                                                          gap: 3,
                                                          backgroundColor:
                                                            'rgba(245, 158, 11, 0.14)',
                                                          borderWidth: 1,
                                                          borderColor: 'rgba(245, 158, 11, 0.35)',
                                                          paddingHorizontal: 5,
                                                          paddingVertical: 1.5,
                                                          borderRadius: 5,
                                                        }}
                                                      >
                                                        <Feather
                                                          name="layers"
                                                          size={9}
                                                          color="#f59e0b"
                                                        />
                                                        <Text
                                                          style={{
                                                            fontSize: 9,
                                                            fontWeight: '800',
                                                            color: '#f59e0b',
                                                          }}
                                                          numberOfLines={1}
                                                        >
                                                          {lvl.name}
                                                        </Text>
                                                      </View>
                                                      <Text
                                                        style={{
                                                          fontSize: 10,
                                                          fontWeight: '800',
                                                          color: '#f59e0b',
                                                          flex: 1,
                                                        }}
                                                        numberOfLines={1}
                                                      >
                                                        {lvl.stats.totalQty.toLocaleString('vi-VN')}{' '}
                                                        {lvl.stats.unit || summaryStats.unit}
                                                      </Text>
                                                    </View>

                                                    <Text
                                                      style={{
                                                        fontSize: 9,
                                                        fontWeight: '600',
                                                        color: colors.textMuted,
                                                      }}
                                                    >
                                                      {lvl.stats.total} vị trí •{' '}
                                                      {lvl.stats.pending > 0
                                                        ? `Còn hạ ${lvl.stats.pending}`
                                                        : 'Đã hạ đủ'}
                                                    </Text>
                                                  </View>
                                                </TouchableOpacity>

                                                {lvl.stats.pending > 0 && onHaSanhAll ? (
                                                  <TouchableOpacity
                                                    onPress={() => {
                                                      const pendingItems = lvlExportPositions
                                                        .filter(
                                                          x =>
                                                            x.match.display_status !==
                                                            'Moved to Hall'
                                                        )
                                                        .map(x => x.match);
                                                      if (pendingItems.length > 0) {
                                                        onHaSanhAll(pendingItems);
                                                      }
                                                    }}
                                                    style={{
                                                      backgroundColor: '#2563eb',
                                                      paddingHorizontal: 9,
                                                      borderRadius: 8,
                                                      alignItems: 'center',
                                                      justifyContent: 'center',
                                                    }}
                                                  >
                                                    <Text
                                                      style={{
                                                        color: '#ffffff',
                                                        fontSize: 10,
                                                        fontWeight: '800',
                                                      }}
                                                    >
                                                      Hạ hết ({lvl.stats.pending})
                                                    </Text>
                                                  </TouchableOpacity>
                                                ) : (
                                                  <View style={{ justifyContent: 'center', paddingHorizontal: 4 }}>
                                                    <Text
                                                      style={{
                                                        fontSize: 9,
                                                        fontWeight: '800',
                                                        color: '#10b981',
                                                      }}
                                                    >
                                                      Đã hạ xong
                                                    </Text>
                                                  </View>
                                                )}
                                              </View>

                                              {/* Danh sách TẤT CẢ vị trí trong Tầng (ô không thuộc lệnh ghi KHÔNG LẤY) */}
                                              {lvlExpanded && lvl.positions.length > 0 && (
                                                <View
                                                  style={{
                                                    paddingHorizontal: 7,
                                                    paddingBottom: 7,
                                                    gap: 5,
                                                  }}
                                                >
                                                  {lvl.positions.map(pos => {
                                                    const match =
                                                      taskItemByPos.get(pos.id) ||
                                                      (pos.code
                                                        ? taskItemByPos.get(pos.code.toUpperCase())
                                                        : undefined);

                                                    if (!match) {
                                                      return (
                                                        <View
                                                          key={pos.id}
                                                          style={{
                                                            flexDirection: 'row',
                                                            alignItems: 'center',
                                                            justifyContent: 'space-between',
                                                            paddingHorizontal: 7,
                                                            paddingVertical: 6,
                                                            borderRadius: 8,
                                                            borderWidth: 1,
                                                            borderStyle: 'dashed',
                                                            borderColor: colors.border,
                                                            backgroundColor: isDark
                                                              ? 'rgba(2, 6, 23, 0.35)'
                                                              : '#f8fafc',
                                                            opacity: 0.78,
                                                            gap: 6,
                                                          }}
                                                        >
                                                          <View
                                                            style={{
                                                              flexDirection: 'row',
                                                              alignItems: 'center',
                                                              gap: 4,
                                                            }}
                                                          >
                                                            <Feather
                                                              name="map-pin"
                                                              size={10}
                                                              color={colors.textMuted}
                                                            />
                                                            <Text
                                                              style={{
                                                                fontSize: 10,
                                                                fontWeight: '700',
                                                                color: colors.textMuted,
                                                              }}
                                                            >
                                                              {pos.code}
                                                            </Text>
                                                          </View>

                                                          <View
                                                            style={{
                                                              flexDirection: 'row',
                                                              alignItems: 'center',
                                                              gap: 3,
                                                              paddingHorizontal: 6,
                                                              paddingVertical: 2,
                                                              borderRadius: 5,
                                                              backgroundColor: isDark
                                                                ? 'rgba(244, 63, 94, 0.16)'
                                                                : '#fff1f2',
                                                              borderWidth: 1,
                                                              borderColor: isDark
                                                                ? 'rgba(244, 63, 94, 0.35)'
                                                                : '#fecdd3',
                                                            }}
                                                          >
                                                            <Feather name="x" size={9} color="#f43f5e" />
                                                            <Text
                                                              style={{
                                                                fontSize: 9,
                                                                fontWeight: '800',
                                                                color: '#f43f5e',
                                                              }}
                                                            >
                                                              KHÔNG LẤY
                                                            </Text>
                                                          </View>
                                                        </View>
                                                      );
                                                    }

                                                    const isMoved =
                                                      match.display_status === 'Moved to Hall';
                                                    const sttLabel =
                                                      formatStt(match.lot_stt) ||
                                                      (pos.stt ? String(pos.stt) : null);
                                                    const displayTags: string[] =
                                                      match.tags && match.tags.length > 0
                                                        ? match.tags
                                                        : Array.isArray(pos.tags)
                                                          ? pos.tags
                                                          : [];

                                                    return (
                                                      <View
                                                        key={pos.id}
                                                        style={{
                                                          paddingHorizontal: 7,
                                                          paddingVertical: 6,
                                                          borderRadius: 8,
                                                          borderWidth: 1,
                                                          borderColor: colors.border,
                                                          backgroundColor: isDark
                                                            ? 'rgba(2, 6, 23, 0.7)'
                                                            : '#f8fafc',
                                                          gap: 3,
                                                        }}
                                                      >
                                                        <View
                                                          style={{
                                                            flexDirection: 'row',
                                                            alignItems: 'center',
                                                            justifyContent: 'space-between',
                                                            gap: 4,
                                                          }}
                                                        >
                                                          <View
                                                            style={{
                                                              flexDirection: 'row',
                                                              alignItems: 'center',
                                                              gap: 3,
                                                              flex: 1,
                                                            }}
                                                          >
                                                            <Feather
                                                              name="map-pin"
                                                              size={10}
                                                              color="#38bdf8"
                                                            />
                                                            <Text
                                                              style={{
                                                                fontSize: 10,
                                                                fontWeight: '800',
                                                                color: '#38bdf8',
                                                              }}
                                                              numberOfLines={1}
                                                            >
                                                              {pos.code}
                                                            </Text>
                                                            {sttLabel && (
                                                              <View style={styles.sttTag}>
                                                                <Text style={styles.sttTagText}>
                                                                  #{sttLabel}
                                                                </Text>
                                                              </View>
                                                            )}
                                                          </View>

                                                          <View
                                                            style={{
                                                              flexDirection: 'row',
                                                              alignItems: 'center',
                                                              gap: 5,
                                                            }}
                                                          >
                                                            <Text
                                                              style={{
                                                                fontSize: 10,
                                                                fontWeight: '800',
                                                                color: '#10b981',
                                                              }}
                                                              numberOfLines={1}
                                                            >
                                                              {match.quantity ?? 0}{' '}
                                                              {match.unit || 'Thùng'}
                                                            </Text>
                                                            {!isMoved ? (
                                                              <TouchableOpacity
                                                                onPress={() => onHaSanh(match)}
                                                                style={[
                                                                  styles.cellHaSanhSingleBtn,
                                                                  { paddingHorizontal: 6, paddingVertical: 2.5 },
                                                                ]}
                                                              >
                                                                <Text style={[styles.cellHaSanhSingleBtnText, { fontSize: 9 }]}>
                                                                  Hạ sảnh
                                                                </Text>
                                                              </TouchableOpacity>
                                                            ) : (
                                                              <View style={styles.cellDoneBadge}>
                                                                <Text
                                                                  style={{
                                                                    fontSize: 8,
                                                                    fontWeight: '800',
                                                                    color: '#10b981',
                                                                  }}
                                                                >
                                                                  Ở sảnh
                                                                </Text>
                                                              </View>
                                                            )}
                                                          </View>
                                                        </View>

                                                        <Text
                                                          style={{
                                                            fontSize: 10,
                                                            fontWeight: '600',
                                                            color: colors.textSecondary,
                                                            lineHeight: 14,
                                                            paddingLeft: 13,
                                                          }}
                                                        >
                                                          {match.product_name || 'Sản phẩm'}
                                                          {displayTags.map((tag, tIdx) => (
                                                            <Text
                                                              key={`${tag}-${tIdx}`}
                                                              style={{
                                                                fontSize: 8.5,
                                                                fontWeight: '800',
                                                                color: isDark
                                                                  ? '#c4b5fd'
                                                                  : '#6d28d9',
                                                              }}
                                                            >
                                                              {`  [${tag}]`}
                                                            </Text>
                                                          ))}
                                                        </Text>
                                                      </View>
                                                    );
                                                  })}
                                                </View>
                                              )}
                                            </View>
                                          );
                                        })}
                                      </View>
                                    )}
                                  </View>
                                );
                              })}
                            </View>
                          )}
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>
            );
          })}

          {/* LOT chưa rõ vị trí trên sơ đồ */}
          {unmappedTaskItems.length > 0 && (
            <View
              style={[
                styles.unmappedBox,
                { backgroundColor: colors.surface, borderColor: colors.border },
              ]}
            >
              <Text style={{ fontSize: 12, fontWeight: '800', color: '#f59e0b', marginBottom: 8 }}>
                Chưa định vị được trên sơ đồ ({unmappedTaskItems.length} LOT)
              </Text>
              {unmappedTaskItems.map(item => {
                const isMoved = item.display_status === 'Moved to Hall';
                return (
                  <View
                    key={item.id}
                    style={[styles.unmappedRow, { borderTopColor: colors.border }]}
                  >
                    <View style={{ flex: 1, paddingRight: 8 }}>
                      <Text style={[styles.lotCodeSmall, { color: colors.text }]}>
                        {item.position_code || 'N/A'}{' '}
                        {formatStt(item.lot_stt) ? `#${formatStt(item.lot_stt)}` : ''}
                      </Text>
                      <Text style={{ fontSize: 11, color: colors.textMuted }}>
                        {item.product_name}
                      </Text>
                    </View>
                    {!isMoved ? (
                      <TouchableOpacity
                        onPress={() => onHaSanh(item)}
                        style={styles.cellHaSanhBtn}
                      >
                        <Text style={styles.cellHaSanhBtnText}>Hạ sảnh</Text>
                      </TouchableOpacity>
                    ) : (
                      <Text style={{ fontSize: 11, fontWeight: '800', color: '#10b981' }}>
                        Ở sảnh
                      </Text>
                    )}
                  </View>
                );
              })}
            </View>
          )}
        </View>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* TAB 2: SƠ ĐỒ VỊ TRÍ (KHO -> DÃY -> Ô -> TẦNG & LƯỚI VỊ TRÍ)        */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {subTab === 'map' && (
        <View>
          {/* Breadcrumb Kho > Dãy > Ô */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ marginBottom: 10 }}
            contentContainerStyle={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
          >
            <TouchableOpacity
              onPress={() => {
                setSelectedWhId(null);
                setSelectedAisleId(null);
                setSelectedBinId(null);
              }}
              style={[
                styles.crumbChip,
                {
                  backgroundColor: !selectedWhId ? '#059669' : colors.surface,
                  borderColor: !selectedWhId ? '#10b981' : colors.border,
                },
              ]}
            >
              <Ionicons
                name="business"
                size={12}
                color={!selectedWhId ? '#ffffff' : colors.textSecondary}
              />
              <Text
                style={[
                  styles.crumbText,
                  { color: !selectedWhId ? '#ffffff' : colors.textSecondary },
                ]}
              >
                Tất cả Kho ({rootWarehouses.length})
              </Text>
            </TouchableOpacity>

            {selectedWh && (
              <>
                <Feather name="chevron-right" size={14} color={colors.textMuted} />
                <TouchableOpacity
                  onPress={() => {
                    setSelectedAisleId(null);
                    setSelectedBinId(null);
                  }}
                  style={[
                    styles.crumbChip,
                    {
                      backgroundColor: selectedWhId && !selectedAisleId ? '#059669' : colors.surface,
                      borderColor: selectedWhId && !selectedAisleId ? '#10b981' : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.crumbText,
                      { color: selectedWhId && !selectedAisleId ? '#ffffff' : colors.textSecondary },
                    ]}
                  >
                    {selectedWh.name}
                  </Text>
                </TouchableOpacity>
              </>
            )}

            {selectedAisle && (
              <>
                <Feather name="chevron-right" size={14} color={colors.textMuted} />
                <TouchableOpacity
                  onPress={() => setSelectedBinId(null)}
                  style={[
                    styles.crumbChip,
                    {
                      backgroundColor: selectedAisleId && !selectedBinId ? '#059669' : colors.surface,
                      borderColor: selectedAisleId && !selectedBinId ? '#10b981' : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.crumbText,
                      { color: selectedAisleId && !selectedBinId ? '#ffffff' : colors.textSecondary },
                    ]}
                  >
                    {selectedAisle.name}
                  </Text>
                </TouchableOpacity>
              </>
            )}

            {selectedBin && (
              <>
                <Feather name="chevron-right" size={14} color={colors.textMuted} />
                <View style={[styles.crumbChip, { backgroundColor: '#059669', borderColor: '#10b981' }]}>
                  <Text style={[styles.crumbText, { color: '#ffffff' }]}>{selectedBin.name}</Text>
                </View>
              </>
            )}
          </ScrollView>

          {/* CẤP 1: CHỌN KHO */}
          {!selectedWhId && (
            <View style={styles.grid2}>
              {rootWarehouses.map(wh => {
                const st = zoneExportStats.get(wh.id) || {
                  total: 0,
                  pending: 0,
                  moved: 0,
                  totalQty: 0,
                  unit: '',
                };
                const isAllDone = st.total > 0 && st.pending === 0;
                return (
                  <TouchableOpacity
                    key={wh.id}
                    activeOpacity={0.78}
                    onPress={() => setSelectedWhId(wh.id)}
                    style={[
                      styles.zoneCard2,
                      {
                        backgroundColor: colors.surface,
                        borderColor: isAllDone ? 'rgba(16, 185, 129, 0.5)' : colors.border,
                      },
                    ]}
                  >
                    <View style={styles.zoneCardTop}>
                      <View style={styles.whIconBox}>
                        <Ionicons name="business" size={15} color="#10b981" />
                      </View>
                      <View
                        style={[
                          styles.countPill,
                          {
                            backgroundColor: isAllDone
                              ? 'rgba(16, 185, 129, 0.16)'
                              : 'rgba(59, 130, 246, 0.15)',
                          },
                        ]}
                      >
                        <Text
                          style={{
                            fontSize: 10,
                            fontWeight: '800',
                            color: isAllDone ? '#10b981' : '#3b82f6',
                          }}
                        >
                          {st.moved}/{st.total} hạ
                        </Text>
                      </View>
                    </View>
                    <Text style={[styles.zoneCardTitle, { color: colors.text }]} numberOfLines={1}>
                      {wh.name}
                    </Text>
                    <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 2 }}>
                      Còn <Text style={{ color: '#f59e0b', fontWeight: '800' }}>{st.pending}</Text> LOT cần lấy
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* CẤP 2: CHỌN DÃY */}
          {selectedWhId && !selectedAisleId && (
            <View>
              <TouchableOpacity
                onPress={() => setSelectedWhId(null)}
                style={styles.backLinkRow}
              >
                <Feather name="arrow-left" size={14} color="#10b981" />
                <Text style={styles.backLinkText}>Quay lại danh sách Kho</Text>
              </TouchableOpacity>

              <View style={styles.grid2}>
                {activeAisles.map(aisle => {
                  const st = zoneExportStats.get(aisle.id) || {
                    total: 0,
                    pending: 0,
                    moved: 0,
                    totalQty: 0,
                    unit: '',
                  };
                  const isAllDone = st.total > 0 && st.pending === 0;
                  return (
                    <TouchableOpacity
                      key={aisle.id}
                      activeOpacity={0.78}
                      onPress={() => setSelectedAisleId(aisle.id)}
                      style={[
                        styles.zoneCard2,
                        {
                          backgroundColor: colors.surface,
                          borderColor: isAllDone ? 'rgba(16, 185, 129, 0.5)' : colors.border,
                        },
                      ]}
                    >
                      <View style={styles.zoneCardTop}>
                        <Text
                          style={[styles.zoneCardTitle, { color: colors.text, flex: 1 }]}
                          numberOfLines={1}
                        >
                          {aisle.name}
                        </Text>
                        <View
                          style={[
                            styles.countPill,
                            {
                              backgroundColor: isAllDone
                                ? 'rgba(16, 185, 129, 0.16)'
                                : 'rgba(59, 130, 246, 0.15)',
                            },
                          ]}
                        >
                          <Text
                            style={{
                              fontSize: 10,
                              fontWeight: '800',
                              color: isAllDone ? '#10b981' : '#3b82f6',
                            }}
                          >
                            {st.moved}/{st.total}
                          </Text>
                        </View>
                      </View>
                      <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>
                        {st.pending > 0 ? (
                          <>
                            Cần lấy:{' '}
                            <Text style={{ color: '#f59e0b', fontWeight: '800' }}>
                              {st.pending} LOT
                            </Text>
                          </>
                        ) : (
                          <Text style={{ color: '#10b981', fontWeight: '700' }}>Đã hạ hết dãy</Text>
                        )}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}

          {/* CẤP 3: CHỌN Ô KỆ */}
          {selectedWhId && selectedAisleId && !selectedBinId && (
            <View>
              <TouchableOpacity
                onPress={() => setSelectedAisleId(null)}
                style={styles.backLinkRow}
              >
                <Feather name="arrow-left" size={14} color="#10b981" />
                <Text style={styles.backLinkText}>Quay lại danh sách Dãy</Text>
              </TouchableOpacity>

              <View style={styles.grid3}>
                {activeBins.map(bin => {
                  const st = zoneExportStats.get(bin.id) || {
                    total: 0,
                    pending: 0,
                    moved: 0,
                    totalQty: 0,
                    unit: '',
                  };
                  const isAllDone = st.total > 0 && st.pending === 0;
                  return (
                    <TouchableOpacity
                      key={bin.id}
                      activeOpacity={0.78}
                      onPress={() => setSelectedBinId(bin.id)}
                      style={[
                        styles.binCard3,
                        {
                          backgroundColor: colors.surface,
                          borderColor: isAllDone ? 'rgba(16, 185, 129, 0.5)' : colors.border,
                        },
                      ]}
                    >
                      <Text style={[styles.binCardTitle, { color: colors.text }]}>{bin.name}</Text>
                      <Text
                        style={{
                          fontSize: 11,
                          fontWeight: '800',
                          marginTop: 4,
                          color: isAllDone ? '#10b981' : '#f59e0b',
                        }}
                      >
                        {st.moved}/{st.total} LOT
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}

          {/* CẤP 4: CHI TIẾT TỪNG TẦNG & Ô VỊ TRÍ */}
          {selectedWhId && selectedAisleId && selectedBinId && (
            <View>
              <View style={styles.binTopBar}>
                <TouchableOpacity
                  onPress={() => setSelectedBinId(null)}
                  style={styles.backLinkRowNoMargin}
                >
                  <Feather name="arrow-left" size={14} color="#10b981" />
                  <Text style={styles.backLinkText}>Quay lại Ô kệ</Text>
                </TouchableOpacity>
                <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textMuted }}>
                  {totalPositionsInBin} vị trí
                </Text>
              </View>

              {/* Thanh lọc nhanh Tầng */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginBottom: 10 }}
                contentContainerStyle={{ gap: 6 }}
              >
                <TouchableOpacity
                  onPress={() => setActiveLevelFilter('ALL')}
                  style={[
                    styles.levelPill,
                    {
                      backgroundColor: activeLevelFilter === 'ALL' ? '#059669' : colors.surface,
                      borderColor: activeLevelFilter === 'ALL' ? '#10b981' : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={{
                      fontSize: 11,
                      fontWeight: '800',
                      color: activeLevelFilter === 'ALL' ? '#ffffff' : colors.textSecondary,
                    }}
                  >
                    Tất cả tầng ({totalPositionsInBin})
                  </Text>
                </TouchableOpacity>

                {activeLevels.map(lvl => {
                  const isAct = activeLevelFilter === lvl.id;
                  return (
                    <TouchableOpacity
                      key={lvl.id}
                      onPress={() => {
                        setActiveLevelFilter(lvl.id);
                        setExpandedLevels(prev => ({ ...prev, [lvl.id]: true }));
                      }}
                      style={[
                        styles.levelPill,
                        {
                          backgroundColor: isAct ? '#059669' : 'rgba(59, 130, 246, 0.14)',
                          borderColor: isAct ? '#10b981' : 'rgba(59, 130, 246, 0.45)',
                        },
                      ]}
                    >
                      <Text
                        style={{
                          fontSize: 11,
                          fontWeight: '800',
                          color: isAct ? '#ffffff' : '#3b82f6',
                        }}
                      >
                        {lvl.name} ({lvl.stats.total}/{lvl.positions.length})
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              {/* Thanh Mở tất cả / Thu tất cả */}
              <View style={styles.levelActionBar}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textMuted }}>
                  Chi tiết theo tầng ({activeLevels.length} tầng):
                </Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <TouchableOpacity
                    onPress={() => toggleAllLevels(true)}
                    style={[
                      styles.smallActionBtn,
                      { backgroundColor: colors.surface, borderColor: colors.border },
                    ]}
                  >
                    <Text style={{ fontSize: 11, fontWeight: '800', color: '#10b981' }}>
                      + Mở tất cả
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => toggleAllLevels(false)}
                    style={[
                      styles.smallActionBtn,
                      { backgroundColor: colors.surface, borderColor: colors.border },
                    ]}
                  >
                    <Text style={{ fontSize: 11, fontWeight: '800', color: colors.textSecondary }}>
                      − Thu tất cả
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Danh sách từng Tầng */}
              {displayedLevels.map(lvl => {
                const isExpanded = Boolean(expandedLevels[lvl.id]);
                const hasExportInLevel = lvl.stats.total > 0;

                return (
                  <View
                    key={lvl.id}
                    style={[
                      styles.levelCard,
                      {
                        backgroundColor: colors.surface,
                        borderColor: hasExportInLevel ? 'rgba(16, 185, 129, 0.5)' : colors.border,
                      },
                    ]}
                  >
                    <View style={styles.levelHeader}>
                      <TouchableOpacity
                        activeOpacity={0.75}
                        onPress={() =>
                          setExpandedLevels(prev => ({ ...prev, [lvl.id]: !prev[lvl.id] }))
                        }
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1 }}
                      >
                        <Feather
                          name={isExpanded ? 'chevron-down' : 'chevron-right'}
                          size={16}
                          color={hasExportInLevel ? '#10b981' : colors.textMuted}
                        />
                        <View
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: 4,
                            backgroundColor: lvl.stats.pending > 0 ? '#f59e0b' : '#10b981',
                          }}
                        />
                        <Text style={[styles.levelNameText, { color: colors.text }]}>
                          {lvl.name}
                        </Text>
                        <Text style={{ fontSize: 11, color: colors.textMuted }}>
                          ({lvl.stats.total}/{lvl.positions.length})
                        </Text>
                      </TouchableOpacity>

                      {lvl.stats.pending > 0 && onHaSanhAll ? (
                        <TouchableOpacity
                          onPress={() => {
                            const pendingItems = lvl.positions
                              .map(
                                p =>
                                  taskItemByPos.get(p.id) ||
                                  (p.code ? taskItemByPos.get(p.code.toUpperCase()) : undefined)
                              )
                              .filter(
                                (m): m is WorkExportTaskItem =>
                                  Boolean(m && m.display_status !== 'Moved to Hall')
                              );
                            if (pendingItems.length > 0) {
                              onHaSanhAll(pendingItems);
                            }
                          }}
                          style={styles.cellHaSanhBtn}
                        >
                          <Text style={styles.cellHaSanhBtnText}>
                            Hạ hết ({lvl.stats.pending})
                          </Text>
                        </TouchableOpacity>
                      ) : (
                        <Text
                          style={{
                            fontSize: 11,
                            fontWeight: '800',
                            color: lvl.stats.pending > 0 ? '#f59e0b' : '#10b981',
                          }}
                        >
                          {lvl.stats.pending > 0 ? `Cần hạ ${lvl.stats.pending}` : 'Đã hạ xong'}
                        </Text>
                      )}
                    </View>

                    {isExpanded && (
                      <View style={styles.posGrid2}>
                        {lvl.positions.map(pos => {
                          const match =
                            taskItemByPos.get(pos.id) ||
                            (pos.code ? taskItemByPos.get(pos.code.toUpperCase()) : undefined);

                          if (!match) {
                            return (
                              <View
                                key={pos.id}
                                style={[
                                  styles.posCellEmpty,
                                  {
                                    backgroundColor: isDark ? 'rgba(15, 23, 42, 0.45)' : '#f8fafc',
                                    borderColor: colors.border,
                                  },
                                ]}
                              >
                                <View style={styles.posCellTop}>
                                  <Text
                                    style={[styles.posCodeMono, { color: colors.textMuted }]}
                                    numberOfLines={1}
                                  >
                                    {pos.code}
                                  </Text>
                                  <View
                                    style={[
                                      styles.miniTag,
                                      {
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        gap: 2,
                                        backgroundColor: isDark
                                          ? 'rgba(244, 63, 94, 0.16)'
                                          : '#fff1f2',
                                      },
                                    ]}
                                  >
                                    <Feather name="x" size={9} color="#f43f5e" />
                                    <Text
                                      style={{
                                        fontSize: 8,
                                        fontWeight: '800',
                                        color: '#f43f5e',
                                      }}
                                    >
                                      KHÔNG LẤY
                                    </Text>
                                  </View>
                                </View>
                                <View
                                  style={{
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    paddingVertical: 6,
                                    opacity: 0.45,
                                  }}
                                >
                                  <Feather name="x" size={20} color="#f43f5e" />
                                </View>
                              </View>
                            );
                          }

                          const isMoved = match.display_status === 'Moved to Hall';
                          const sttLabel =
                            formatStt(match.lot_stt) || (pos.stt ? String(pos.stt) : null);
                          const displayTags: string[] =
                            match.tags && match.tags.length > 0
                              ? match.tags
                              : Array.isArray(pos.tags)
                                ? pos.tags
                                : [];
                          const pBadge = getPriorityBadge(match.priority);

                          return (
                            <View
                              key={pos.id}
                              style={[
                                styles.posCellExport,
                                {
                                  backgroundColor: isMoved
                                    ? isDark
                                      ? 'rgba(16, 185, 129, 0.14)'
                                      : '#ecfdf5'
                                    : isDark
                                      ? 'rgba(37, 99, 235, 0.16)'
                                      : '#eff6ff',
                                  borderColor: isMoved ? '#10b981' : '#3b82f6',
                                },
                              ]}
                            >
                              {/* Dòng 1: Mã vị trí + Mã phụ (Tags) + STT LOT / Ưu tiên */}
                              <View style={[styles.posCellTop, { flexWrap: 'wrap' }]}>
                                <View
                                  style={{
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    flexWrap: 'wrap',
                                    gap: 3,
                                    flex: 1,
                                  }}
                                >
                                  <Text
                                    style={[styles.posCodeMono, { color: colors.text, flex: 0 }]}
                                    numberOfLines={1}
                                  >
                                    {pos.code}
                                  </Text>
                                  {displayTags.map((tag, tIdx) => (
                                    <View
                                      key={`${tag}-${tIdx}`}
                                      style={[
                                        styles.tagChip,
                                        {
                                          backgroundColor: isDark
                                            ? 'rgba(139, 92, 246, 0.22)'
                                            : '#f5f3ff',
                                          borderColor: isDark
                                            ? 'rgba(139, 92, 246, 0.4)'
                                            : '#ddd6fe',
                                        },
                                      ]}
                                    >
                                      <Text
                                        style={{
                                          fontSize: 8,
                                          lineHeight: 11,
                                          fontWeight: '700',
                                          color: isDark ? '#c4b5fd' : '#6d28d9',
                                        }}
                                      >
                                        {tag}
                                      </Text>
                                    </View>
                                  ))}
                                </View>

                                {(sttLabel || pBadge) && (
                                  <View style={{ flexDirection: 'row', gap: 3 }}>
                                    {sttLabel && (
                                      <View style={styles.sttTag}>
                                        <Text style={styles.sttTagText}>#{sttLabel}</Text>
                                      </View>
                                    )}
                                    {pBadge && (
                                      <View
                                        style={[
                                          styles.miniTag,
                                          {
                                            backgroundColor: pBadge.bg,
                                            borderWidth: 1,
                                            borderColor: pBadge.border,
                                          },
                                        ]}
                                      >
                                        <Text
                                          style={{
                                            fontSize: 8,
                                            fontWeight: '800',
                                            color: pBadge.color,
                                          }}
                                        >
                                          {pBadge.label}
                                        </Text>
                                      </View>
                                    )}
                                  </View>
                                )}
                              </View>

                              {/* Dòng 2: Tên sản phẩm đầy đủ */}
                              <Text style={[styles.prodNameSmall, { color: colors.text }]}>
                                {match.product_name || 'Sản phẩm'}
                              </Text>

                              {/* Dòng 3: Số lượng + ĐVT + Nút Hạ sảnh */}
                              <View style={styles.posCellBottom}>
                                <Text style={styles.qtySmall}>
                                  {match.quantity ?? 0} {match.unit || 'Thùng'}
                                </Text>

                                {!isMoved ? (
                                  <TouchableOpacity
                                    onPress={() => onHaSanh(match)}
                                    style={styles.cellHaSanhSingleBtn}
                                  >
                                    <Text style={styles.cellHaSanhSingleBtnText} numberOfLines={1}>
                                      Hạ sảnh
                                    </Text>
                                  </TouchableOpacity>
                                ) : (
                                  <View style={styles.cellDoneBadge}>
                                    <Feather name="check" size={9} color="#10b981" />
                                    <Text
                                      style={{ fontSize: 9, fontWeight: '800', color: '#10b981' }}
                                    >
                                      Ở sảnh
                                    </Text>
                                  </View>
                                )}
                              </View>
                            </View>
                          );
                        })}
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          )}
        </View>
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  subTabBar: {
    flexDirection: 'row',
    padding: 4,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 10,
    gap: 4,
  },
  subTabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: 10,
  },
  subTabText: {
    fontSize: 12,
    fontWeight: '800',
  },
  subTabBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
  },
  summaryCard: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 7,
  },
  summaryTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: '#f59e0b',
  },
  kpiRow: {
    flexDirection: 'row',
    gap: 6,
  },
  kpiBox: {
    flex: 1,
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderRadius: 9,
    borderWidth: 1,
    alignItems: 'center',
  },
  kpiLabel: {
    fontSize: 8,
    fontWeight: '700',
    color: '#94a3b8',
  },
  kpiValue: {
    fontSize: 14,
    fontWeight: '900',
    marginTop: 1,
  },
  kpiSub: {
    fontSize: 9,
    fontWeight: '600',
    color: '#94a3b8',
    marginTop: 0.5,
  },
  whAccordionCard: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  whAccordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  whCircleIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  whAccordionTitle: {
    fontSize: 14,
    fontWeight: '800',
    flex: 1,
  },
  jumpMapBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
  },
  aisleListWrap: {
    borderTopWidth: 1,
    padding: 8,
    gap: 6,
  },
  aisleCard: {
    borderRadius: 11,
    borderWidth: 1,
    overflow: 'hidden',
  },
  aisleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  jumpMapMiniBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 12,
  },
  binChipsRow: {
    borderTopWidth: 1,
    padding: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  binChipBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 9,
    borderWidth: 1,
  },
  crumbChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
  },
  crumbText: {
    fontSize: 11,
    fontWeight: '800',
  },
  grid2: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  zoneCard2: {
    width: '48.5%',
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  zoneCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  whIconBox: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  countPill: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 7,
  },
  zoneCardTitle: {
    fontSize: 14,
    fontWeight: '800',
  },
  backLinkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 10,
  },
  backLinkRowNoMargin: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  backLinkText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#10b981',
  },
  grid3: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  binCard3: {
    width: '31.5%',
    paddingVertical: 12,
    paddingHorizontal: 6,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  binCardTitle: {
    fontSize: 13,
    fontWeight: '800',
  },
  binTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  levelPill: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
  },
  levelActionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  smallActionBtn: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  levelCard: {
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 8,
    overflow: 'hidden',
  },
  levelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  levelNameText: {
    fontSize: 12,
    fontWeight: '800',
  },
  posGrid2: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  posCellEmpty: {
    width: '48.8%',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 9,
    borderWidth: 1,
    borderStyle: 'dashed',
    justifyContent: 'space-between',
  },
  posCellExport: {
    width: '48.8%',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 9,
    borderWidth: 1,
    justifyContent: 'space-between',
    gap: 2,
  },
  posCellTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 3,
  },
  posCodeMono: {
    fontSize: 10,
    fontWeight: '800',
    flex: 1,
  },
  miniTag: {
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
  },
  sttTag: {
    backgroundColor: 'rgba(245, 158, 11, 0.2)',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
  },
  sttTagText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#d97706',
  },
  lotCodeSmall: {
    fontSize: 9,
    fontWeight: '700',
    color: '#3b82f6',
  },
  prodNameSmall: {
    fontSize: 10,
    fontWeight: '600',
    lineHeight: 14,
  },
  tagChip: {
    paddingHorizontal: 4,
    paddingVertical: 0.5,
    borderRadius: 3,
    borderWidth: 1,
  },
  posCellBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
    paddingTop: 4,
    marginTop: 2,
    borderTopWidth: 1,
    borderTopColor: 'rgba(148, 163, 184, 0.2)',
  },
  qtySmall: {
    fontSize: 10,
    fontWeight: '800',
    color: '#0284c7',
    flex: 1,
  },
  cellHaSanhBtn: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  cellHaSanhBtnText: {
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '800',
  },
  cellHaSanhSingleBtn: {
    backgroundColor: '#f59e0b',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  cellHaSanhSingleBtnText: {
    color: '#0f172a',
    fontSize: 9,
    fontWeight: '900',
  },
  cellDoneBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: 'rgba(16, 185, 129, 0.16)',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
  },
  unmappedBox: {
    marginTop: 6,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  unmappedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderTopWidth: 1,
  },
});
