import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  deleteOperationImage,
  getOperationImageDisplayUrl,
  listSystemOperationImages,
  normalizeSearchText,
  OperationImageRecord,
  syncOfflineOperationImages,
} from '../../services/operationImagesService';
import { getWarehouseProducts, syncOperationsOfflineQueue } from '../../services/operationsService';

interface Props {
  visible: boolean;
  systemCode: string;
  companyId?: string | null;
  onClose: () => void;
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const GRID_ITEM_SIZE = Math.floor((SCREEN_WIDTH - 48) / 3);

function getDayInfo(capturedAt: string) {
  const dt = new Date(capturedAt);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return {
    monthKey: `${y}-${m}`,
    monthLabel: `Tháng ${m}/${y}`,
    dateKey: `${y}-${m}-${d}`,
    dateLabel: `${d}/${m}/${y}`,
  };
}

export default function WarehouseAlbumModal({ visible, systemCode, companyId, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [images, setImages] = useState<OperationImageRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [directionFilter, setDirectionFilter] = useState<'all' | 'in' | 'out' | 'shift'>('all');
  const [treeMode, setTreeMode] = useState<'date' | 'job'>('date');
  const [selectedJobKey, setSelectedJobKey] = useState<string | null>(null);
  const [selectedJobGroupKey, setSelectedJobGroupKey] = useState<string | null>(null);
  const [expandedMonths, setExpandedMonths] = useState<Record<string, boolean>>({});
  const [expandedDates, setExpandedDates] = useState<Record<string, boolean>>({});
  const [expandedTreeJobs, setExpandedTreeJobs] = useState<Record<string, boolean>>({});
  const [expandedJobNames, setExpandedJobNames] = useState<Record<string, boolean>>({});
  const [expandedRefAlbums, setExpandedRefAlbums] = useState<Record<string, boolean>>({});
  const [selectedImage, setSelectedImage] = useState<OperationImageRecord | null>(null);
  const [warehouseProducts, setWarehouseProducts] = useState<any[]>([]);
  const [skuToNameMap, setSkuToNameMap] = useState<Record<string, string>>({});
  const [nameToSkuMap, setNameToSkuMap] = useState<Record<string, string>>({});
  const [skuToMetaMap, setSkuToMetaMap] = useState<Record<string, string>>({});
  const [nameToMetaMap, setNameToMetaMap] = useState<Record<string, string>>({});

  const loadImages = useCallback(async () => {
    if (!systemCode) return;
    setLoading(true);
    try {
      await syncOperationsOfflineQueue().catch(() => { });
      await syncOfflineOperationImages().catch(() => { });
      const [list, products] = await Promise.all([
        listSystemOperationImages({ systemCode, companyId, limit: 300 }),
        getWarehouseProducts().catch(() => []),
      ]);
      setImages(list);
      setWarehouseProducts(products || []);

      const s2n: Record<string, string> = {};
      const n2s: Record<string, string> = {};
      const s2m: Record<string, string> = {};
      const n2m: Record<string, string> = {};
      for (const p of products || []) {
        const sku = (p.sku || '').trim();
        const name = (p.name || '').trim();
        const meta = [sku, name, (p as any).aliases, (p as any).internal_code, (p as any).internal_name]
          .filter(Boolean)
          .join(' ');
        if (sku) {
          if (name) s2n[sku.toLowerCase()] = name;
          s2m[sku.toLowerCase()] = meta;
        }
        if (name) {
          const nNorm = normalizeSearchText(name);
          if (sku) n2s[nNorm] = sku;
          n2m[nNorm] = meta;
        }
      }
      setSkuToNameMap(s2n);
      setNameToSkuMap(n2s);
      setSkuToMetaMap(s2m);
      setNameToMetaMap(n2m);
    } finally {
      setLoading(false);
    }
  }, [systemCode, companyId]);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      void loadImages();
    }, 0);
    return () => clearTimeout(timer);
  }, [visible, loadImages]);

  const filteredImages = useMemo(() => {
    const qNorm = normalizeSearchText(searchText);
    const tokens = qNorm ? qNorm.split(' ').filter(Boolean) : [];
    return images.filter((img) => {
      if (directionFilter === 'in' && img.direction !== 'in') return false;
      if (directionFilter === 'out' && img.direction !== 'out') return false;
      if (directionFilter === 'shift' && img.scope === 'journal') return false;
      if (tokens.length > 0) {
        const sku = img.item_sku?.trim() || (img.item_name ? nameToSkuMap[normalizeSearchText(img.item_name)] : '') || '';
        const resolvedName = sku ? skuToNameMap[sku.toLowerCase()] : '';
        const resolvedMeta =
          (sku ? skuToMetaMap[sku.toLowerCase()] : '') ||
          (img.item_name ? nameToMetaMap[normalizeSearchText(img.item_name)] : '') ||
          '';
        const dirWord = img.direction === 'in' ? 'nhap' : img.direction === 'out' ? 'xuat' : 'cong viec';
        const { dateLabel } = getDayInfo(img.captured_at);
        const hay = normalizeSearchText(
          [
            sku,
            resolvedName,
            resolvedMeta,
            img.item_name,
            img.job_name,
            img.captured_by_name,
            img.notes,
            img.quantity != null ? String(img.quantity) : '',
            img.unit,
            dirWord,
            dateLabel,
          ]
            .filter(Boolean)
            .join(' ')
        );
        if (!tokens.every((t) => hay.includes(t))) return false;
      }
      return true;
    });
  }, [images, searchText, directionFilter, skuToNameMap, nameToSkuMap, skuToMetaMap, nameToMetaMap]);

  const searchSuggestions = useMemo(() => {
    const qNorm = normalizeSearchText(searchText);
    if (!qNorm) return [];
    const tokens = qNorm.split(' ').filter(Boolean);

    const skuCounts: Record<string, number> = {};
    const nameCounts: Record<string, number> = {};
    const jobCounts: Record<string, number> = {};
    for (const img of images) {
      if (img.item_sku) {
        const k = normalizeSearchText(img.item_sku);
        skuCounts[k] = (skuCounts[k] || 0) + 1;
      }
      if (img.item_name) {
        const k = normalizeSearchText(img.item_name);
        nameCounts[k] = (nameCounts[k] || 0) + 1;
      }
      if (img.job_name) {
        jobCounts[img.job_name] = (jobCounts[img.job_name] || 0) + 1;
      }
    }

    type Suggestion = {
      kind: 'product' | 'job';
      key: string;
      value: string;
      title: string;
      sku?: string;
      aliases?: string;
      imageCount: number;
      score: number;
    };

    const results: Suggestion[] = [];
    for (const p of warehouseProducts) {
      const sku = (p.sku || '').trim();
      const name = (p.name || '').trim();
      if (!name) continue;
      const aliasesNorm = normalizeSearchText(p.aliases || '');
      const skuNorm = normalizeSearchText(sku);
      const internalNorm = normalizeSearchText(`${p.internal_code || ''} ${p.internal_name || ''}`);
      const nameNorm = normalizeSearchText(name);
      const fullNorm = `${aliasesNorm} ${skuNorm} ${internalNorm} ${nameNorm}`;
      if (!tokens.every((t) => fullNorm.includes(t))) continue;

      const imgCount = (skuNorm ? skuCounts[skuNorm] : 0) || nameCounts[nameNorm] || 0;
      let score = imgCount > 0 ? 10 : 0;
      if (aliasesNorm && tokens.every((t) => aliasesNorm.includes(t))) score += 50;
      if (aliasesNorm && aliasesNorm.startsWith(qNorm)) score += 30;
      if (skuNorm && tokens.every((t) => skuNorm.includes(t))) score += 20;

      results.push({
        kind: 'product',
        key: `p-${sku || name}`,
        value: name,
        title: name,
        sku: sku || undefined,
        aliases: p.aliases ? String(p.aliases).trim() : undefined,
        imageCount: imgCount,
        score,
      });
    }

    for (const [jobName, cnt] of Object.entries(jobCounts)) {
      const jNorm = normalizeSearchText(jobName);
      if (tokens.every((t) => jNorm.includes(t))) {
        results.push({
          kind: 'job',
          key: `j-${jobName}`,
          value: jobName,
          title: jobName,
          imageCount: cnt,
          score: 5 + cnt,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score || b.imageCount - a.imageCount).slice(0, 8);
  }, [searchText, warehouseProducts, images]);

  const parseRefPhase = (notes?: string | null): 'start' | 'end' | 'legacy' | null => {
    const m = notes?.match(/^\[THAM_CHIEU:([^\]:]+)(?::(start|end))?\]/);
    if (!m) return null;
    if (m[2] === 'start') return 'start';
    if (m[2] === 'end') return 'end';
    return 'legacy';
  };

  const folderTree = useMemo(() => {
    type RefSubGroup = { subKey: string; label: string; phase: 'start' | 'end' | 'legacy'; items: OperationImageRecord[] };
    type JobGroup = { jobKey: string; shiftId: string; jobName: string; dateLabel: string; items: OperationImageRecord[]; refSubs: Map<string, RefSubGroup> };
    type DateGroup = { dateKey: string; dateLabel: string; count: number; jobs: Map<string, JobGroup> };
    type MonthGroup = { monthKey: string; monthLabel: string; count: number; dates: Map<string, DateGroup> };

    const months = new Map<string, MonthGroup>();
    for (const img of filteredImages) {
      const { monthKey, monthLabel, dateKey, dateLabel } = getDayInfo(img.captured_at);
      const baseJobName = img.job_name || 'Công việc không tên';
      const jobKey = `${dateKey}::${img.shift_id}`;
      const refPhase = parseRefPhase(img.notes);

      let mNode = months.get(monthKey);
      if (!mNode) {
        mNode = { monthKey, monthLabel, count: 0, dates: new Map() };
        months.set(monthKey, mNode);
      }
      mNode.count++;

      let dNode = mNode.dates.get(dateKey);
      if (!dNode) {
        dNode = { dateKey, dateLabel, count: 0, jobs: new Map() };
        mNode.dates.set(dateKey, dNode);
      }
      dNode.count++;

      let jNode = dNode.jobs.get(jobKey);
      if (!jNode) {
        jNode = { jobKey, shiftId: img.shift_id, jobName: baseJobName, dateLabel, items: [], refSubs: new Map() };
        dNode.jobs.set(jobKey, jNode);
      }
      jNode.items.push(img);

      if (refPhase) {
        const refTag = refPhase === 'start' ? 'REF_START' : refPhase === 'end' ? 'REF_END' : 'REF';
        const subKey = `${jobKey}::${refTag}`;
        const label =
          refPhase === 'start'
            ? '📌 Tham chiếu Đầu'
            : refPhase === 'end'
              ? '📌 Tham chiếu Cuối'
              : '📌 Tham chiếu';
        let sNode = jNode.refSubs.get(subKey);
        if (!sNode) {
          sNode = { subKey, label, phase: refPhase, items: [] };
          jNode.refSubs.set(subKey, sNode);
        }
        sNode.items.push(img);
      }
    }

    const phaseOrder: Record<'start' | 'end' | 'legacy', number> = { start: 0, end: 1, legacy: 2 };
    return Array.from(months.values())
      .sort((a, b) => b.monthKey.localeCompare(a.monthKey))
      .map((m) => ({
        ...m,
        dates: Array.from(m.dates.values())
          .sort((a, b) => b.dateKey.localeCompare(a.dateKey))
          .map((d) => ({
            ...d,
            jobs: Array.from(d.jobs.values())
              .sort((a, b) => a.jobName.localeCompare(b.jobName))
              .map((j) => ({
                ...j,
                refSubs: Array.from(j.refSubs.values()).sort(
                  (a, b) => phaseOrder[a.phase] - phaseOrder[b.phase]
                ),
              })),
          })),
      }));
  }, [filteredImages]);

  const jobTree = useMemo(() => {
    type RefSubGroup = { subKey: string; label: string; phase: 'start' | 'end' | 'legacy'; items: OperationImageRecord[] };
    type JobDateGroup = { dateKey: string; dateLabel: string; items: OperationImageRecord[]; refSubs: Map<string, RefSubGroup> };
    type JobRootGroup = { jobName: string; count: number; latestDateKey: string; items: OperationImageRecord[]; dates: Map<string, JobDateGroup> };

    const jobs = new Map<string, JobRootGroup>();
    for (const img of filteredImages) {
      const { dateKey, dateLabel } = getDayInfo(img.captured_at);
      const jobName = img.job_name || 'Công việc không tên';
      const refPhase = parseRefPhase(img.notes);

      let jNode = jobs.get(jobName);
      if (!jNode) {
        jNode = { jobName, count: 0, latestDateKey: dateKey, items: [], dates: new Map() };
        jobs.set(jobName, jNode);
      }
      jNode.count++;
      jNode.items.push(img);
      if (dateKey > jNode.latestDateKey) jNode.latestDateKey = dateKey;

      let dNode = jNode.dates.get(dateKey);
      if (!dNode) {
        dNode = { dateKey, dateLabel, items: [], refSubs: new Map() };
        jNode.dates.set(dateKey, dNode);
      }
      dNode.items.push(img);

      if (refPhase) {
        const refTag = refPhase === 'start' ? 'REF_START' : refPhase === 'end' ? 'REF_END' : 'REF';
        const subKey = `${jobName}::${dateKey}::${refTag}`;
        const label =
          refPhase === 'start'
            ? '📌 Tham chiếu Đầu'
            : refPhase === 'end'
              ? '📌 Tham chiếu Cuối'
              : '📌 Tham chiếu';
        let sNode = dNode.refSubs.get(subKey);
        if (!sNode) {
          sNode = { subKey, label, phase: refPhase, items: [] };
          dNode.refSubs.set(subKey, sNode);
        }
        sNode.items.push(img);
      }
    }

    const phaseOrder: Record<'start' | 'end' | 'legacy', number> = { start: 0, end: 1, legacy: 2 };
    return Array.from(jobs.values())
      .sort((a, b) => b.latestDateKey.localeCompare(a.latestDateKey) || a.jobName.localeCompare(b.jobName))
      .map((j) => ({
        ...j,
        dates: Array.from(j.dates.values())
          .sort((a, b) => b.dateKey.localeCompare(a.dateKey))
          .map((d) => ({
            ...d,
            refSubs: Array.from(d.refSubs.values()).sort(
              (a, b) => phaseOrder[a.phase] - phaseOrder[b.phase]
            ),
          })),
      }));
  }, [filteredImages]);

  const selectedJobData = (() => {
    if (treeMode === 'job' && selectedJobGroupKey) {
      const parts = selectedJobGroupKey.split('::');
      if (parts.length >= 2) {
        const lastPart = parts[parts.length - 1];
        const hasRefTag = lastPart === 'REF_START' || lastPart === 'REF_END' || lastPart === 'REF';
        const dKey = hasRefTag ? parts[parts.length - 2] : lastPart;
        const jName = hasRefTag ? parts.slice(0, -2).join('::') : parts.slice(0, -1).join('::');
        const jNode = jobTree.find((j) => j.jobName === jName);
        const dNode = jNode?.dates.find((d) => d.dateKey === dKey);
        if (dNode) {
          if (hasRefTag) {
            const sub = dNode.refSubs.find((s) => s.subKey === selectedJobGroupKey);
            if (sub) {
              return { dateLabel: dNode.dateLabel, jobName: `${jName} › ${sub.label}`, items: sub.items, isDirectRef: true };
            }
          }
          return { dateLabel: dNode.dateLabel, jobName: jName, items: dNode.items, isDirectRef: false };
        }
      } else {
        const jNode = jobTree.find((j) => j.jobName === selectedJobGroupKey);
        if (jNode) {
          return { dateLabel: 'Tất cả ngày', jobName: jNode.jobName, items: jNode.items, isDirectRef: false };
        }
      }
      return null;
    }

    if (!selectedJobKey) return null;
    for (const m of folderTree) {
      for (const d of m.dates) {
        for (const j of d.jobs) {
          if (j.jobKey === selectedJobKey) {
            return { dateLabel: j.dateLabel, jobName: j.jobName, items: j.items, isDirectRef: false };
          }
          const sub = j.refSubs.find((s) => s.subKey === selectedJobKey);
          if (sub) {
            return { dateLabel: j.dateLabel, jobName: `${j.jobName} › ${sub.label}`, items: sub.items, isDirectRef: true };
          }
        }
      }
    }
    return null;
  })();

  const totalSynced = useMemo(
    () => filteredImages.filter((i) => !!i.drive_file_id && !i.is_offline).length,
    [filteredImages]
  );

  const handleDelete = (img: OperationImageRecord) => {
    Alert.alert('Xóa hình ảnh', 'Bạn chắc chắn muốn xóa hình ảnh chứng minh này?', [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Xóa',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteOperationImage(img);
            setSelectedImage(null);
            await loadImages();
          } catch (e: any) {
            Alert.alert('Lỗi', e?.message || 'Không thể xóa ảnh');
          }
        },
      },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.container, { paddingTop: Math.max(insets.top, 16), paddingBottom: insets.bottom + 8 }]}>
        {/* Header */}
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Thư Viện &amp; Thống Kê Ảnh</Text>
            <Text style={styles.subtitle}>
              Tổng: {filteredImages.length} ảnh • Đã lên Drive: {totalSynced}/{filteredImages.length}
            </Text>
          </View>
          <TouchableOpacity onPress={loadImages} style={styles.iconBtn}>
            <Ionicons name="refresh" size={20} color="#38bdf8" />
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose} style={styles.iconBtn}>
            <Ionicons name="close" size={22} color="#cbd5e1" />
          </TouchableOpacity>
        </View>

        {/* Tìm kiếm & Lọc */}
        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color="#94a3b8" />
          <TextInput
            style={styles.searchInput}
            placeholder="Tìm tên gõ tắt (alias), mã/tên SP, công việc, ngày..."
            placeholderTextColor="#64748b"
            value={searchText}
            onChangeText={(txt) => {
              setSearchText(txt);
              setSearchFocused(true);
            }}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setTimeout(() => setSearchFocused(false), 180)}
          />
          {searchText ? (
            <TouchableOpacity
              onPress={() => {
                setSearchText('');
                setSearchFocused(false);
              }}
            >
              <Ionicons name="close-circle" size={18} color="#64748b" />
            </TouchableOpacity>
          ) : null}
        </View>

        {searchFocused && searchText.trim().length > 0 && searchSuggestions.length > 0 && (
          <View style={styles.suggestionBox}>
            <Text style={styles.suggestionHeader}>
              Gợi ý sản phẩm / công việc ({searchSuggestions.length})
            </Text>
            <ScrollView style={{ maxHeight: 200 }} keyboardShouldPersistTaps="handled">
              {searchSuggestions.map((item) => (
                <TouchableOpacity
                  key={item.key}
                  style={styles.suggestionItem}
                  onPress={() => {
                    setSearchText(item.value);
                    setSearchFocused(false);
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <View style={styles.suggestionTopRow}>
                      <View
                        style={[
                          styles.suggestionKindBadge,
                          item.kind === 'job' && { backgroundColor: 'rgba(16, 185, 129, 0.2)' },
                        ]}
                      >
                        <Text
                          style={[
                            styles.suggestionKindText,
                            item.kind === 'job' && { color: '#34d399' },
                          ]}
                        >
                          {item.kind === 'product' ? 'SP' : 'CV'}
                        </Text>
                      </View>
                      {item.aliases ? (
                        <View style={styles.suggestionAliasBadge}>
                          <Text style={styles.suggestionAliasText}>{item.aliases}</Text>
                        </View>
                      ) : null}
                      <Text style={styles.suggestionTitle} numberOfLines={1}>
                        {item.title}
                      </Text>
                    </View>
                    {item.sku ? (
                      <Text style={styles.suggestionSub}>SKU: {item.sku}</Text>
                    ) : null}
                  </View>
                  {item.imageCount > 0 && (
                    <View style={styles.suggestionCount}>
                      <Text style={styles.suggestionCountText}>{item.imageCount} ảnh</Text>
                    </View>
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        <View style={styles.filterRow}>
          {[
            { key: 'all', label: 'Tất cả' },
            { key: 'in', label: 'Nhập' },
            { key: 'out', label: 'Xuất' },
            { key: 'shift', label: 'CV/Đợt' },
          ].map((f) => {
            const active = directionFilter === f.key;
            return (
              <TouchableOpacity
                key={f.key}
                onPress={() => setDirectionFilter(f.key as any)}
                style={[styles.filterChip, active && styles.filterChipActive]}
              >
                <Text style={[styles.filterText, active && styles.filterTextActive]}>{f.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.treeModeRow}>
          <TouchableOpacity
            style={[styles.treeModeBtn, treeMode === 'date' && styles.treeModeBtnActive]}
            onPress={() => {
              setTreeMode('date');
              setSelectedJobGroupKey(null);
            }}
          >
            <Ionicons name="calendar-outline" size={14} color={treeMode === 'date' ? '#38bdf8' : '#94a3b8'} />
            <Text style={[styles.treeModeText, treeMode === 'date' && styles.treeModeTextActive]}>
              Ngày → Công việc
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.treeModeBtn, treeMode === 'job' && styles.treeModeBtnActive]}
            onPress={() => {
              setTreeMode('job');
              setSelectedJobKey(null);
            }}
          >
            <Ionicons name="briefcase-outline" size={14} color={treeMode === 'job' ? '#34d399' : '#94a3b8'} />
            <Text style={[styles.treeModeText, treeMode === 'job' && { color: '#34d399' }]}>
              Công việc → Ngày
            </Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color="#38bdf8" />
            <Text style={{ color: '#94a3b8', marginTop: 8 }}>Đang tải cây thư mục ảnh...</Text>
          </View>
        ) : selectedJobData ? (
          /* Xem lưới ảnh của Ngày + Công việc đang chọn */
          <View style={{ flex: 1 }}>
            <TouchableOpacity
              onPress={() => {
                setSelectedJobKey(null);
                setSelectedJobGroupKey(null);
              }}
              style={styles.breadcrumbBar}
            >
              <Ionicons name="arrow-back" size={18} color="#38bdf8" />
              <Text style={styles.breadcrumbText}>
                {selectedJobData.dateLabel} › {selectedJobData.jobName} ({selectedJobData.items.length})
              </Text>
            </TouchableOpacity>

            <ScrollView contentContainerStyle={{ paddingBottom: 24, gap: 10 }}>
              {(() => {
                const renderGridItems = (list: OperationImageRecord[]) => (
                  <View style={styles.gridWrap}>
                    {list.map((item) => (
                      <TouchableOpacity
                        key={item.id}
                        style={styles.gridItem}
                        onPress={() => setSelectedImage(item)}
                        activeOpacity={0.85}
                      >
                        <Image source={{ uri: getOperationImageDisplayUrl(item) }} style={styles.gridImage} />
                        <View style={styles.badgeRow}>
                          {item.direction === 'in' && (
                            <View style={[styles.badge, { backgroundColor: '#10b981' }]}>
                              <Text style={styles.badgeText}>NHẬP</Text>
                            </View>
                          )}
                          {item.direction === 'out' && (
                            <View style={[styles.badge, { backgroundColor: '#f43f5e' }]}>
                              <Text style={styles.badgeText}>XUẤT</Text>
                            </View>
                          )}
                        </View>
                        {item.drive_file_id ? (
                          <View style={[styles.cloudTag, { backgroundColor: 'rgba(16,185,129,0.88)' }]}>
                            <Ionicons name="cloud-done" size={11} color="#fff" />
                          </View>
                        ) : item.is_offline ? (
                          <View style={styles.cloudTag}>
                            <Ionicons name="cloud-upload-outline" size={11} color="#fbbf24" />
                          </View>
                        ) : null}
                      </TouchableOpacity>
                    ))}
                  </View>
                );

                if (selectedJobData.isDirectRef) {
                  return renderGridItems(selectedJobData.items);
                }

                const regularItems: OperationImageRecord[] = [];
                const refStartItems: OperationImageRecord[] = [];
                const refEndItems: OperationImageRecord[] = [];
                const refLegacyItems: OperationImageRecord[] = [];
                for (const it of selectedJobData.items) {
                  const p = parseRefPhase(it.notes);
                  if (p === 'start') refStartItems.push(it);
                  else if (p === 'end') refEndItems.push(it);
                  else if (p === 'legacy') refLegacyItems.push(it);
                  else regularItems.push(it);
                }

                const refAlbums = [
                  { id: `${selectedJobKey || selectedJobGroupKey || 'job'}::REF_START`, title: '📌 Album Tham chiếu Đầu', items: refStartItems },
                  { id: `${selectedJobKey || selectedJobGroupKey || 'job'}::REF_END`, title: '📌 Album Tham chiếu Cuối', items: refEndItems },
                  { id: `${selectedJobKey || selectedJobGroupKey || 'job'}::REF`, title: '📌 Album Tham chiếu', items: refLegacyItems },
                ].filter((g) => g.items.length > 0);

                return (
                  <View style={{ gap: 10 }}>
                    {refAlbums.map((ra) => {
                      const isOpen = !!expandedRefAlbums[ra.id];
                      const cover = ra.items[0];
                      return (
                        <View
                          key={ra.id}
                          style={{
                            borderRadius: 12,
                            borderWidth: 1,
                            borderColor: 'rgba(251,191,36,0.35)',
                            backgroundColor: 'rgba(251,191,36,0.08)',
                            overflow: 'hidden',
                          }}
                        >
                          <TouchableOpacity
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10 }}
                            onPress={() =>
                              setExpandedRefAlbums((prev) => ({ ...prev, [ra.id]: !isOpen }))
                            }
                            activeOpacity={0.75}
                          >
                            {cover ? (
                              <Image
                                source={{ uri: getOperationImageDisplayUrl(cover) }}
                                style={{ width: 40, height: 40, borderRadius: 8, backgroundColor: '#1e293b' }}
                              />
                            ) : null}
                            <View style={{ flex: 1 }}>
                              <Text style={{ color: '#fde68a', fontSize: 13, fontWeight: '800' }}>{ra.title}</Text>
                              <Text style={{ color: '#cbd5e1', fontSize: 11 }}>
                                {ra.items.length} ảnh • Bấm để {isOpen ? 'thu gọn' : 'xem ảnh'}
                              </Text>
                            </View>
                            <Ionicons
                              name={isOpen ? 'chevron-up' : 'chevron-down'}
                              size={18}
                              color="#fbbf24"
                            />
                          </TouchableOpacity>
                          {isOpen && (
                            <View style={{ paddingHorizontal: 8, paddingBottom: 10 }}>
                              {renderGridItems(ra.items)}
                            </View>
                          )}
                        </View>
                      );
                    })}

                    {regularItems.length > 0 && renderGridItems(regularItems)}
                  </View>
                );
              })()}
            </ScrollView>
          </View>
        ) : treeMode === 'job' ? (
          jobTree.length === 0 ? (
            <View style={styles.centerBox}>
              <Ionicons name="folder-open-outline" size={50} color="#475569" />
              <Text style={{ color: '#cbd5e1', fontWeight: '700', marginTop: 10 }}>
                Chưa có hình ảnh nào trong kho
              </Text>
            </View>
          ) : (
            /* Cây Thư Mục: Công việc -> Ngày */
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24, gap: 10 }}>
              {jobTree.map((jobNode, jIdx) => {
                const isJobOpen = expandedJobNames[jobNode.jobName] ?? jIdx === 0;
                return (
                  <View key={jobNode.jobName} style={styles.monthCard}>
                    <TouchableOpacity
                      style={styles.monthHeader}
                      onPress={() =>
                        setExpandedJobNames((prev) => ({ ...prev, [jobNode.jobName]: !isJobOpen }))
                      }
                    >
                      <Ionicons
                        name={isJobOpen ? 'chevron-down' : 'chevron-forward'}
                        size={18}
                        color="#94a3b8"
                      />
                      <Ionicons name="folder-open" size={18} color="#34d399" />
                      <Text style={styles.monthTitle}>
                        {jobNode.jobName}
                      </Text>
                      <TouchableOpacity
                        style={styles.countPill}
                        onPress={() => setSelectedJobGroupKey(jobNode.jobName)}
                      >
                        <Text style={styles.countPillText}>{jobNode.count} ảnh ›</Text>
                      </TouchableOpacity>
                    </TouchableOpacity>

                    {isJobOpen && (
                      <View style={styles.datesContainer}>
                        {jobNode.dates.map((dt) => (
                          <View key={`${jobNode.jobName}::${dt.dateKey}`} style={{ gap: 4 }}>
                            <TouchableOpacity
                              style={styles.jobRow}
                              onPress={() => setSelectedJobGroupKey(`${jobNode.jobName}::${dt.dateKey}`)}
                            >
                              <Ionicons name="calendar" size={15} color="#818cf8" />
                              <Text style={styles.jobTitle}>{dt.dateLabel}</Text>
                              <View style={styles.jobCountBadge}>
                                <Text style={styles.jobCountText}>{dt.items.length} ảnh</Text>
                              </View>
                              <Ionicons name="chevron-forward" size={16} color="#64748b" />
                            </TouchableOpacity>
                            {dt.refSubs.length > 0 && (
                              <View style={{ paddingLeft: 20, gap: 4 }}>
                                {dt.refSubs.map((sub) => (
                                  <TouchableOpacity
                                    key={sub.subKey}
                                    style={[styles.jobRow, { backgroundColor: 'rgba(251,191,36,0.08)', borderColor: 'rgba(251,191,36,0.28)' }]}
                                    onPress={() => setSelectedJobGroupKey(sub.subKey)}
                                  >
                                    <Text style={[styles.jobTitle, { color: '#fde68a' }]}>
                                      {sub.label}
                                    </Text>
                                    <View style={styles.jobCountBadge}>
                                      <Text style={styles.jobCountText}>{sub.items.length} ảnh</Text>
                                    </View>
                                    <Ionicons name="chevron-forward" size={16} color="#fbbf24" />
                                  </TouchableOpacity>
                                ))}
                              </View>
                            )}
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                );
              })}
            </ScrollView>
          )
        ) : folderTree.length === 0 ? (
          <View style={styles.centerBox}>
            <Ionicons name="folder-open-outline" size={50} color="#475569" />
            <Text style={{ color: '#cbd5e1', fontWeight: '700', marginTop: 10 }}>
              Chưa có hình ảnh nào trong kho
            </Text>
          </View>
        ) : (
          /* Cây Thư Mục: Tháng -> Ngày -> Công việc */
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24, gap: 10 }}>
            {folderTree.map((month, mIdx) => {
              const isMonthOpen = expandedMonths[month.monthKey] ?? mIdx === 0;
              return (
                <View key={month.monthKey} style={styles.monthCard}>
                  <TouchableOpacity
                    style={styles.monthHeader}
                    onPress={() =>
                      setExpandedMonths((prev) => ({ ...prev, [month.monthKey]: !isMonthOpen }))
                    }
                  >
                    <Ionicons
                      name={isMonthOpen ? 'chevron-down' : 'chevron-forward'}
                      size={18}
                      color="#94a3b8"
                    />
                    <Ionicons name="folder" size={18} color="#f59e0b" />
                    <Text style={styles.monthTitle}>{month.monthLabel}</Text>
                    <View style={styles.countPill}>
                      <Text style={styles.countPillText}>{month.count} ảnh</Text>
                    </View>
                  </TouchableOpacity>

                  {isMonthOpen && (
                    <View style={styles.datesContainer}>
                      {month.dates.map((dt, dIdx) => {
                        const isDateOpen = expandedDates[dt.dateKey] ?? (mIdx === 0 && dIdx === 0);
                        return (
                          <View key={dt.dateKey} style={styles.dateBlock}>
                            <TouchableOpacity
                              style={styles.dateHeader}
                              onPress={() =>
                                setExpandedDates((prev) => ({ ...prev, [dt.dateKey]: !isDateOpen }))
                              }
                            >
                              <Ionicons
                                name={isDateOpen ? 'chevron-down' : 'chevron-forward'}
                                size={16}
                                color="#94a3b8"
                              />
                              <Ionicons name="calendar" size={15} color="#818cf8" />
                              <Text style={styles.dateTitle}>{dt.dateLabel}</Text>
                              <Text style={styles.dateCount}>{dt.count} ảnh</Text>
                            </TouchableOpacity>

                            {isDateOpen && (
                              <View style={styles.jobsContainer}>
                                {dt.jobs.map((job) => {
                                  const hasRefs = job.refSubs.length > 0;
                                  const isJobExpanded = !!expandedTreeJobs[job.jobKey];
                                  return (
                                    <View key={job.jobKey} style={{ gap: 4 }}>
                                      <View style={styles.jobRow}>
                                        {hasRefs && (
                                          <TouchableOpacity
                                            onPress={() =>
                                              setExpandedTreeJobs((prev) => ({
                                                ...prev,
                                                [job.jobKey]: !isJobExpanded,
                                              }))
                                            }
                                            style={{ padding: 2 }}
                                          >
                                            <Ionicons
                                              name={isJobExpanded ? 'chevron-down' : 'chevron-forward'}
                                              size={15}
                                              color="#94a3b8"
                                            />
                                          </TouchableOpacity>
                                        )}
                                        <TouchableOpacity
                                          style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                                          onPress={() => {
                                            if (hasRefs && !isJobExpanded) {
                                              setExpandedTreeJobs((prev) => ({ ...prev, [job.jobKey]: true }));
                                            }
                                            setSelectedJobKey(job.jobKey);
                                          }}
                                        >
                                          <Ionicons name="folder-open" size={16} color="#34d399" />
                                          <Text style={styles.jobTitle}>
                                            {job.jobName}
                                          </Text>
                                          <View style={styles.jobCountBadge}>
                                            <Text style={styles.jobCountText}>{job.items.length} ảnh</Text>
                                          </View>
                                          <Ionicons name="chevron-forward" size={16} color="#64748b" />
                                        </TouchableOpacity>
                                      </View>
                                      {hasRefs && isJobExpanded && (
                                        <View style={{ paddingLeft: 20, gap: 4 }}>
                                          {job.refSubs.map((sub) => (
                                            <TouchableOpacity
                                              key={sub.subKey}
                                              style={[styles.jobRow, { backgroundColor: 'rgba(251,191,36,0.08)', borderColor: 'rgba(251,191,36,0.28)' }]}
                                              onPress={() => setSelectedJobKey(sub.subKey)}
                                            >
                                              <Text style={[styles.jobTitle, { color: '#fde68a' }]}>
                                                {sub.label}
                                              </Text>
                                              <View style={styles.jobCountBadge}>
                                                <Text style={styles.jobCountText}>{sub.items.length} ảnh</Text>
                                              </View>
                                              <Ionicons name="chevron-forward" size={16} color="#fbbf24" />
                                            </TouchableOpacity>
                                          ))}
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
          </ScrollView>
        )}

        {/* Viewer phóng to */}
        <Modal
          visible={!!selectedImage}
          transparent
          animationType="fade"
          onRequestClose={() => setSelectedImage(null)}
        >
          {selectedImage && (
            <View style={styles.viewerOverlay}>
              <View style={styles.viewerHeader}>
                <TouchableOpacity onPress={() => handleDelete(selectedImage)} style={styles.viewerDeleteBtn}>
                  <Ionicons name="trash-outline" size={20} color="#fda4af" />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setSelectedImage(null)} style={styles.viewerCloseBtn}>
                  <Ionicons name="close" size={24} color="#fff" />
                </TouchableOpacity>
              </View>
              <Image
                source={{ uri: getOperationImageDisplayUrl(selectedImage) }}
                style={styles.viewerImage}
                resizeMode="contain"
              />
              <View style={styles.viewerMeta}>
                <Text style={styles.viewerTitle}>
                  {selectedImage.item_name
                    ? `${selectedImage.item_name} — ${selectedImage.quantity ?? ''} ${selectedImage.unit || ''}`
                    : selectedImage.job_name || 'Ảnh công việc'}
                </Text>
                <Text style={styles.viewerSub}>
                  {selectedImage.captured_by_name || 'Nhân viên'} •{' '}
                  {new Date(selectedImage.captured_at).toLocaleString('vi-VN')}
                </Text>
                <Text style={[styles.viewerSub, { color: selectedImage.drive_file_id ? '#34d399' : '#fbbf24' }]}>
                  {selectedImage.drive_file_id ? '☁ Đã đồng bộ Google Drive' : '⏳ Chờ đồng bộ lên Google Drive'}
                </Text>
              </View>
            </View>
          )}
        </Modal>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    paddingHorizontal: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingBottom: 12,
  },
  title: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '800',
  },
  subtitle: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 2,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 40,
    gap: 8,
    marginBottom: 10,
  },
  searchInput: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 13,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  suggestionBox: {
    marginHorizontal: 14,
    marginBottom: 8,
    backgroundColor: '#1e293b',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#38bdf8',
    overflow: 'hidden',
  },
  suggestionHeader: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontSize: 11,
    fontWeight: '700',
    color: '#94a3b8',
    backgroundColor: '#0f172a',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  suggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  suggestionTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  suggestionKindBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: 'rgba(56, 189, 248, 0.2)',
  },
  suggestionKindText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#38bdf8',
  },
  suggestionAliasBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: 'rgba(245, 158, 11, 0.22)',
  },
  suggestionAliasText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#fbbf24',
  },
  suggestionTitle: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '700',
  },
  suggestionSub: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 2,
  },
  suggestionCount: {
    backgroundColor: '#0f172a',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  suggestionCountText: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '700',
  },
  filterChipActive: {
    backgroundColor: '#0284c7',
    borderColor: '#38bdf8',
  },
  treeModeRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  treeModeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  treeModeBtnActive: {
    backgroundColor: '#0f172a',
    borderColor: '#38bdf8',
  },
  treeModeText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
  },
  treeModeTextActive: {
    color: '#38bdf8',
  },
  filterText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
  },
  filterTextActive: {
    color: '#ffffff',
  },
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthCard: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#334155',
    overflow: 'hidden',
  },
  monthHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  monthTitle: {
    flex: 1,
    flexShrink: 1,
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '800',
  },
  countPill: {
    backgroundColor: '#0f172a',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  countPillText: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '700',
  },
  datesContainer: {
    borderTopWidth: 1,
    borderTopColor: '#334155',
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 6,
  },
  dateBlock: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  dateHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  dateTitle: {
    flex: 1,
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '700',
  },
  dateCount: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  jobsContainer: {
    marginTop: 4,
    paddingLeft: 14,
    gap: 6,
  },
  jobRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#1e293b',
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 8,
  },
  jobTitle: {
    flex: 1,
    flexShrink: 1,
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  jobCountBadge: {
    backgroundColor: 'rgba(16,185,129,0.16)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  jobCountText: {
    color: '#34d399',
    fontSize: 11,
    fontWeight: '700',
  },
  breadcrumbBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#1e293b',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    marginBottom: 12,
  },
  breadcrumbText: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '700',
  },
  gridWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingBottom: 24,
  },
  gridItem: {
    width: GRID_ITEM_SIZE,
    height: GRID_ITEM_SIZE,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#1e293b',
    position: 'relative',
  },
  gridImage: {
    width: '100%',
    height: '100%',
  },
  badgeRow: {
    position: 'absolute',
    left: 4,
    bottom: 4,
    flexDirection: 'row',
    gap: 4,
  },
  badge: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '800',
  },
  cloudTag: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: 'rgba(15,23,42,0.85)',
    padding: 4,
    borderRadius: 99,
  },
  viewerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.96)',
    justifyContent: 'space-between',
    paddingVertical: 40,
  },
  viewerHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    paddingHorizontal: 20,
  },
  viewerDeleteBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(244,63,94,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerCloseBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerImage: {
    width: '100%',
    height: '70%',
  },
  viewerMeta: {
    paddingHorizontal: 20,
    gap: 4,
  },
  viewerTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
  viewerSub: {
    color: '#94a3b8',
    fontSize: 12,
  },
});
