import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  SubmittedProposal,
  ProposalItem,
} from '../../services/warehouseAdjustmentService';
import {
  fetchProductsForSuggestions,
  ProductSuggestion,
} from '../../services/supabase';
import {
  matchSearch,
  calculateSearchScore,
  normalizeSearchString,
} from '../../utils/searchUtils';

interface WarehouseMovementHistoryViewProps {
  submittedList: SubmittedProposal[];
}

type MovementKind =
  | 'CLEAR'
  | 'CREATE_LOT'
  | 'ADD_TO_LOT'
  | 'INCREASE'
  | 'DECREASE'
  | 'UNCHANGED'
  | 'MOVE'
  | 'ASSIGN_LOT'
  | 'NOTE';

interface ActionTag {
  label: string;
  tone: 'emerald' | 'rose' | 'amber' | 'sky' | 'purple' | 'slate';
}

interface MovementEntry {
  key: string;
  proposal: SubmittedProposal;
  item: ProposalItem;
  timestamp: string;
  productName: string;
  sku: string | null;
  aliases: string | null;
  unit: string;
  beforeQty: number | null;
  afterQty: number | null;
  delta: number;
  changeKind: MovementKind;
}

function getTodayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function getLocalDateStr(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function shiftDateStr(dateStr: string, deltaDays: number): string {
  const base = dateStr ? new Date(`${dateStr}T12:00:00`) : new Date();
  base.setDate(base.getDate() + deltaDays);
  return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(
    base.getDate()
  ).padStart(2, '0')}`;
}

function formatDateVN(dateStr: string): string {
  if (!dateStr) return 'Tất cả';
  const [y, m, d] = dateStr.split('-');
  if (!y || !m || !d) return dateStr;
  return `${d}/${m}/${y}`;
}

function formatTimeVN(iso?: string | null): string {
  if (!iso) return '---';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '---';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(
    2,
    '0'
  )} - ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function normalizeUnitLabel(unit?: string | null): string {
  const raw = (unit || 'Thùng').trim();
  if (!raw) return 'Thùng';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function formatNumberVN(n: number): string {
  return Number.isInteger(n)
    ? n.toLocaleString('vi-VN')
    : Number(n.toFixed(2)).toLocaleString('vi-VN');
}

function formatUnitTotalsMap(map: Map<string, number>, prefix = ''): string {
  const entries = Array.from(map.entries()).filter(([, val]) => Math.abs(val) > 0.0001);
  if (entries.length === 0) return '0';
  return entries
    .map(([unit, val]) => {
      const sign = prefix === 'signed' ? (val > 0 ? '+' : '') : prefix;
      return `${sign}${formatNumberVN(val)} ${unit}`;
    })
    .join(' · ');
}

const TAG_PALETTE: Record<ActionTag['tone'], { bg: string; border: string; text: string }> = {
  rose: { bg: '#88133744', border: '#f43f5e66', text: '#fda4af' },
  emerald: { bg: '#064e3b55', border: '#10b98166', text: '#6ee7b7' },
  amber: { bg: '#78350f44', border: '#f59e0b66', text: '#fde68a' },
  sky: { bg: '#0c4a6e55', border: '#38bdf866', text: '#7dd3fc' },
  purple: { bg: '#581c8744', border: '#a855f766', text: '#d8b4fe' },
  slate: { bg: '#1e293b', border: '#475569', text: '#cbd5e1' },
};

export default function WarehouseMovementHistoryView({
  submittedList,
}: WarehouseMovementHistoryViewProps) {
  const todayStr = getTodayDateStr();
  const [dateFilter, setDateFilter] = useState<string>(todayStr);
  const [productQuery, setProductQuery] = useState<string>('');
  const [selectedProduct, setSelectedProduct] = useState<{
    name: string;
    sku: string | null;
  } | null>(null);
  const [showSuggestions, setShowSuggestions] = useState<boolean>(false);
  const [productCatalog, setProductCatalog] = useState<ProductSuggestion[]>([]);

  useEffect(() => {
    let mounted = true;
    fetchProductsForSuggestions()
      .then((list) => {
        if (mounted && Array.isArray(list)) setProductCatalog(list);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  const catalogLookup = useMemo(() => {
    const bySku = new Map<string, ProductSuggestion>();
    const byName = new Map<string, ProductSuggestion>();
    for (const p of productCatalog) {
      if (p.sku) bySku.set(p.sku.trim().toUpperCase(), p);
      if (p.name) byName.set(normalizeSearchString(p.name, true), p);
    }
    return { bySku, byName };
  }, [productCatalog]);

  const findCatalogMeta = useCallback(
    (name?: string | null, sku?: string | null): ProductSuggestion | null => {
      if (sku) {
        const hit = catalogLookup.bySku.get(sku.trim().toUpperCase());
        if (hit) return hit;
      }
      if (name) {
        const hit = catalogLookup.byName.get(normalizeSearchString(name, true));
        if (hit) return hit;
      }
      return null;
    },
    [catalogLookup]
  );

  const approvedEntries = useMemo<MovementEntry[]>(() => {
    const entries: MovementEntry[] = [];
    for (const prop of submittedList) {
      if (prop.status !== 'APPROVED') continue;
      const ts = prop.approved_at || prop.created_at || '';
      if (dateFilter && getLocalDateStr(ts) !== dateFilter) continue;

      prop.items.forEach((it, itemIdx) => {
        if (it.sub_items && it.sub_items.length > 0) {
          it.sub_items.forEach((sub, sIdx) => {
            const prodName = (sub.product_name || it.product_name || 'Chưa rõ sản phẩm').trim();
            const sku = sub.sku || it.sku || null;
            const meta = findCatalogMeta(prodName, sku);
            const unit = normalizeUnitLabel(sub.unit || it.unit || meta?.unit || 'Thùng');

            let beforeQty: number | null = Number(sub.current_quantity) || 0;
            let afterQty: number | null = Number(sub.new_quantity) || 0;
            let delta = 0;
            let changeKind: MovementKind = 'UNCHANGED';

            if (it.action_type === 'CLEAR') {
              afterQty = 0;
              delta = -beforeQty;
              changeKind = 'CLEAR';
            } else if (it.action_type === 'SET_QTY') {
              if (!it.lot_id || sub.is_new) {
                beforeQty = 0;
                delta = afterQty;
                changeKind = !it.lot_id ? 'CREATE_LOT' : 'ADD_TO_LOT';
              } else {
                delta = Number((afterQty - beforeQty).toFixed(2));
                changeKind = delta > 0 ? 'INCREASE' : delta < 0 ? 'DECREASE' : 'UNCHANGED';
              }
            } else {
              delta = 0;
              changeKind = it.action_type;
            }

            entries.push({
              key: `${prop.id}-${it.id || itemIdx}-sub-${sIdx}`,
              proposal: prop,
              item: it,
              timestamp: ts,
              productName: prodName,
              sku,
              aliases: meta?.aliases || null,
              unit,
              beforeQty,
              afterQty,
              delta,
              changeKind,
            });
          });
        } else {
          const prodName = (
            it.product_name ||
            (it.action_type === 'NOTE' ? 'Ghi chú (không gắn SP)' : 'Chưa rõ sản phẩm')
          ).trim();
          const sku = it.sku || null;
          const meta = findCatalogMeta(prodName, sku);
          const unit = normalizeUnitLabel(it.unit || meta?.unit || 'Thùng');

          let beforeQty: number | null =
            it.current_quantity != null ? Number(it.current_quantity) : null;
          let afterQty: number | null = it.new_quantity != null ? Number(it.new_quantity) : null;
          let delta = 0;
          let changeKind: MovementKind = 'UNCHANGED';

          if (it.action_type === 'CLEAR') {
            const prev = beforeQty ?? 0;
            beforeQty = prev;
            afterQty = 0;
            delta = -prev;
            changeKind = 'CLEAR';
          } else if (it.action_type === 'SET_QTY') {
            if (!it.lot_id) {
              beforeQty = 0;
              const next = afterQty ?? 0;
              afterQty = next;
              delta = next;
              changeKind = 'CREATE_LOT';
            } else {
              const prev = beforeQty ?? 0;
              const next = afterQty ?? prev;
              beforeQty = prev;
              afterQty = next;
              delta = Number((next - prev).toFixed(2));
              changeKind = delta > 0 ? 'INCREASE' : delta < 0 ? 'DECREASE' : 'UNCHANGED';
            }
          } else {
            delta = 0;
            changeKind = it.action_type;
          }

          entries.push({
            key: `${prop.id}-${it.id || itemIdx}`,
            proposal: prop,
            item: it,
            timestamp: ts,
            productName: prodName,
            sku,
            aliases: meta?.aliases || null,
            unit,
            beforeQty,
            afterQty,
            delta,
            changeKind,
          });
        }
      });
    }

    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return entries;
  }, [submittedList, dateFilter, findCatalogMeta]);

  const productSuggestions = useMemo(() => {
    const map = new Map<
      string,
      { name: string; sku: string | null; aliases: string | null; count: number }
    >();
    for (const e of approvedEntries) {
      if (!e.productName || e.productName === 'Ghi chú (không gắn SP)') continue;
      const k = e.sku
        ? `sku:${e.sku.trim().toUpperCase()}`
        : `name:${normalizeSearchString(e.productName, true)}`;
      const ex = map.get(k);
      if (ex) ex.count++;
      else map.set(k, { name: e.productName, sku: e.sku, aliases: e.aliases, count: 1 });
    }
    const all = Array.from(map.values());
    const q = productQuery.trim();
    if (!q) return all.sort((a, b) => b.count - a.count).slice(0, 10);
    return all
      .filter((p) => matchSearch(p, q))
      .sort((a, b) => calculateSearchScore(b, q) - calculateSearchScore(a, q))
      .slice(0, 12);
  }, [approvedEntries, productQuery]);

  const filteredEntries = useMemo(() => {
    if (selectedProduct) {
      return approvedEntries.filter((e) => {
        if (selectedProduct.sku && e.sku) {
          return e.sku.trim().toUpperCase() === selectedProduct.sku.trim().toUpperCase();
        }
        return (
          normalizeSearchString(e.productName, true) ===
          normalizeSearchString(selectedProduct.name, true)
        );
      });
    }
    const q = productQuery.trim();
    if (!q) return approvedEntries;
    return approvedEntries.filter((e) =>
      matchSearch({ name: e.productName, sku: e.sku, aliases: e.aliases }, q)
    );
  }, [approvedEntries, selectedProduct, productQuery]);

  const stats = useMemo(() => {
    const decreasedByUnit = new Map<string, number>();
    const increasedByUnit = new Map<string, number>();
    const netByUnit = new Map<string, number>();
    let decreaseCount = 0;
    let increaseCount = 0;
    let moveCount = 0;
    let assignCount = 0;

    const byProduct = new Map<
      string,
      {
        name: string;
        sku: string | null;
        decreased: Map<string, number>;
        increased: Map<string, number>;
        net: Map<string, number>;
        count: number;
        byKind: Map<MovementKind, { count: number; qtyByUnit: Map<string, number> }>;
      }
    >();

    for (const e of filteredEntries) {
      if (e.delta < 0) {
        const abs = Math.abs(e.delta);
        decreasedByUnit.set(e.unit, (decreasedByUnit.get(e.unit) || 0) + abs);
        netByUnit.set(e.unit, (netByUnit.get(e.unit) || 0) - abs);
        decreaseCount++;
      } else if (e.delta > 0) {
        increasedByUnit.set(e.unit, (increasedByUnit.get(e.unit) || 0) + e.delta);
        netByUnit.set(e.unit, (netByUnit.get(e.unit) || 0) + e.delta);
        increaseCount++;
      }
      if (e.changeKind === 'MOVE') moveCount++;
      if (e.changeKind === 'ASSIGN_LOT') assignCount++;

      const pKey = e.sku
        ? `sku:${e.sku.trim().toUpperCase()}`
        : `name:${normalizeSearchString(e.productName, true)}`;
      let g = byProduct.get(pKey);
      if (!g) {
        g = {
          name: e.productName,
          sku: e.sku,
          decreased: new Map(),
          increased: new Map(),
          net: new Map(),
          count: 0,
          byKind: new Map(),
        };
        byProduct.set(pKey, g);
      }
      g.count++;
      if (e.delta < 0) {
        const abs = Math.abs(e.delta);
        g.decreased.set(e.unit, (g.decreased.get(e.unit) || 0) + abs);
        g.net.set(e.unit, (g.net.get(e.unit) || 0) - abs);
      } else if (e.delta > 0) {
        g.increased.set(e.unit, (g.increased.get(e.unit) || 0) + e.delta);
        g.net.set(e.unit, (g.net.get(e.unit) || 0) + e.delta);
      }

      let kb = g.byKind.get(e.changeKind);
      if (!kb) {
        kb = { count: 0, qtyByUnit: new Map() };
        g.byKind.set(e.changeKind, kb);
      }
      kb.count++;
      if (e.delta !== 0) {
        kb.qtyByUnit.set(e.unit, (kb.qtyByUnit.get(e.unit) || 0) + Math.abs(e.delta));
      }
    }

    const order: Array<{
      kind: MovementKind;
      label: string;
      sign: '+' | '-' | '';
      tone: ActionTag['tone'];
    }> = [
      { kind: 'CLEAR', label: 'Xuất rỗng', sign: '-', tone: 'rose' },
      { kind: 'DECREASE', label: 'Điều chỉnh giảm', sign: '-', tone: 'amber' },
      { kind: 'CREATE_LOT', label: 'Tạo Lot mới', sign: '+', tone: 'emerald' },
      { kind: 'ADD_TO_LOT', label: 'Thêm vào Lot', sign: '+', tone: 'emerald' },
      { kind: 'INCREASE', label: 'Điều chỉnh tăng', sign: '+', tone: 'sky' },
      { kind: 'MOVE', label: 'Chuyển ô', sign: '', tone: 'sky' },
      { kind: 'ASSIGN_LOT', label: 'Gắn STT', sign: '', tone: 'purple' },
      { kind: 'NOTE', label: 'Ghi chú', sign: '', tone: 'slate' },
      { kind: 'UNCHANGED', label: 'Điều chỉnh (0)', sign: '', tone: 'slate' },
    ];

    const productSummary = Array.from(byProduct.values())
      .map((g) => {
        const actionTags: ActionTag[] = [];
        for (const cfg of order) {
          const b = g.byKind.get(cfg.kind);
          if (!b || b.count === 0) continue;
          if (cfg.sign) {
            const q = formatUnitTotalsMap(b.qtyByUnit, cfg.sign);
            actionTags.push({
              label: q !== '0' ? `${cfg.label} (${q})` : `${cfg.label} (${b.count})`,
              tone: cfg.tone,
            });
          } else {
            actionTags.push({ label: `${cfg.label} (${b.count})`, tone: cfg.tone });
          }
        }
        return { ...g, actionTags };
      })
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    return {
      decreasedByUnit,
      increasedByUnit,
      netByUnit,
      decreaseCount,
      increaseCount,
      moveCount,
      assignCount,
      productSummary,
    };
  }, [filteredEntries]);

  const getMovementKindLabel = (kind: MovementKind, delta: number, unit: string): ActionTag => {
    switch (kind) {
      case 'CLEAR':
        return { label: `Xuất rỗng (-${formatNumberVN(Math.abs(delta))} ${unit})`, tone: 'rose' };
      case 'DECREASE':
        return { label: `Điều chỉnh giảm (${formatNumberVN(delta)} ${unit})`, tone: 'amber' };
      case 'CREATE_LOT':
        return { label: `Tạo Lot mới (+${formatNumberVN(delta)} ${unit})`, tone: 'emerald' };
      case 'ADD_TO_LOT':
        return { label: `Thêm vào Lot (+${formatNumberVN(delta)} ${unit})`, tone: 'emerald' };
      case 'INCREASE':
        return { label: `Điều chỉnh tăng (+${formatNumberVN(delta)} ${unit})`, tone: 'sky' };
      case 'MOVE':
        return { label: 'Chuyển ô', tone: 'sky' };
      case 'ASSIGN_LOT':
        return { label: 'Gắn STT', tone: 'purple' };
      case 'NOTE':
        return { label: 'Ghi chú', tone: 'slate' };
      default:
        return { label: 'Điều chỉnh (0)', tone: 'slate' };
    }
  };

  const hasProductFilter = Boolean(selectedProduct || productQuery.trim());

  return (
    <View style={{ flex: 1 }}>
      {/* Bộ lọc ngày */}
      <View style={styles.dateFilterRow}>
        <TouchableOpacity
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setDateFilter(dateFilter === todayStr ? '' : todayStr);
          }}
          style={[styles.dateChip, dateFilter === todayStr && styles.dateChipAmber]}
        >
          <Text style={[styles.dateChipText, dateFilter === todayStr && { color: '#fde68a' }]}>
            Hôm nay
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setDateFilter('');
          }}
          style={[styles.dateChip, dateFilter === '' && styles.dateChipSky]}
        >
          <Text style={[styles.dateChipText, dateFilter === '' && { color: '#7dd3fc' }]}>
            Tất cả
          </Text>
        </TouchableOpacity>

        <View style={styles.dateStepper}>
          <TouchableOpacity
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setDateFilter(shiftDateStr(dateFilter || todayStr, -1));
            }}
            style={styles.dateStepBtn}
          >
            <Ionicons name="chevron-back" size={14} color="#cbd5e1" />
          </TouchableOpacity>
          <Text style={styles.dateStepLabel}>{formatDateVN(dateFilter)}</Text>
          <TouchableOpacity
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setDateFilter(shiftDateStr(dateFilter || todayStr, 1));
            }}
            style={styles.dateStepBtn}
          >
            <Ionicons name="chevron-forward" size={14} color="#cbd5e1" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Ô tìm kiếm sản phẩm (hỗ trợ tên viết tắt aliases) */}
      <View style={styles.searchWrap}>
        <Ionicons name="cube-outline" size={15} color="#34d399" />
        <TextInput
          style={styles.searchInput}
          value={selectedProduct ? selectedProduct.name : productQuery}
          onFocus={() => setShowSuggestions(true)}
          onChangeText={(txt) => {
            setSelectedProduct(null);
            setProductQuery(txt);
            setShowSuggestions(true);
          }}
          placeholder="Lọc sản phẩm (tên viết tắt, SKU, tên SP)..."
          placeholderTextColor="#64748b"
          autoCorrect={false}
        />
        {(selectedProduct || productQuery) ? (
          <TouchableOpacity
            onPress={() => {
              setSelectedProduct(null);
              setProductQuery('');
              setShowSuggestions(false);
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="close-circle" size={17} color="#94a3b8" />
          </TouchableOpacity>
        ) : null}
      </View>

      {showSuggestions && productSuggestions.length > 0 && (
        <View style={styles.suggestionsBox}>
          <ScrollView style={{ maxHeight: 170 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {productSuggestions.map((p, idx) => (
              <TouchableOpacity
                key={`${p.sku || p.name}-${idx}`}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setSelectedProduct({ name: p.name, sku: p.sku });
                  setProductQuery('');
                  setShowSuggestions(false);
                }}
                style={styles.suggestionRow}
              >
                <View style={{ flex: 1, paddingRight: 8 }}>
                  {p.aliases ? (
                    <Text style={styles.suggestionAlias} numberOfLines={1}>
                      ⚡ {p.aliases}
                    </Text>
                  ) : null}
                  <Text style={styles.suggestionName} numberOfLines={1}>
                    {p.name}
                  </Text>
                </View>
                <View style={styles.suggestionCountBadge}>
                  <Text style={styles.suggestionCountText}>{p.count} lượt</Text>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 18, paddingTop: 4 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* 4 thẻ KPI (2x2) */}
        <View style={styles.kpiGrid}>
          <View style={[styles.kpiCard, { backgroundColor: '#4c051955', borderColor: '#f43f5e44' }]}>
            <Text style={[styles.kpiLabel, { color: '#fda4af' }]}>XUẤT / XÓA / GIẢM</Text>
            <Text style={[styles.kpiValue, { color: '#fb7185' }]} numberOfLines={2}>
              {stats.decreaseCount > 0 ? formatUnitTotalsMap(stats.decreasedByUnit, '-') : '0'}
            </Text>
            <Text style={styles.kpiSub}>{stats.decreaseCount} lượt giảm</Text>
          </View>

          <View style={[styles.kpiCard, { backgroundColor: '#064e3b55', borderColor: '#10b98144' }]}>
            <Text style={[styles.kpiLabel, { color: '#6ee7b7' }]}>TẠO MỚI / TĂNG</Text>
            <Text style={[styles.kpiValue, { color: '#34d399' }]} numberOfLines={2}>
              {stats.increaseCount > 0 ? formatUnitTotalsMap(stats.increasedByUnit, '+') : '0'}
            </Text>
            <Text style={styles.kpiSub}>{stats.increaseCount} lượt tăng</Text>
          </View>

          <View style={styles.kpiCard}>
            <Text style={styles.kpiLabel}>BIẾN ĐỘNG RÒNG</Text>
            <Text style={[styles.kpiValue, { color: '#7dd3fc' }]} numberOfLines={2}>
              {formatUnitTotalsMap(stats.netByUnit, 'signed')}
            </Text>
          </View>

          <View style={styles.kpiCard}>
            <Text style={styles.kpiLabel}>TỔNG LƯỢT (ĐÃ DUYỆT)</Text>
            <Text style={[styles.kpiValue, { color: '#fbbf24' }]}>
              {filteredEntries.length} lượt
            </Text>
            <Text style={styles.kpiSub}>
              Chuyển: {stats.moveCount} · STT: {stats.assignCount}
            </Text>
          </View>
        </View>

        {filteredEntries.length === 0 ? (
          <View style={styles.emptyBox}>
            <Ionicons name="stats-chart-outline" size={38} color="#475569" />
            <Text style={styles.emptyTitle}>Không có biến động đã duyệt</Text>
            <Text style={styles.emptySub}>
              Thử bấm &ldquo;Tất cả&rdquo; hoặc chuyển ngày khác (và bấm Làm mới ↻ để tải phiếu mới nhất).
            </Text>
          </View>
        ) : !hasProductFilter ? (
          <View style={{ gap: 8 }}>
            <Text style={styles.sectionTitle}>
              TỔNG HỢP THEO TỪNG SẢN PHẨM ({stats.productSummary.length} SP)
            </Text>
            {stats.productSummary.map((row, idx) => (
              <TouchableOpacity
                key={`${row.sku || row.name}-${idx}`}
                activeOpacity={0.78}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setSelectedProduct({ name: row.name, sku: row.sku });
                }}
                style={styles.productCard}
              >
                <View style={styles.productCardHeader}>
                  <Text style={styles.productCardName} numberOfLines={2}>
                    {row.name}
                  </Text>
                  <View style={styles.countPill}>
                    <Text style={styles.countPillText}>{row.count} lượt</Text>
                  </View>
                </View>

                {row.actionTags.length > 0 && (
                  <View style={styles.tagsWrap}>
                    {row.actionTags.map((tag, tIdx) => {
                      const pal = TAG_PALETTE[tag.tone] || TAG_PALETTE.slate;
                      return (
                        <View
                          key={tIdx}
                          style={[
                            styles.actionChip,
                            { backgroundColor: pal.bg, borderColor: pal.border },
                          ]}
                        >
                          <Text style={[styles.actionChipText, { color: pal.text }]}>
                            {tag.label}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                )}

                <View style={styles.metricsRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.metricLabel}>Giảm</Text>
                    <Text style={[styles.metricVal, { color: '#fb7185' }]} numberOfLines={1}>
                      {formatUnitTotalsMap(row.decreased, '-')}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.metricLabel}>Tăng</Text>
                    <Text style={[styles.metricVal, { color: '#34d399' }]} numberOfLines={1}>
                      {formatUnitTotalsMap(row.increased, '+')}
                    </Text>
                  </View>
                  <View style={{ flex: 1, alignItems: 'flex-end' }}>
                    <Text style={styles.metricLabel}>Ròng</Text>
                    <Text style={[styles.metricVal, { color: '#7dd3fc' }]} numberOfLines={1}>
                      {formatUnitTotalsMap(row.net, 'signed')}
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            <View style={styles.detailHeaderRow}>
              <Text style={styles.sectionTitle}>
                CHI TIẾT BIẾN ĐỔI ({filteredEntries.length} LƯỢT)
              </Text>
              <TouchableOpacity
                onPress={() => {
                  setSelectedProduct(null);
                  setProductQuery('');
                }}
              >
                <Text style={styles.backAllText}>← Xem tất cả SP</Text>
              </TouchableOpacity>
            </View>

            {filteredEntries.map((entry) => {
              const tag = getMovementKindLabel(entry.changeKind, entry.delta, entry.unit);
              const pal = TAG_PALETTE[tag.tone] || TAG_PALETTE.slate;
              return (
                <View key={entry.key} style={styles.detailCard}>
                  <View style={styles.detailTopRow}>
                    <View style={styles.posBadge}>
                      <Text style={styles.posBadgeText}>
                        {entry.item.position_code}
                        {entry.item.action_type === 'MOVE' && entry.item.target_position_code
                          ? ` ➔ ${entry.item.target_position_code}`
                          : ''}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.actionChip,
                        { backgroundColor: pal.bg, borderColor: pal.border },
                      ]}
                    >
                      <Text style={[styles.actionChipText, { color: pal.text }]}>{tag.label}</Text>
                    </View>
                  </View>

                  {entry.beforeQty !== null &&
                    entry.afterQty !== null &&
                    (entry.item.action_type === 'SET_QTY' ||
                      entry.item.action_type === 'CLEAR') && (
                      <Text style={styles.detailQtyText}>
                        SL: {formatNumberVN(entry.beforeQty)} ➔{' '}
                        <Text
                          style={{
                            color: entry.delta < 0 ? '#fb7185' : '#34d399',
                            fontWeight: '800',
                          }}
                        >
                          {formatNumberVN(entry.afterQty)} {entry.unit}
                        </Text>
                      </Text>
                    )}

                  <View style={styles.detailMetaRow}>
                    <Text style={styles.detailMetaText}>🕒 {formatTimeVN(entry.timestamp)}</Text>
                    <Text style={styles.detailMetaText} numberOfLines={1}>
                      {entry.proposal.code ? `${entry.proposal.code} · ` : ''}
                      {entry.proposal.created_by_name || 'NV'}
                    </Text>
                  </View>

                  {entry.item.note ? (
                    <Text style={styles.detailNote}>💬 {entry.item.note}</Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  dateFilterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
    flexWrap: 'wrap',
  },
  dateChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  dateChipAmber: {
    backgroundColor: '#78350f55',
    borderColor: '#f59e0b',
  },
  dateChipSky: {
    backgroundColor: '#0c4a6e55',
    borderColor: '#38bdf8',
  },
  dateChipText: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '700',
  },
  dateStepper: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 'auto',
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingHorizontal: 4,
    paddingVertical: 3,
    gap: 4,
  },
  dateStepBtn: {
    padding: 3,
  },
  dateStepLabel: {
    color: '#f8fafc',
    fontSize: 11,
    fontWeight: '700',
    minWidth: 68,
    textAlign: 'center',
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#10b98166',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 8,
  },
  searchInput: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '600',
    paddingVertical: 2,
  },
  suggestionsBox: {
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 12,
    marginBottom: 8,
    padding: 4,
  },
  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#334155',
  },
  suggestionAlias: {
    color: '#34d399',
    fontSize: 10,
    fontWeight: '800',
  },
  suggestionName: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '700',
  },
  suggestionCountBadge: {
    backgroundColor: '#78350f66',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  suggestionCountText: {
    color: '#fde68a',
    fontSize: 10,
    fontWeight: '800',
  },
  kpiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  kpiCard: {
    width: '48.5%',
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 12,
    padding: 10,
  },
  kpiLabel: {
    color: '#94a3b8',
    fontSize: 9.5,
    fontWeight: '800',
  },
  kpiValue: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '900',
    marginTop: 4,
  },
  kpiSub: {
    color: '#94a3b8',
    fontSize: 10,
    marginTop: 2,
  },
  sectionTitle: {
    color: '#94a3b8',
    fontSize: 10.5,
    fontWeight: '800',
    marginBottom: 2,
  },
  productCard: {
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 14,
    padding: 12,
    gap: 8,
  },
  productCardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  productCardName: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '800',
    lineHeight: 18,
  },
  countPill: {
    backgroundColor: '#0f172a',
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  countPillText: {
    color: '#cbd5e1',
    fontSize: 10.5,
    fontWeight: '700',
  },
  tagsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
  },
  actionChip: {
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  actionChipText: {
    fontSize: 10.5,
    fontWeight: '800',
  },
  metricsRow: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#334155',
    paddingTop: 8,
    gap: 6,
  },
  metricLabel: {
    color: '#64748b',
    fontSize: 9.5,
    fontWeight: '700',
  },
  metricVal: {
    fontSize: 11.5,
    fontWeight: '800',
    marginTop: 2,
  },
  detailHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  backAllText: {
    color: '#38bdf8',
    fontSize: 11.5,
    fontWeight: '800',
  },
  detailCard: {
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 12,
    padding: 11,
    gap: 6,
  },
  detailTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    flexWrap: 'wrap',
  },
  posBadge: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 7,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  posBadgeText: {
    color: '#f8fafc',
    fontSize: 11.5,
    fontWeight: '800',
  },
  detailQtyText: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '700',
  },
  detailMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  detailMetaText: {
    color: '#94a3b8',
    fontSize: 10.5,
  },
  detailNote: {
    color: '#fde68a',
    fontSize: 11,
    fontWeight: '600',
  },
  emptyBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    paddingHorizontal: 16,
    gap: 6,
  },
  emptyTitle: {
    color: '#e2e8f0',
    fontSize: 13.5,
    fontWeight: '800',
  },
  emptySub: {
    color: '#94a3b8',
    fontSize: 11.5,
    textAlign: 'center',
  },
});
