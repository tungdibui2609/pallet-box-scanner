import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  DeliveryShift,
  JournalRecord,
  ShiftProductItem,
  aggregateShiftsProducts,
  aggregateShiftsUnits,
  AggregatedProductItem,
  AggregatedUnitItem,
} from '../../services/operationsService';

interface Props {
  visible: boolean;
  title: string;
  shifts: DeliveryShift[];
  journals: JournalRecord[];
  allProducts?: ShiftProductItem[];
  loading?: boolean;
  onClose: () => void;
  onOpenShiftDetail?: (shift: DeliveryShift) => void;
}

function formatDateTime(isoString?: string | null): string {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    const time = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const date = d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
    return `${time} ${date}`;
  } catch {
    return isoString;
  }
}

function isOvernightShift(s?: DeliveryShift | null): boolean {
  if (!s?.opened_at || !s?.closed_at) return false;
  try {
    const d1 = new Date(s.opened_at).toDateString();
    const d2 = new Date(s.closed_at).toDateString();
    return d1 !== d2;
  } catch {
    return false;
  }
}

export default function AggregatedReportModal({
  visible,
  title,
  shifts,
  journals,
  allProducts,
  loading = false,
  onClose,
  onOpenShiftDetail,
}: Props) {
  // Trạng thái thu / mở rộng từng khối (Mặc định mở để xem ngay)
  const [expandProducts, setExpandProducts] = useState(true);
  const [expandUnits, setExpandUnits] = useState(true);
  const [expandShifts, setExpandShifts] = useState(true);

  // Tính toán số liệu tổng hợp
  const prodRows: AggregatedProductItem[] = useMemo(() => {
    return aggregateShiftsProducts(shifts, journals, allProducts);
  }, [shifts, journals, allProducts]);

  const unitRows: AggregatedUnitItem[] = useMemo(() => {
    return aggregateShiftsUnits(prodRows);
  }, [prodRows]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        {/* ── HEADER ── */}
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="bar-chart" size={20} color="#6366f1" />
              <Text style={styles.headerTitle} numberOfLines={1}>
                {title}
              </Text>
            </View>
            <Text style={styles.headerSubtitle}>
              Tổng số: <Text style={{ color: '#818cf8', fontWeight: '700' }}>{shifts.length} công việc</Text> • Phát sinh: <Text style={{ color: '#34d399', fontWeight: '700' }}>{prodRows.length} mặt hàng</Text>
            </Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} activeOpacity={0.7}>
            <Ionicons name="close" size={22} color="#cbd5e1" />
          </TouchableOpacity>
        </View>

        {/* ── BODY ── */}
        {loading ? (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color="#6366f1" />
            <Text style={styles.loadingText}>Đang tổng hợp số liệu báo cáo...</Text>
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 60 }}>
            {/* ── 1. CHI TIẾT THEO MẶT HÀNG ── */}
            <View style={styles.card}>
              <TouchableOpacity
                onPress={() => setExpandProducts(prev => !prev)}
                style={styles.cardHeader}
                activeOpacity={0.7}
              >
                <View style={styles.cardHeaderLeft}>
                  <Ionicons name="cube-outline" size={16} color="#38bdf8" />
                  <Text style={styles.cardTitle}>1. Chi tiết theo Mặt Hàng</Text>
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{prodRows.length} SP</Text>
                  </View>
                </View>
                <Ionicons
                  name={expandProducts ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color="#94a3b8"
                />
              </TouchableOpacity>

              {expandProducts && (
                <View style={styles.cardBody}>
                  {prodRows.length === 0 ? (
                    <Text style={styles.emptyText}>Chưa có phát sinh sản phẩm nào trong các công việc này.</Text>
                  ) : (
                    <View style={styles.table}>
                      {/* Tiêu đề bảng */}
                      <View style={styles.tableHeader}>
                        <Text style={[styles.th, { width: 32, textAlign: 'center' }]}>STT</Text>
                        <Text style={[styles.th, { flex: 3 }]}>Sản phẩm & Công việc</Text>
                        <Text style={[styles.th, { flex: 1.2, textAlign: 'right', color: '#4ade80' }]}>Nhập (+)</Text>
                        <Text style={[styles.th, { flex: 1.2, textAlign: 'right', color: '#f87171' }]}>Xuất (-)</Text>
                        <Text style={[styles.th, { width: 44, textAlign: 'right' }]}>Đợt</Text>
                      </View>

                      {/* Các dòng sản phẩm */}
                      {prodRows.map((r, idx) => (
                        <View key={`${r.product_name}___${r.unit}`} style={styles.tableRow}>
                          <Text style={[styles.td, { width: 32, textAlign: 'center', color: '#64748b', fontSize: 11 }]}>
                            {idx + 1}
                          </Text>

                          <View style={{ flex: 3, paddingRight: 4 }}>
                            {/* Tên sản phẩm & ĐVT */}
                            <Text style={styles.prodName} numberOfLines={2}>
                              {r.product_name}
                            </Text>
                            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2, flexWrap: 'wrap', gap: 4 }}>
                              <View style={styles.unitBadge}>
                                <Text style={styles.unitBadgeText}>{r.unit}</Text>
                              </View>
                            </View>

                            {/* Danh sách các công việc phát sinh sản phẩm này */}
                            <View style={styles.jobsList}>
                              {r.jobs && r.jobs.length > 0 ? (
                                r.jobs.map((j) => (
                                  <View key={j.id} style={styles.jobItem}>
                                    <Ionicons name="briefcase-outline" size={10} color="#818cf8" />
                                    <Text style={styles.jobNameText} numberOfLines={1}>
                                      {j.name}
                                    </Text>
                                    {r.jobs.length > 1 && (
                                      <Text style={styles.jobQtyBreakdown}>
                                        ({j.in_qty > 0 ? `+${j.in_qty}` : '0'}{j.out_qty > 0 ? ` / -${j.out_qty}` : ''})
                                      </Text>
                                    )}
                                  </View>
                                ))
                              ) : (
                                <Text style={{ fontSize: 10, color: '#64748b', fontStyle: 'italic' }}>
                                  Từ tổng hợp chốt ca
                                </Text>
                              )}
                            </View>
                          </View>

                          <Text style={[styles.td, { flex: 1.2, textAlign: 'right', color: '#4ade80', fontWeight: '800' }]}>
                            {r.in_qty > 0 ? `+${r.in_qty}` : '0'}
                          </Text>
                          <Text style={[styles.td, { flex: 1.2, textAlign: 'right', color: '#f87171', fontWeight: '800' }]}>
                            {r.out_qty > 0 ? `-${r.out_qty}` : '0'}
                          </Text>
                          <Text style={[styles.td, { width: 44, textAlign: 'right', color: '#cbd5e1', fontSize: 11 }]}>
                            {r.count}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              )}
            </View>

            {/* ── 2. TỔNG HỢP THEO ĐƠN VỊ TÍNH ── */}
            <View style={styles.card}>
              <TouchableOpacity
                onPress={() => setExpandUnits(prev => !prev)}
                style={styles.cardHeader}
                activeOpacity={0.7}
              >
                <View style={styles.cardHeaderLeft}>
                  <Ionicons name="layers-outline" size={16} color="#818cf8" />
                  <Text style={styles.cardTitle}>2. Tổng hợp theo Đơn Vị Tính</Text>
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{unitRows.length} ĐVT</Text>
                  </View>
                </View>
                <Ionicons
                  name={expandUnits ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color="#94a3b8"
                />
              </TouchableOpacity>

              {expandUnits && (
                <View style={styles.cardBody}>
                  {unitRows.length === 0 ? (
                    <Text style={styles.emptyText}>Chưa có phát sinh số liệu theo đơn vị tính.</Text>
                  ) : (
                    <View style={styles.table}>
                      <View style={styles.tableHeader}>
                        <Text style={[styles.th, { flex: 2 }]}>Đơn vị tính</Text>
                        <Text style={[styles.th, { flex: 1, textAlign: 'right', color: '#4ade80' }]}>Nhập (+)</Text>
                        <Text style={[styles.th, { flex: 1, textAlign: 'right', color: '#f87171' }]}>Xuất (-)</Text>
                        <Text style={[styles.th, { width: 50, textAlign: 'right' }]}>Số đợt</Text>
                      </View>
                      {unitRows.map(u => (
                        <View key={u.unit} style={styles.tableRow}>
                          <Text style={[styles.td, { flex: 2, fontWeight: '700', color: '#f8fafc' }]}>
                            {u.unit}
                          </Text>
                          <Text style={[styles.td, { flex: 1, textAlign: 'right', color: '#4ade80', fontWeight: '800' }]}>
                            +{u.in_qty}
                          </Text>
                          <Text style={[styles.td, { flex: 1, textAlign: 'right', color: '#f87171', fontWeight: '800' }]}>
                            -{u.out_qty}
                          </Text>
                          <Text style={[styles.td, { width: 50, textAlign: 'right', color: '#cbd5e1' }]}>
                            {u.count}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              )}
            </View>

            {/* ── 3. DANH SÁCH CÁC CÔNG VIỆC ── */}
            <View style={styles.card}>
              <TouchableOpacity
                onPress={() => setExpandShifts(prev => !prev)}
                style={styles.cardHeader}
                activeOpacity={0.7}
              >
                <View style={styles.cardHeaderLeft}>
                  <Ionicons name="folder-open-outline" size={16} color="#fbbf24" />
                  <Text style={styles.cardTitle}>3. Danh sách các Công Việc</Text>
                  <View style={[styles.badge, { backgroundColor: 'rgba(251, 191, 36, 0.2)' }]}>
                    <Text style={[styles.badgeText, { color: '#fbbf24' }]}>{shifts.length} CV</Text>
                  </View>
                </View>
                <Ionicons
                  name={expandShifts ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color="#94a3b8"
                />
              </TouchableOpacity>

              {expandShifts && (
                <View style={styles.cardBody}>
                  {shifts.map((s, sIdx) => {
                    const name = s.summary_data?.job_name || s.notes || `Công việc #${sIdx + 1}`;
                    const prodCount = Object.keys(s.summary_data?.products_summary || {}).length;
                    const recordsCount = s.summary_data?.total_records || 0;

                    return (
                      <View key={s.id} style={styles.shiftCard}>
                        <View style={{ flex: 1 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <Text style={styles.shiftName} numberOfLines={1}>
                              {name}
                            </Text>
                            <View style={styles.shiftBadge}>
                              <Text style={styles.shiftBadgeText}>Đã chốt</Text>
                            </View>
                            {isOvernightShift(s) && (
                              <View style={styles.overnightBadge}>
                                <Ionicons name="moon" size={9} color="#fbbf24" />
                                <Text style={styles.overnightBadgeText}>
                                  Đóng ca ngày hôm sau ({formatDateTime(s.closed_at)})
                                </Text>
                              </View>
                            )}
                          </View>
                          <Text style={styles.shiftMeta}>
                            Chốt bởi: {s.closed_by_name || 'Nhân viên'} • {prodCount} SP • {recordsCount} đợt
                          </Text>
                        </View>

                        {onOpenShiftDetail && (
                          <TouchableOpacity
                            onPress={() => onOpenShiftDetail(s)}
                            style={styles.shiftDetailBtn}
                            activeOpacity={0.7}
                          >
                            <Ionicons name="eye-outline" size={14} color="#818cf8" />
                            <Text style={styles.shiftDetailBtnText}>Chi tiết ca</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 14,
    backgroundColor: '#1e293b',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#f8fafc',
  },
  headerSubtitle: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 3,
  },
  closeBtn: {
    padding: 8,
    borderRadius: 20,
    backgroundColor: '#334155',
  },
  centerBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 13,
    color: '#94a3b8',
  },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 12,
    overflow: 'hidden',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#1e293b',
  },
  cardHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#f1f5f9',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#818cf8',
  },
  cardBody: {
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  emptyText: {
    color: '#64748b',
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: 14,
    fontStyle: 'italic',
  },
  table: {
    borderRadius: 8,
    overflow: 'hidden',
  },
  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 6,
    backgroundColor: 'rgba(51, 65, 85, 0.6)',
    borderBottomWidth: 1,
    borderBottomColor: '#475569',
  },
  th: {
    fontSize: 10,
    fontWeight: '800',
    color: '#94a3b8',
    textTransform: 'uppercase',
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 9,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(51, 65, 85, 0.4)',
  },
  td: {
    fontSize: 12,
    color: '#e2e8f0',
  },
  prodName: {
    fontSize: 12,
    fontWeight: '700',
    color: '#f8fafc',
    lineHeight: 16,
  },
  unitBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    backgroundColor: 'rgba(99, 102, 241, 0.25)',
  },
  unitBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#a5b4fc',
  },
  jobsList: {
    marginTop: 4,
    gap: 3,
  },
  jobItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  jobNameText: {
    fontSize: 10,
    color: '#94a3b8',
    fontWeight: '600',
    flexShrink: 1,
  },
  jobQtyBreakdown: {
    fontSize: 9,
    fontWeight: '800',
    color: '#cbd5e1',
  },
  shiftCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 9,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    borderRadius: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  shiftName: {
    fontSize: 12,
    fontWeight: '700',
    color: '#f8fafc',
    flexShrink: 1,
  },
  shiftBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: 'rgba(34, 197, 94, 0.2)',
  },
  shiftBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#4ade80',
  },
  shiftMeta: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 2,
  },
  shiftDetailBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: 'rgba(99, 102, 241, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.3)',
  },
  shiftDetailBtnText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#a5b4fc',
  },
  overnightBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.35)',
  },
  overnightBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#fbbf24',
  },
});

