import React, { useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Image,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, AppThemeColors } from '../../contexts/ThemeContext';
import { ReconcileEntry, ShiftProductItem } from '../../services/operationsService';
import { OperationImageRecord } from '../../services/operationImagesService';

interface ReconcileTabViewProps {
  allJournals: any[];
  pinnedProducts: ShiftProductItem[];
  reconcileMap: Record<string, ReconcileEntry>;
  setReconcileMap: React.Dispatch<React.SetStateAction<Record<string, ReconcileEntry>>>;
  reconcileImagesMap: Record<string, { start: OperationImageRecord[]; end: OperationImageRecord[] }>;
  uploadingReconcileKey: string | null;
  savingReconcile: boolean;
  expandedReconcileKeys: Record<string, boolean>;
  setExpandedReconcileKeys: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  standardizeUnitLabel: (u: string) => string;
  onSaveReconcile: () => void;
  onPickReconcileImage: (reconcileKey: string, phase: 'start' | 'end', itemName: string, unit: string) => void;
  onPreviewImage: (img: OperationImageRecord) => void;
}

/** Tab Tham chiếu (Số đầu – Số đuôi) tách riêng khỏi OperationsDataScreen. */
export default function ReconcileTabView({
  allJournals,
  pinnedProducts,
  reconcileMap,
  setReconcileMap,
  reconcileImagesMap,
  uploadingReconcileKey,
  savingReconcile,
  expandedReconcileKeys,
  setExpandedReconcileKeys,
  standardizeUnitLabel,
  onSaveReconcile,
  onPickReconcileImage,
  onPreviewImage,
}: ReconcileTabViewProps) {
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  const prodMap: Record<string, { name: string; unit: string; inQty: number; outQty: number }> = {};
  allJournals.forEach(j => {
    const name = (j.item_name || '').trim();
    if (!name) return;
    const u = standardizeUnitLabel((j.unit || 'Thùng (20kg)').trim());
    const k = `${name}___${u}`;
    if (!prodMap[k]) prodMap[k] = { name, unit: u, inQty: 0, outQty: 0 };
    if (j.to_department === 'Kho') prodMap[k].inQty += j.quantity_sent || 0;
    else prodMap[k].outQty += j.quantity_sent || 0;
  });

  const existingNames = new Set(Object.values(prodMap).map(r => r.name.trim().toLowerCase()));
  pinnedProducts.forEach(p => {
    const name = (p.name || '').trim();
    if (!name || existingNames.has(name.toLowerCase())) return;
    const u = standardizeUnitLabel((p.unit || 'Thùng (20kg)').trim());
    const k = `${name}___${u}`;
    if (!prodMap[k]) {
      prodMap[k] = { name, unit: u, inQty: 0, outQty: 0 };
      existingNames.add(name.toLowerCase());
    }
  });

  Object.keys(reconcileMap).forEach(k => {
    if (k !== '__TOTAL__' && !prodMap[k] && k.includes('___')) {
      const [name, unit] = k.split('___');
      prodMap[k] = { name, unit, inQty: 0, outQty: 0 };
    }
  });

  const prodRows = Object.values(prodMap);
  const totalIn = Math.round(prodRows.reduce((s, r) => s + r.inQty, 0) * 1000) / 1000;
  const totalOut = Math.round(prodRows.reduce((s, r) => s + r.outQty, 0) * 1000) / 1000;
  const rows: { name: string; unit: string; inQty: number; outQty: number; isTotal?: boolean }[] = [
    {
      name: 'Tổng tất cả sản phẩm (Tham chiếu tổng)',
      unit: 'Tổng cả việc',
      inQty: totalIn,
      outQty: totalOut,
      isTotal: true,
    },
    ...prodRows,
  ];

  const updateEntry = (k: string, defaultTarget: 'in' | 'out' | 'net', patch: Partial<ReconcileEntry>) => {
    setReconcileMap(prev => {
      const cur = prev[k] || { startStr: '', endStr: '', calcType: 'diff', targetType: defaultTarget, note: '' };
      return { ...prev, [k]: { ...cur, ...patch } };
    });
  };

  return (
    <View style={styles.reconcileTabContainer}>
      <View style={styles.reconcileHeaderRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.reconcileTitle}>Tham chiếu Số đầu – Số đuôi</Text>
          <Text style={styles.reconcileSub}>
            Dữ liệu tham chiếu độc lập, không cộng vào số liệu nhập xuất.
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.reconcileSaveBtn, savingReconcile && { opacity: 0.6 }]}
          disabled={savingReconcile}
          onPress={onSaveReconcile}
        >
          <Text style={styles.reconcileSaveBtnText}>
            {savingReconcile ? 'Đang lưu...' : 'Lưu'}
          </Text>
        </TouchableOpacity>
      </View>

      {rows.map(row => {
        const k = row.isTotal ? '__TOTAL__' : `${row.name}___${row.unit}`;
        const defaultTarget: 'in' | 'out' | 'net' =
          row.inQty > 0 && row.outQty > 0
            ? 'net'
            : row.outQty > 0 && row.inQty === 0
              ? 'out'
              : 'in';
        const rawEntry = reconcileMap[k];
        const entry: ReconcileEntry = rawEntry
          ? {
              ...rawEntry,
              targetType: rawEntry.isManualTarget ? rawEntry.targetType : defaultTarget,
            }
          : {
              startStr: '',
              endStr: '',
              calcType: 'diff' as const,
              targetType: defaultTarget,
              note: '',
            };
        const s = parseFloat((entry.startStr || '').replace(',', '.'));
        const e = parseFloat((entry.endStr || '').replace(',', '.'));
        const hasNums = entry.startStr.trim() !== '' && entry.endStr.trim() !== '' && !Number.isNaN(s) && !Number.isNaN(e);
        const rawDiff = hasNums ? Math.abs(e - s) : 0;
        const calcQty = hasNums ? Math.round((entry.calcType === 'inclusive' ? rawDiff + 1 : rawDiff) * 1000) / 1000 : 0;
        const sysQty = entry.targetType === 'in' ? row.inQty : entry.targetType === 'out' ? row.outQty : Math.abs(row.inQty - row.outQty);
        const delta = hasNums ? Math.round((calcQty - sysQty) * 1000) / 1000 : 0;
        const isMatched = hasNums && delta === 0;
        const isExpanded = !!expandedReconcileKeys[k];

        return (
          <View
            key={k}
            style={[
              styles.reconcileCard,
              row.isTotal && {
                borderColor: colors.primary,
                backgroundColor: isDark ? 'rgba(99,102,241,0.10)' : '#eef2ff',
              },
            ]}
          >
            <TouchableOpacity
              style={styles.reconcileCardTop}
              activeOpacity={0.7}
              onPress={() => setExpandedReconcileKeys(prev => ({ ...prev, [k]: !prev[k] }))}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.reconcileProdName}>
                  {row.isTotal ? '🌐 ' : ''}{row.name} {!row.isTotal && <Text style={{ color: colors.textMuted }}>({row.unit})</Text>}
                </Text>
                <Text style={styles.reconcileSysStats}>
                  HT Nhập: <Text style={{ color: colors.success, fontWeight: '800' }}>+{row.inQty}</Text>
                  {'  •  '}
                  Xuất: <Text style={{ color: colors.danger, fontWeight: '800' }}>-{row.outQty}</Text>
                  {(entry.startStr.trim() !== '' || entry.endStr.trim() !== '') && (
                    <Text style={{ color: colors.amberSoftText, fontWeight: '700' }}>
                      {`  •  Đầu: ${entry.startStr || '—'} / Đuôi: ${entry.endStr || '—'}`}
                    </Text>
                  )}
                  {((reconcileImagesMap[k]?.start.length || 0) > 0 || (reconcileImagesMap[k]?.end.length || 0) > 0) && (
                    <Text style={{ color: colors.primarySoftText, fontWeight: '700' }}>
                      {`  •  📷 Đầu: ${reconcileImagesMap[k]?.start.length || 0} / Cuối: ${reconcileImagesMap[k]?.end.length || 0}`}
                    </Text>
                  )}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {hasNums && (
                  <View style={[styles.reconcileStatusPill, isMatched ? styles.reconcileMatchPill : styles.reconcileDiffPill]}>
                    <Text style={[styles.reconcileStatusText, isMatched ? { color: colors.successSoftText } : { color: colors.dangerSoftText }]}>
                      {isMatched ? `✓ Khớp (${calcQty})` : `⚠ Lệch ${delta > 0 ? `+${delta}` : delta}`}
                    </Text>
                  </View>
                )}
                <Ionicons
                  name={isExpanded ? 'chevron-up' : 'chevron-down'}
                  size={16}
                  color={colors.textMuted}
                />
              </View>
            </TouchableOpacity>

            {isExpanded && (
              <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.borderSubtle, gap: 8 }}>
                {row.isTotal && (
                  <Text style={{ color: colors.primarySoftText, fontSize: 10 }}>
                    VD: Đầu ca 3 pallet không, cuối ca 10 → 7 để so với tổng cả việc.
                  </Text>
                )}

                <View style={styles.reconcileTargetRow}>
                  {[
                    { key: 'in' as const, label: `So Nhập (+${row.inQty})` },
                    { key: 'out' as const, label: `So Xuất (-${row.outQty})` },
                    { key: 'net' as const, label: `Cân đối (${Math.abs(row.inQty - row.outQty)})` },
                  ].map(opt => (
                    <TouchableOpacity
                      key={opt.key}
                      style={[styles.reconcileMiniChip, entry.targetType === opt.key && styles.reconcileMiniChipActive]}
                      onPress={() => updateEntry(k, defaultTarget, { targetType: opt.key, isManualTarget: true })}
                    >
                      <Text style={[styles.reconcileMiniChipText, entry.targetType === opt.key && { color: isDark ? '#38bdf8' : '#0284c7' }]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <View style={styles.reconcileInputsRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.reconcileInputLabel}>Số đầu</Text>
                    <TextInput
                      style={styles.reconcileInput}
                      keyboardType="decimal-pad"
                      placeholder="VD: 6"
                      placeholderTextColor={colors.inputPlaceholder}
                      value={entry.startStr}
                      onChangeText={txt => updateEntry(k, defaultTarget, { startStr: txt })}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.reconcileInputLabel}>Số đuôi</Text>
                    <TextInput
                      style={styles.reconcileInput}
                      keyboardType="decimal-pad"
                      placeholder="VD: 12"
                      placeholderTextColor={colors.inputPlaceholder}
                      value={entry.endStr}
                      onChangeText={txt => updateEntry(k, defaultTarget, { endStr: txt })}
                    />
                  </View>
                </View>

                <View style={styles.reconcileTargetRow}>
                  <TouchableOpacity
                    style={[styles.reconcileMiniChip, entry.calcType === 'diff' && styles.reconcileCalcChipActive]}
                    onPress={() => updateEntry(k, defaultTarget, { calcType: 'diff' })}
                  >
                    <Text style={[styles.reconcileMiniChipText, entry.calcType === 'diff' && { color: colors.amberSoftText }]}>
                      Đếm Tồn (Đuôi - Đầu)
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.reconcileMiniChip, entry.calcType === 'inclusive' && styles.reconcileCalcChipActive]}
                    onPress={() => updateEntry(k, defaultTarget, { calcType: 'inclusive' })}
                  >
                    <Text style={[styles.reconcileMiniChipText, entry.calcType === 'inclusive' && { color: colors.amberSoftText }]}>
                      Đếm STT (Đuôi - Đầu + 1)
                    </Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.reconcileHintText}>
                  {entry.calcType === 'diff'
                    ? '💡 VD: Đầu ca có 6, cuối ca đếm được 12 → Phát sinh 6.'
                    : '💡 VD: Làm từ số 6 đến số 12 (tính cả 2 đầu) → Tổng 7.'}
                </Text>

                {/* Ảnh tham chiếu Đầu / Cuối */}
                <View style={{ marginTop: 4, gap: 6 }}>
                  {([
                    { phase: 'start' as const, label: 'Ảnh tham chiếu ĐẦU', borderColor: isDark ? '#38bdf8' : '#0284c7', textColor: isDark ? '#7dd3fc' : '#0369a1' },
                    { phase: 'end' as const, label: 'Ảnh tham chiếu CUỐI', borderColor: isDark ? '#f59e0b' : '#d97706', textColor: isDark ? '#fbbf24' : '#b45309' },
                  ]).map(cfg => {
                    const imgs = reconcileImagesMap[k]?.[cfg.phase] || [];
                    const isUp = uploadingReconcileKey === `${k}:${cfg.phase}`;
                    return (
                      <View
                        key={cfg.phase}
                        style={{
                          padding: 8,
                          borderRadius: 10,
                          backgroundColor: isDark ? 'rgba(15,23,42,0.65)' : '#f8fafc',
                          borderWidth: 1,
                          borderColor: colors.border,
                          gap: 6,
                        }}
                      >
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                          <Text style={{ color: colors.textSecondary, fontSize: 11, fontWeight: '700' }}>
                            📷 {cfg.label} ({imgs.length})
                          </Text>
                          <TouchableOpacity
                            disabled={isUp}
                            onPress={() => onPickReconcileImage(k, cfg.phase, row.name, row.unit)}
                            style={{
                              paddingHorizontal: 10,
                              paddingVertical: 5,
                              borderRadius: 8,
                              backgroundColor: isDark ? 'rgba(15,23,42,0.9)' : '#ffffff',
                              borderWidth: 1,
                              borderColor: cfg.borderColor,
                            }}
                          >
                            <Text style={{ color: cfg.textColor, fontSize: 11, fontWeight: '700' }}>
                              {isUp ? 'Đang tải...' : '+ Thêm'}
                            </Text>
                          </TouchableOpacity>
                        </View>
                        {imgs.length > 0 && (
                          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                            {imgs.map(img => (
                              <TouchableOpacity
                                key={img.id}
                                onPress={() => onPreviewImage(img)}
                                style={{ marginRight: 8 }}
                              >
                                <Image
                                  source={{ uri: img.public_url || '' }}
                                  style={{ width: 52, height: 52, borderRadius: 8, borderWidth: 1, borderColor: cfg.borderColor }}
                                />
                              </TouchableOpacity>
                            ))}
                          </ScrollView>
                        )}
                      </View>
                    );
                  })}
                </View>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const createStyles = (c: AppThemeColors, isDark: boolean) => StyleSheet.create({
  reconcileTabContainer: {
    gap: 10,
    paddingBottom: 20,
  },
  reconcileHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 4,
  },
  reconcileTitle: {
    color: c.text,
    fontSize: 14,
    fontWeight: '800',
  },
  reconcileSub: {
    color: c.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  reconcileSaveBtn: {
    backgroundColor: '#d97706',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  reconcileSaveBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
  },
  reconcileCard: {
    backgroundColor: isDark ? 'rgba(15, 23, 42, 0.72)' : '#ffffff',
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 14,
    padding: 12,
    gap: 8,
  },
  reconcileCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  reconcileProdName: {
    color: c.text,
    fontSize: 13,
    fontWeight: '800',
  },
  reconcileSysStats: {
    color: c.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  reconcileStatusPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  reconcileMatchPill: {
    backgroundColor: c.successSoftBg,
  },
  reconcileDiffPill: {
    backgroundColor: c.dangerSoftBg,
  },
  reconcileStatusText: {
    fontSize: 11,
    fontWeight: '800',
  },
  reconcileTargetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  reconcileMiniChip: {
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: c.surfaceAlt,
    borderWidth: 1,
    borderColor: c.border,
  },
  reconcileMiniChipActive: {
    borderColor: isDark ? '#38bdf8' : '#0284c7',
    backgroundColor: isDark ? 'rgba(56, 189, 248, 0.12)' : '#e0f2fe',
  },
  reconcileCalcChipActive: {
    borderColor: isDark ? '#fbbf24' : '#d97706',
    backgroundColor: c.amberSoftBg,
  },
  reconcileMiniChipText: {
    color: c.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
  reconcileInputsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  reconcileInputLabel: {
    color: c.textMuted,
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 4,
  },
  reconcileInput: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: c.text,
    fontSize: 15,
    fontWeight: '800',
  },
  reconcileHintText: {
    color: c.textMuted,
    fontSize: 10,
    fontStyle: 'italic',
  },
});
