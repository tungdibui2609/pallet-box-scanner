import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  DeliveryShift,
  JournalRecord,
  SubShift,
  reopenShift,
  deleteShift,
} from '../../services/operationsService';

interface Props {
  visible: boolean;
  shift: DeliveryShift | null;
  journals: JournalRecord[];
  subShifts: SubShift[];
  loading: boolean;
  onClose: () => void;
  onRefreshAll: () => Promise<void>;
}

// Helper chuẩn hóa nhãn đơn vị
function standardizeUnitLabel(u?: string | null): string {
  if (!u) return '';
  const norm = u.trim().toLowerCase();
  if (norm === 'thùng' || norm === 'thung') return 'Thùng (20kg)';
  return u.trim();
}

// Helper chuyển chuỗi thời gian thành timestamp
function toTimestamp(dateStr?: string | null): number {
  if (!dateStr) return 0;
  let s = String(dateStr).trim();
  if (s.includes(' ')) s = s.replace(' ', 'T');
  if (/[+-]\d{2}$/.test(s)) s = `${s}:00`;
  const t = new Date(s).getTime();
  if (!isNaN(t)) return t;
  const fallback = new Date(dateStr).getTime();
  return isNaN(fallback) ? 0 : fallback;
}

// Helper định dạng ngày giờ chuẩn Việt Nam
function formatDateTime(isoString?: string | null): string {
  if (!isoString) return '-';
  try {
    const ts = toTimestamp(isoString);
    if (!ts) return isoString;
    const d = new Date(ts);
    const time = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const date = d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    return `${time} ${date}`;
  } catch {
    return isoString;
  }
}

// Helper khoảng thời gian
function formatCompactRange(fromIso?: string | null, toIso?: string | null): string {
  if (!fromIso || !toIso) return '-';
  try {
    const fTs = toTimestamp(fromIso);
    const tTs = toTimestamp(toIso);
    const f = new Date(fTs || fromIso);
    const t = new Date(tTs || toIso);
    const fStr = f.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const tStr = t.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const dStr = t.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
    return `${fStr} - ${tStr} (${dStr})`;
  } catch {
    return `${fromIso} - ${toIso}`;
  }
}

// Helper làm sạch ghi chú
function cleanUserNotes(notes?: string | null): string {
  if (!notes) return '';
  return notes
    .replace(/\[CV_ID:\s*[^\]]+\]/gi, '')
    .replace(/\[PID:\s*[^\]]+\]/gi, '')
    .replace(/\[SKU:\s*[^\]]*\]/gi, '')
    .replace(/\[CV:\s*[^\]]+\]/gi, '')
    .replace(/Nhập kho|Xuất kho/gi, '')
    .replace(/^[\s-]+/, '')
    .trim();
}

export default function PastShiftDetailModal({
  visible,
  shift,
  journals,
  subShifts,
  loading,
  onClose,
  onRefreshAll,
}: Props) {
  const insets = useSafeAreaInsets();
  // Tab: 'summary' (Báo cáo tổng hợp) | 'feed' (Lịch sử các đợt phát sinh)
  const [activeTab, setActiveTab] = useState<'summary' | 'feed'>('summary');
  const [journalFilter, setJournalFilter] = useState<'all' | 'in' | 'out'>('all');

  // Trạng thái thu / mở rộng (mặc định là thu)
  const [expandUnitSummary, setExpandUnitSummary] = useState(false);
  const [expandProductSummary, setExpandProductSummary] = useState(false);
  const [expandSubShiftsSummary, setExpandSubShiftsSummary] = useState(false);
  const [expandedSubShifts, setExpandedSubShifts] = useState<Record<string, boolean>>({});

  const [actionLoading, setActionLoading] = useState(false);

  // Tổng hợp theo ĐVT (Hook phải gọi trước bất kỳ return điều kiện nào)
  const unitSummaryList = useMemo(() => {
    const unitMap: Record<string, { unit: string; inQty: number; outQty: number }> = {};
    (journals || []).forEach(j => {
      const rawUnit = (j.unit || 'Thùng (20kg)').trim();
      const u = standardizeUnitLabel(rawUnit);
      if (!unitMap[u]) unitMap[u] = { unit: u, inQty: 0, outQty: 0 };
      const isImport = j.to_department === 'Kho' || (j.notes && j.notes.includes('Nhập kho'));
      const qty = Number(j.quantity_sent || (j as any).result_quantity || 0);
      if (isImport) unitMap[u].inQty += qty;
      else unitMap[u].outQty += qty;
    });
    return Object.values(unitMap);
  }, [journals]);

  // Tổng hợp theo Mặt hàng (Hook)
  const productSummaryList = useMemo(() => {
    const prodMap: Record<string, { name: string; unit: string; inQty: number; outQty: number }> = {};
    (journals || []).forEach(j => {
      const name = (j.item_name || '').trim();
      if (!name) return;
      const rawUnit = (j.unit || 'Thùng (20kg)').trim();
      const u = standardizeUnitLabel(rawUnit);
      const key = `${name}___${u}`;
      if (!prodMap[key]) prodMap[key] = { name, unit: u, inQty: 0, outQty: 0 };
      const isImport = j.to_department === 'Kho' || (j.notes && j.notes.includes('Nhập kho'));
      const qty = Number(j.quantity_sent || (j as any).result_quantity || 0);
      if (isImport) prodMap[key].inQty += qty;
      else prodMap[key].outQty += qty;
    });
    return Object.values(prodMap);
  }, [journals]);

  // Lọc nhật ký (Hook)
  const filteredJournals = useMemo(() => {
    if (!journals) return [];
    if (journalFilter === 'in') {
      return journals.filter(l => l.to_department === 'Kho' || (l.notes && l.notes.includes('Nhập kho')));
    }
    if (journalFilter === 'out') {
      return journals.filter(l => l.to_department !== 'Kho' && (!l.notes || !l.notes.includes('Nhập kho')));
    }
    return journals;
  }, [journals, journalFilter]);

  if (!shift) return null;

  const jobName = shift.summary_data?.job_name || shift.notes || 'Công việc';
  const openTime = formatDateTime(shift.opened_at);
  const closeTime = formatDateTime(shift.closed_at);
  const orderType = shift.summary_data?.order_type_name;
  const orderCode = shift.summary_data?.order_type_code;

  // Xử lý mở lại ca
  const handleReopen = () => {
    Alert.alert(
      'Mở lại công việc',
      `Bạn có chắc chắn muốn mở lại công việc "${jobName}" để tiếp tục ghi nhận số liệu không?`,
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Mở Lại',
          onPress: async () => {
            setActionLoading(true);
            try {
              await reopenShift(shift.id);
              await onRefreshAll();
              onClose();
              Alert.alert('Thành công', `Đã mở lại công việc "${jobName}".`);
            } catch (e: any) {
              Alert.alert('Lỗi', e?.message || 'Không thể mở lại công việc.');
            } finally {
              setActionLoading(false);
            }
          },
        },
      ]
    );
  };

  // Xử lý xóa ca
  const handleDelete = () => {
    Alert.alert(
      'Xóa công việc',
      `Bạn có chắc chắn muốn xóa vĩnh viễn công việc "${jobName}" và toàn bộ ${journals.length} lượt ghi nhận liên quan không?`,
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Xóa Vĩnh Viễn',
          style: 'destructive',
          onPress: async () => {
            setActionLoading(true);
            try {
              await deleteShift(shift.id);
              await onRefreshAll();
              onClose();
              Alert.alert('Thành công', 'Đã xóa công việc.');
            } catch (e: any) {
              Alert.alert('Lỗi', e?.message || 'Không thể xóa công việc.');
            } finally {
              setActionLoading(false);
            }
          },
        },
      ]
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        {/* ── TOP HEADER ── */}
        <View style={[styles.header, { paddingTop: Math.max(insets.top, 14) }]}>
          <TouchableOpacity onPress={onClose} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color="#f8fafc" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {jobName}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
              <View style={styles.badgeDone}>
                <Text style={styles.badgeDoneText}>ĐÃ HOÀN THÀNH</Text>
              </View>
              <Text style={styles.headerSubtitle}>
                {journals.length} lượt phát sinh
              </Text>
            </View>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Ionicons name="close" size={20} color="#94a3b8" />
          </TouchableOpacity>
        </View>

        {/* ── THẺ THÔNG TIN CHUNG ── */}
        <View style={styles.infoCard}>
          <View style={styles.infoRow}>
            <Ionicons name="calendar-outline" size={13} color="#94a3b8" />
            <Text style={styles.infoText}>
              Mở: <Text style={{ color: '#cbd5e1' }}>{openTime}</Text>
            </Text>
          </View>
          <View style={styles.infoRow}>
            <Ionicons name="checkmark-done-circle-outline" size={13} color="#4ade80" />
            <Text style={styles.infoText}>
              Đóng: <Text style={{ color: '#cbd5e1' }}>{closeTime}</Text> • Bởi: <Text style={{ color: '#cbd5e1' }}>{shift.closed_by_name || 'Nhân viên'}</Text>
            </Text>
          </View>
          {shift.opened_at && shift.closed_at && new Date(shift.opened_at).toDateString() !== new Date(shift.closed_at).toDateString() && (
            <View style={styles.overnightNoticeRow}>
              <Ionicons name="moon" size={13} color="#fbbf24" />
              <Text style={styles.overnightNoticeText}>
                Chú ý: Mở ca ngày {formatDateTime(shift.opened_at).split(' ')[1] || ''} và đóng ca vào ngày hôm sau ({closeTime}).
              </Text>
            </View>
          )}
          {orderType && (
            <View style={styles.infoRow}>
              <Ionicons name="document-text-outline" size={13} color="#818cf8" />
              <Text style={[styles.infoText, { color: '#818cf8', fontWeight: '700' }]}>
                Loại phiếu: {orderCode ? `${orderCode} - ` : ''}{orderType}
              </Text>
            </View>
          )}
          {shift.notes ? (
            <View style={styles.infoRow}>
              <Ionicons name="chatbubble-ellipses-outline" size={13} color="#94a3b8" />
              <Text style={styles.infoText}>
                Ghi chú: <Text style={{ color: '#cbd5e1', fontStyle: 'italic' }}>{shift.notes}</Text>
              </Text>
            </View>
          ) : null}
        </View>

        {/* ── 2 TAB NỘI DUNG: BÁO CÁO TỔNG HỢP / LỊCH SỬ PHÁT SINH ── */}
        <View style={styles.tabBar}>
          <TouchableOpacity
            onPress={() => setActiveTab('summary')}
            style={[styles.tabBtn, activeTab === 'summary' && styles.tabBtnActive]}
          >
            <Ionicons
              name="bar-chart"
              size={15}
              color={activeTab === 'summary' ? '#6366f1' : '#94a3b8'}
            />
            <Text style={[styles.tabBtnText, activeTab === 'summary' && styles.tabBtnTextActive]}>
              Báo cáo tổng hợp
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => setActiveTab('feed')}
            style={[styles.tabBtn, activeTab === 'feed' && styles.tabBtnActive]}
          >
            <Ionicons
              name="time"
              size={15}
              color={activeTab === 'feed' ? '#6366f1' : '#94a3b8'}
            />
            <Text style={[styles.tabBtnText, activeTab === 'feed' && styles.tabBtnTextActive]}>
              Lịch sử các đợt ({journals.length})
            </Text>
          </TouchableOpacity>
        </View>

        {/* ── BODY NỘI DUNG CUỘN ── */}
        {loading ? (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color="#6366f1" />
            <Text style={styles.loadingText}>Đang tải chi tiết báo cáo...</Text>
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 90 }}>
            {/* ── TAB 1: BÁO CÁO TỔNG HỢP ── */}
            {activeTab === 'summary' && (
              <View style={{ gap: 10 }}>
                {/* 1. Chi tiết theo Mặt hàng */}
                <View style={styles.accordionCard}>
                  <TouchableOpacity
                    onPress={() => setExpandProductSummary(prev => !prev)}
                    style={styles.accordionHeader}
                    activeOpacity={0.7}
                  >
                    <View style={styles.accordionHeaderLeft}>
                      <Ionicons name="cube-outline" size={16} color="#38bdf8" />
                      <Text style={styles.accordionTitle}>1. Chi tiết theo Mặt Hàng</Text>
                      <View style={styles.accordionBadge}>
                        <Text style={styles.accordionBadgeText}>{productSummaryList.length} SP</Text>
                      </View>
                    </View>
                    <Ionicons
                      name={expandProductSummary ? 'chevron-up' : 'chevron-down'}
                      size={18}
                      color="#94a3b8"
                    />
                  </TouchableOpacity>

                  {expandProductSummary && (
                    <View style={styles.accordionBody}>
                      {productSummaryList.length === 0 ? (
                        <Text style={styles.emptyText}>Chưa có phát sinh số liệu trong ca này.</Text>
                      ) : (
                        <View style={styles.summaryTable}>
                          <View style={styles.summaryTableHeader}>
                            <Text style={[styles.summaryTh, { flex: 3 }]}>Sản phẩm / ĐVT</Text>
                            <Text style={[styles.summaryTh, { flex: 1, textAlign: 'right', color: '#4ade80' }]}>Nhập (+)</Text>
                            <Text style={[styles.summaryTh, { flex: 1, textAlign: 'right', color: '#f87171' }]}>Xuất (-)</Text>
                          </View>
                          {productSummaryList.map(row => (
                            <View key={`${row.name}_${row.unit}`} style={styles.summaryTableRow}>
                              <View style={{ flex: 3 }}>
                                <Text style={[styles.summaryTd, { fontWeight: '700', color: '#f8fafc' }]} numberOfLines={2}>
                                  {row.name}
                                </Text>
                                <Text style={{ fontSize: 10, color: '#a5b4fc', fontWeight: '800' }}>
                                  {row.unit}
                                </Text>
                              </View>
                              <Text style={[styles.summaryTd, { flex: 1, textAlign: 'right', color: '#4ade80', fontWeight: '800' }]}>+{row.inQty}</Text>
                              <Text style={[styles.summaryTd, { flex: 1, textAlign: 'right', color: '#f87171', fontWeight: '800' }]}>-{row.outQty}</Text>
                            </View>
                          ))}
                        </View>
                      )}
                    </View>
                  )}
                </View>

                {/* 2. Tổng hợp theo Đơn vị tính */}
                <View style={styles.accordionCard}>
                  <TouchableOpacity
                    onPress={() => setExpandUnitSummary(prev => !prev)}
                    style={styles.accordionHeader}
                    activeOpacity={0.7}
                  >
                    <View style={styles.accordionHeaderLeft}>
                      <Ionicons name="layers-outline" size={16} color="#818cf8" />
                      <Text style={styles.accordionTitle}>2. Tổng hợp theo Đơn Vị Tính</Text>
                      <View style={styles.accordionBadge}>
                        <Text style={styles.accordionBadgeText}>{unitSummaryList.length} ĐVT</Text>
                      </View>
                    </View>
                    <Ionicons
                      name={expandUnitSummary ? 'chevron-up' : 'chevron-down'}
                      size={18}
                      color="#94a3b8"
                    />
                  </TouchableOpacity>

                  {expandUnitSummary && (
                    <View style={styles.accordionBody}>
                      {unitSummaryList.length === 0 ? (
                        <Text style={styles.emptyText}>Chưa có phát sinh số liệu trong ca này.</Text>
                      ) : (
                        <View style={styles.summaryTable}>
                          <View style={styles.summaryTableHeader}>
                            <Text style={[styles.summaryTh, { flex: 2 }]}>Đơn vị</Text>
                            <Text style={[styles.summaryTh, { flex: 1, textAlign: 'right', color: '#4ade80' }]}>Nhập (+)</Text>
                            <Text style={[styles.summaryTh, { flex: 1, textAlign: 'right', color: '#f87171' }]}>Xuất (-)</Text>
                          </View>
                          {unitSummaryList.map(row => (
                            <View key={row.unit} style={styles.summaryTableRow}>
                              <Text style={[styles.summaryTd, { flex: 2, fontWeight: '700', color: '#f8fafc' }]}>{row.unit}</Text>
                              <Text style={[styles.summaryTd, { flex: 1, textAlign: 'right', color: '#4ade80', fontWeight: '800' }]}>+{row.inQty}</Text>
                              <Text style={[styles.summaryTd, { flex: 1, textAlign: 'right', color: '#f87171', fontWeight: '800' }]}>-{row.outQty}</Text>
                            </View>
                          ))}
                        </View>
                      )}
                    </View>
                  )}
                </View>

                {/* 3. Các lần chốt ca tạm */}
                <View style={styles.accordionCard}>
                  <TouchableOpacity
                    onPress={() => setExpandSubShiftsSummary(prev => !prev)}
                    style={styles.accordionHeader}
                    activeOpacity={0.7}
                  >
                    <View style={styles.accordionHeaderLeft}>
                      <Ionicons name="time-outline" size={16} color="#f59e0b" />
                      <Text style={styles.accordionTitle}>3. Các Lần Chốt Ca Tạm</Text>
                      <View style={[styles.accordionBadge, { backgroundColor: 'rgba(245, 158, 11, 0.2)' }]}>
                        <Text style={[styles.accordionBadgeText, { color: '#fbbf24' }]}>{subShifts.length} Đợt</Text>
                      </View>
                    </View>
                    <Ionicons
                      name={expandSubShiftsSummary ? 'chevron-up' : 'chevron-down'}
                      size={18}
                      color="#94a3b8"
                    />
                  </TouchableOpacity>

                  {expandSubShiftsSummary && (
                    <View style={styles.accordionBody}>
                      {subShifts.length === 0 ? (
                        <Text style={styles.emptyText}>Công việc này không có đợt chốt ca tạm nào.</Text>
                      ) : (
                        <View style={styles.subShiftSummaryBox}>
                          {subShifts.map(ss => (
                            <View key={ss.id} style={styles.subShiftSummaryRow}>
                              <View style={{ flex: 1 }}>
                                <Text style={styles.subShiftSummaryTitle}>
                                  Đợt #{ss.sub_shift_number}: {ss.notes || 'Chốt tạm'}
                                </Text>
                                <Text style={styles.subShiftSummaryTime}>
                                  {formatCompactRange(ss.from_time, ss.to_time)} • Bởi: {ss.closed_by_name || 'Nhân viên'}
                                </Text>
                              </View>
                            </View>
                          ))}
                        </View>
                      )}
                    </View>
                  )}
                </View>
              </View>
            )}

            {/* ── TAB 2: LỊCH SỬ CÁC ĐỢT PHÁT SINH ── */}
            {activeTab === 'feed' && (
              <View style={{ gap: 8 }}>
                {/* 3 Nút lọc */}
                <View style={styles.filterPillsRow}>
                  <TouchableOpacity
                    onPress={() => setJournalFilter('all')}
                    style={[styles.filterPill, journalFilter === 'all' && styles.filterPillAllActive]}
                  >
                    <Text style={[styles.filterPillText, journalFilter === 'all' && styles.filterPillTextWhite]}>
                      Tất cả ({journals.length})
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={() => setJournalFilter('in')}
                    style={[styles.filterPill, journalFilter === 'in' && styles.filterPillInActive]}
                  >
                    <Text style={[styles.filterPillArrow, journalFilter === 'in' ? styles.filterPillTextWhite : { color: '#4ade80' }]}>↙</Text>
                    <Text style={[styles.filterPillText, journalFilter === 'in' ? styles.filterPillTextWhite : { color: '#4ade80' }]}>
                      Nhập ({journals.filter(l => l.to_department === 'Kho' || (l.notes && l.notes.includes('Nhập kho'))).length})
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={() => setJournalFilter('out')}
                    style={[styles.filterPill, journalFilter === 'out' && styles.filterPillOutActive]}
                  >
                    <Text style={[styles.filterPillArrow, journalFilter === 'out' ? styles.filterPillTextWhite : { color: '#f87171' }]}>↗</Text>
                    <Text style={[styles.filterPillText, journalFilter === 'out' ? styles.filterPillTextWhite : { color: '#f87171' }]}>
                      Xuất ({journals.filter(l => l.to_department !== 'Kho' && (!l.notes || !l.notes.includes('Nhập kho'))).length})
                    </Text>
                  </TouchableOpacity>
                </View>

                {filteredJournals.length === 0 ? (
                  <View style={styles.centerBox}>
                    <Text style={styles.emptyText}>Không có lượt ghi nhận nào khớp bộ lọc.</Text>
                  </View>
                ) : (
                  filteredJournals.map(record => {
                    const isImport = record.to_department === 'Kho' || (record.notes && record.notes.includes('Nhập kho'));
                    const userNote = cleanUserNotes(record.notes);
                    const rawUnit = record.unit || 'Thùng (20kg)';
                    const stdUnit = standardizeUnitLabel(rawUnit);

                    return (
                      <View key={record.id} style={styles.journalRow}>
                        <View style={[styles.arrowCircle, isImport ? styles.arrowCircleIn : styles.arrowCircleOut]}>
                          <Text style={[styles.arrowCircleText, isImport ? styles.arrowCircleTextIn : styles.arrowCircleTextOut]}>
                            {isImport ? '↙' : '↗'}
                          </Text>
                        </View>

                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.journalItemName} numberOfLines={2}>
                            {record.item_name}
                          </Text>

                          <View style={styles.journalRowMid}>
                            <View style={[styles.qtyBadge, isImport ? styles.qtyBadgeIn : styles.qtyBadgeOut]}>
                              <Text style={[styles.qtyBadgeText, isImport ? styles.qtyBadgeTextIn : styles.qtyBadgeTextOut]}>
                                {isImport ? `+${record.quantity_sent}` : `-${record.quantity_sent}`} {stdUnit}
                              </Text>
                            </View>
                          </View>

                          <Text style={styles.journalMetaText}>
                            {formatDateTime(record.sent_at)} • {record.sent_by_name || 'Nhân viên'}
                            {userNote ? ` • 💬 ${userNote}` : ''}
                          </Text>
                        </View>
                      </View>
                    );
                  })
                )}
              </View>
            )}
          </ScrollView>
        )}

        {/* ── FOOTER HÀNH ĐỘNG: MỞ LẠI CA / XÓA CA ── */}
        <View style={[styles.footerBar, { paddingBottom: Math.max(insets.bottom, 12) + 8 }]}>
          <TouchableOpacity
            onPress={handleReopen}
            style={styles.reopenBtn}
            disabled={actionLoading}
          >
            <Ionicons name="play-outline" size={16} color="#fff" />
            <Text style={styles.reopenBtnText}>Mở Lại Công Việc</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleDelete}
            style={styles.deleteBtn}
            disabled={actionLoading}
          >
            <Ionicons name="trash-outline" size={16} color="#f43f5e" />
          </TouchableOpacity>
        </View>
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
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 10,
    backgroundColor: '#1e293b',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    gap: 10,
  },
  backBtn: {
    padding: 6,
  },
  closeBtn: {
    padding: 6,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#f8fafc',
  },
  headerSubtitle: {
    fontSize: 11,
    color: '#94a3b8',
  },
  badgeDone: {
    backgroundColor: '#14532d',
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 4,
  },
  badgeDoneText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#4ade80',
  },
  infoCard: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    gap: 4,
  },
  overnightNoticeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.35)',
    marginTop: 2,
  },
  overnightNoticeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#fbbf24',
    flexShrink: 1,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  infoText: {
    fontSize: 11,
    color: '#94a3b8',
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#0f172a',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  tabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabBtnActive: {
    borderBottomColor: '#6366f1',
    backgroundColor: '#1e293b',
  },
  tabBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#94a3b8',
  },
  tabBtnTextActive: {
    color: '#f8fafc',
    fontWeight: '800',
  },
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
  },
  loadingText: {
    fontSize: 12,
    color: '#94a3b8',
    marginTop: 8,
  },
  emptyText: {
    fontSize: 12,
    color: '#64748b',
    textAlign: 'center',
    paddingVertical: 10,
    fontStyle: 'italic',
  },
  accordionCard: {
    backgroundColor: '#0f172a',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
    overflow: 'hidden',
  },
  accordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1e293b',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  accordionHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  accordionTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#f8fafc',
    letterSpacing: 0.3,
  },
  accordionBadge: {
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  accordionBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#a5b4fc',
  },
  accordionBody: {
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  summaryTable: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    overflow: 'hidden',
  },
  summaryTableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  summaryTh: {
    fontSize: 11,
    fontWeight: '800',
    color: '#94a3b8',
  },
  summaryTableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  summaryTd: {
    fontSize: 11,
    color: '#cbd5e1',
  },
  subShiftSummaryBox: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    padding: 10,
    gap: 8,
  },
  subShiftSummaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    paddingBottom: 6,
  },
  subShiftSummaryTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#f59e0b',
  },
  subShiftSummaryTime: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 2,
  },
  filterPillsRow: {
    flexDirection: 'row',
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 4,
    gap: 4,
    marginBottom: 6,
  },
  filterPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 6,
    borderRadius: 8,
  },
  filterPillAllActive: {
    backgroundColor: '#334155',
  },
  filterPillInActive: {
    backgroundColor: '#16a34a',
  },
  filterPillOutActive: {
    backgroundColor: '#dc2626',
  },
  filterPillText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#94a3b8',
  },
  filterPillTextWhite: {
    color: '#fff',
  },
  filterPillArrow: {
    fontSize: 12,
    fontWeight: '900',
  },
  journalRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  arrowCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  arrowCircleIn: {
    backgroundColor: 'rgba(34, 197, 94, 0.15)',
  },
  arrowCircleOut: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
  },
  arrowCircleText: {
    fontSize: 14,
    fontWeight: '900',
    lineHeight: 16,
  },
  arrowCircleTextIn: {
    color: '#22c55e',
  },
  arrowCircleTextOut: {
    color: '#ef4444',
  },
  journalItemName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#f8fafc',
    lineHeight: 18,
  },
  journalRowMid: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 4,
  },
  qtyBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  qtyBadgeIn: {
    backgroundColor: 'rgba(34, 197, 94, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(74, 222, 128, 0.3)',
  },
  qtyBadgeOut: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.3)',
  },
  qtyBadgeText: {
    fontSize: 12,
    fontWeight: '900',
  },
  qtyBadgeTextIn: {
    color: '#4ade80',
  },
  qtyBadgeTextOut: {
    color: '#f87171',
  },
  journalMetaText: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 2,
  },
  footerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#1e293b',
    borderTopWidth: 1,
    borderTopColor: '#334155',
    gap: 10,
  },
  reopenBtn: {
    flex: 1,
    height: 42,
    borderRadius: 10,
    backgroundColor: '#16a34a',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  reopenBtnText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#fff',
  },
  deleteBtn: {
    width: 42,
    height: 42,
    borderRadius: 10,
    backgroundColor: 'rgba(244, 63, 94, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(244, 63, 94, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

