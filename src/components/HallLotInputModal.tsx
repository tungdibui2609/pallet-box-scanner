import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Modal,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { submitHallLotUpdate, syncOfflineHallLotUpdates } from '../services/supabase';

export interface HallOption {
  id: string;
  name: string;
  warehouse_id?: string | null;
  warehouse_name?: string | null;
  full_path: string; // VD: "Kho Đông 1 › SẢNH 1"
}

export interface ExcelLotRow {
  id: string;
  seq: string;
  info: string;
  tag: string;
  date: string;
  dates?: string[];
}

export type InputMode = 'QUICK_SEQ' | 'EXCEL_TABLE';

export interface HallLotInputModalProps {
  visible: boolean;
  onClose: () => void;
  initialHall?: {
    id?: string | null;
    name?: string;
    warehouse_id?: string | null;
    warehouse_name?: string | null;
    full_path?: string;
  } | null;
  availableHalls: HallOption[];
  onSuccessToast?: (msg: string) => void;
}

export default function HallLotInputModal({
  visible,
  onClose,
  initialHall,
  availableHalls,
  onSuccessToast,
}: HallLotInputModalProps) {
  const [selectedHall, setSelectedHall] = useState<HallOption | null>(null);
  const [selectedWhFilter, setSelectedWhFilter] = useState<string>('ALL');
  const [isCustomHall, setIsCustomHall] = useState(false);
  const [customHallName, setCustomHallName] = useState('');
  
  // Chế độ nhập: Nhập nhanh STT vs Bảng chi tiết Excel
  const [inputMode, setInputMode] = useState<InputMode>('QUICK_SEQ');
  const [inputText, setInputText] = useState('');
  const [lotSeqs, setLotSeqs] = useState<string[]>([]);
  
  const getTodayStr = () => {
    const d = new Date();
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  };

  const parseDatesFromString = (dateStr: string): string[] => {
    if (!dateStr) return [];
    return dateStr
      .split(/[,;\n]/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
  };

  const createEmptyRow = (seqIndex: number): ExcelLotRow => {
    const today = getTodayStr();
    return {
      id: Math.random().toString(36).substring(2, 9),
      seq: String(seqIndex),
      info: '',
      tag: '',
      date: today,
      dates: [today],
    };
  };

  const [excelRows, setExcelRows] = useState<ExcelLotRow[]>([
    createEmptyRow(1),
  ]);

  // State Modal Lịch chọn ngày (Hỗ trợ chọn nhiều ngày)
  const [calendarTargetRowId, setCalendarTargetRowId] = useState<string | null>(null);
  const [calendarSelectedDates, setCalendarSelectedDates] = useState<string[]>([]);
  const [calendarYear, setCalendarYear] = useState<number>(new Date().getFullYear());
  const [calendarMonth, setCalendarMonth] = useState<number>(new Date().getMonth());

  // Tính ma trận ngày trong tháng cho lịch (Thứ 2 đến CN)
  const calendarDaysData = useMemo(() => {
    const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
    const firstDayIndex = new Date(calendarYear, calendarMonth, 1).getDay(); // 0 = CN, 1 = T2
    const offset = firstDayIndex === 0 ? 6 : firstDayIndex - 1;

    const days: (number | null)[] = [];
    for (let i = 0; i < offset; i++) {
      days.push(null);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      days.push(d);
    }
    return days;
  }, [calendarYear, calendarMonth]);

  const handleOpenCalendar = (row: ExcelLotRow) => {
    const currentDates = (row.dates && row.dates.length > 0)
      ? [...row.dates]
      : parseDatesFromString(row.date);

    setCalendarSelectedDates(currentDates);
    setCalendarTargetRowId(row.id);

    if (currentDates.length > 0) {
      const parts = currentDates[0].split('/');
      if (parts.length === 3) {
        const m = parseInt(parts[1], 10) - 1;
        const y = parseInt(parts[2], 10);
        if (!isNaN(m) && !isNaN(y)) {
          setCalendarMonth(m);
          setCalendarYear(y);
          return;
        }
      }
    }
    const now = new Date();
    setCalendarMonth(now.getMonth());
    setCalendarYear(now.getFullYear());
  };

  const handleToggleDate = (day: number) => {
    const dStr = String(day).padStart(2, '0');
    const mStr = String(calendarMonth + 1).padStart(2, '0');
    const formatted = `${dStr}/${mStr}/${calendarYear}`;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCalendarSelectedDates(prev => {
      if (prev.includes(formatted)) {
        return prev.filter(d => d !== formatted);
      } else {
        return [...prev, formatted];
      }
    });
  };

  const handlePrevMonth = () => {
    if (calendarMonth === 0) {
      setCalendarMonth(11);
      setCalendarYear(calendarYear - 1);
    } else {
      setCalendarMonth(calendarMonth - 1);
    }
  };

  const handleNextMonth = () => {
    if (calendarMonth === 11) {
      setCalendarMonth(0);
      setCalendarYear(calendarYear + 1);
    } else {
      setCalendarMonth(calendarMonth + 1);
    }
  };

  const handleQuickAddDate = (type: 'today' | 'yesterday' | 'clear') => {
    if (type === 'clear') {
      setCalendarSelectedDates([]);
      return;
    }
    const d = new Date();
    if (type === 'yesterday') {
      d.setDate(d.getDate() - 1);
    }
    const dStr = String(d.getDate()).padStart(2, '0');
    const mStr = String(d.getMonth() + 1).padStart(2, '0');
    const formatted = `${dStr}/${mStr}/${d.getFullYear()}`;

    setCalendarSelectedDates(prev => {
      if (prev.includes(formatted)) return prev;
      return [...prev, formatted];
    });
    setCalendarMonth(d.getMonth());
    setCalendarYear(d.getFullYear());
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleConfirmCalendar = () => {
    if (!calendarTargetRowId) return;
    const dateStr = calendarSelectedDates.join(', ');
    setExcelRows(prev => prev.map(r => {
      if (r.id !== calendarTargetRowId) return r;
      return {
        ...r,
        date: dateStr,
        dates: calendarSelectedDates,
      };
    }));
    setCalendarTargetRowId(null);
  };

  const handleRemoveSingleDate = (rowId: string, dateToRemove: string) => {
    setExcelRows(prev => prev.map(r => {
      if (r.id !== rowId) return r;
      const currentDates = (r.dates && r.dates.length > 0)
        ? r.dates
        : parseDatesFromString(r.date);
      const updated = currentDates.filter(d => d !== dateToRemove);
      return {
        ...r,
        date: updated.join(', '),
        dates: updated,
      };
    }));
  };

  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Danh sách các kho cha duy nhất để làm bộ lọc
  const uniqueWarehouses = useMemo(() => {
    const map = new Map<string, string>();
    availableHalls.forEach(h => {
      if (h.warehouse_id && h.warehouse_name) {
        map.set(h.warehouse_id, h.warehouse_name);
      }
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [availableHalls]);

  // Lọc danh sách sảnh theo kho đang chọn
  const filteredHalls = useMemo(() => {
    if (selectedWhFilter === 'ALL') return availableHalls;
    return availableHalls.filter(h => h.warehouse_id === selectedWhFilter);
  }, [availableHalls, selectedWhFilter]);

  const handleSelectWarehouseFilter = (whId: string) => {
    setSelectedWhFilter(whId);
    if (whId !== 'ALL') {
      const hallsInWh = availableHalls.filter(h => h.warehouse_id === whId);
      if (hallsInWh.length > 0 && selectedHall?.warehouse_id !== whId) {
        setSelectedHall(hallsInWh[0]);
      }
    }
  };

  useEffect(() => {
    if (visible) {
      if (initialHall) {
        // Tìm sảnh khớp trong danh sách theo thứ tự ưu tiên chặt chẽ:
        // 1. Khớp chính xác ID (nếu có id hợp lệ và khác 'custom')
        let matched = (initialHall.id && initialHall.id !== 'custom')
          ? availableHalls.find(h => h.id === initialHall.id)
          : null;

        // 2. Khớp theo cả Kho cha (warehouse_id) VÀ Tên Sảnh
        if (!matched && initialHall.warehouse_id && initialHall.name) {
          const normName = initialHall.name.trim().toUpperCase();
          matched = availableHalls.find(
            h => h.warehouse_id === initialHall.warehouse_id &&
                 h.name.trim().toUpperCase() === normName
          );
        }

        // 3. Khớp theo full_path (ví dụ "KHO 2 › SẢNH 1" hoặc "KHO 2 > SẢNH 1")
        if (!matched && initialHall.full_path) {
          const normPath = initialHall.full_path.replace(/[›>]/g, '>').replace(/\s+/g, ' ').trim().toUpperCase();
          matched = availableHalls.find(
            h => h.full_path.replace(/[›>]/g, '>').replace(/\s+/g, ' ').trim().toUpperCase() === normPath
          );
        }

        if (matched) {
          setSelectedHall(matched);
          if (matched.warehouse_id) setSelectedWhFilter(matched.warehouse_id);
        } else {
          const fallbackWhId = initialHall.warehouse_id || null;
          setSelectedHall({
            id: initialHall.id || 'custom',
            name: initialHall.name || 'Sảnh',
            warehouse_id: fallbackWhId,
            warehouse_name: initialHall.warehouse_name || null,
            full_path: initialHall.full_path || initialHall.name || 'Sảnh',
          });
          if (fallbackWhId) {
            setSelectedWhFilter(fallbackWhId);
          }
        }
        setIsCustomHall(false);
      } else if (availableHalls.length > 0) {
        setSelectedHall(availableHalls[0]);
        if (availableHalls[0].warehouse_id) setSelectedWhFilter(availableHalls[0].warehouse_id);
        setIsCustomHall(false);
      } else {
        setIsCustomHall(true);
      }

      setLotSeqs([]);
      setInputText('');
      setNotes('');
      setCustomHallName('');
      setExcelRows([createEmptyRow(1)]);

      // Tự động đẩy dữ liệu ngoại tuyến còn tồn đọng (nếu có mạng)
      syncOfflineHallLotUpdates().catch(() => {});
    }
  }, [visible, initialHall, availableHalls]);

  const handleAddSeqs = (text: string) => {
    if (!text.trim()) return;
    const rawTokens = text.split(/[\s,;|\n\r]+/);
    const newItems: string[] = [];

    rawTokens.forEach(t => {
      const cleaned = t.trim().replace(/^#/, '');
      if (cleaned.length > 0) {
        newItems.push(cleaned.toUpperCase());
      }
    });

    if (newItems.length > 0) {
      setLotSeqs(prev => {
        const set = new Set(prev);
        newItems.forEach(item => set.add(item));
        return Array.from(set).sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
        );
      });
      setInputText('');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const handleRemoveSeq = (seq: string) => {
    setLotSeqs(prev => prev.filter(s => s !== seq));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  // Thao tác với Bảng Excel
  const handleAddRow = () => {
    setExcelRows(prev => [...prev, createEmptyRow(prev.length + 1)]);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleRemoveRow = (id: string) => {
    setExcelRows(prev => {
      if (prev.length <= 1) return [createEmptyRow(1)];
      const filtered = prev.filter(r => r.id !== id);
      return filtered.map((r, idx) => ({ ...r, seq: r.seq || String(idx + 1) }));
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleUpdateRow = (id: string, field: keyof ExcelLotRow, val: string) => {
    setExcelRows(prev => prev.map(r => r.id === id ? { ...r, [field]: val } : r));
  };

  const handleSubmit = async () => {
    const finalHallName = (isCustomHall ? customHallName : (selectedHall?.full_path || selectedHall?.name || '')).trim();
    if (!finalHallName) {
      Alert.alert('Thông báo', 'Vui lòng chọn hoặc nhập Tên Sảnh!');
      return;
    }

    let payloadLotSeqs: any[] = [];
    let countTotal = 0;

    if (inputMode === 'QUICK_SEQ') {
      if (lotSeqs.length === 0) {
        Alert.alert('Thông báo', 'Vui lòng nhập ít nhất 1 STT LOT!');
        return;
      }
      payloadLotSeqs = lotSeqs;
      countTotal = lotSeqs.length;
    } else {
      const validRows = excelRows.filter(r => r.info.trim() || r.seq.trim() || r.tag.trim());
      if (validRows.length === 0) {
        Alert.alert('Thông báo', 'Vui lòng nhập thông tin cho ít nhất 1 dòng trong bảng!');
        return;
      }
      payloadLotSeqs = validRows;
      countTotal = validRows.length;
    }

    setSubmitting(true);
    try {
      const systemCode = (await AsyncStorage.getItem('config_system_code')) || 'KHO_DONG_LANH';
      const res = await submitHallLotUpdate({
        system_code: systemCode,
        hall_id: isCustomHall ? null : selectedHall?.id || null,
        hall_name: finalHallName,
        lot_seqs: payloadLotSeqs,
        notes: notes.trim() || undefined,
      });

      if (res.success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        const itemUnitName = inputMode === 'QUICK_SEQ' ? 'LOT' : 'dòng bảng';
        const successMsg = res.isOffline
          ? `Đã lưu ${countTotal} ${itemUnitName} ngoại tuyến (sẽ gửi khi có mạng)!`
          : `Đã gửi ${countTotal} ${itemUnitName} tại ${finalHallName} lên Web!`;
        if (onSuccessToast) {
          onSuccessToast(successMsg);
        } else {
          Alert.alert('Thành công', successMsg);
        }
        onClose();
      } else {
        Alert.alert('Lỗi', res.message);
      }
    } catch (e: any) {
      Alert.alert('Lỗi', e.message || 'Không thể gửi dữ liệu');
    } finally {
      setSubmitting(false);
    }
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            {/* Header */}
            <View style={styles.modalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
                <View style={styles.headerIconCircle}>
                  <Feather name="truck" size={18} color="#ffffff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.headerTitle} numberOfLines={1}>
                    CẬP NHẬT LOT Ở SẢNH
                  </Text>
                  <Text style={styles.headerSubtitle}>
                    Nhập nhanh STT (không cần quét QR)
                  </Text>
                </View>
              </View>

              <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                <Feather name="x" size={18} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ padding: 14 }} keyboardShouldPersistTaps="handled">
              {/* Chọn Sảnh & Đường dẫn phân cấp */}
              <View style={{ marginBottom: 14 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <Text style={styles.sectionLabel}>
                    SẢNH ĐANG KIỂM ĐẾM / CẬP NHẬT:
                  </Text>
                  {availableHalls.length > 0 && (
                    <TouchableOpacity onPress={() => setIsCustomHall(!isCustomHall)}>
                      <Text style={styles.toggleCustomText}>
                        {isCustomHall ? 'Chọn từ danh sách' : 'Tự nhập tên khác'}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>

                {isCustomHall || availableHalls.length === 0 ? (
                  <TextInput
                    value={customHallName}
                    onChangeText={setCustomHallName}
                    placeholder="VD: Kho Đông 1 › SẢNH 1 hoặc Cửa số 2..."
                    placeholderTextColor="#64748b"
                    style={styles.textInput}
                  />
                ) : (
                  <View style={{ gap: 8 }}>
                    {/* Bộ lọc Kho (nếu có nhiều hơn 1 kho) */}
                    {uniqueWarehouses.length > 1 && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={{ color: '#64748b', fontSize: 10, fontWeight: '700' }}>KHO:</Text>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4 }}>
                          <TouchableOpacity
                            onPress={() => handleSelectWarehouseFilter('ALL')}
                            style={[styles.whFilterPill, selectedWhFilter === 'ALL' && styles.whFilterPillActive]}
                          >
                            <Text style={[styles.whFilterPillText, selectedWhFilter === 'ALL' && styles.whFilterPillTextActive]}>
                              Tất cả ({availableHalls.length})
                            </Text>
                          </TouchableOpacity>
                          {uniqueWarehouses.map(wh => (
                            <TouchableOpacity
                              key={wh.id}
                              onPress={() => handleSelectWarehouseFilter(wh.id)}
                              style={[styles.whFilterPill, selectedWhFilter === wh.id && styles.whFilterPillActive]}
                            >
                              <Text style={[styles.whFilterPillText, selectedWhFilter === wh.id && styles.whFilterPillTextActive]}>
                                {wh.name}
                              </Text>
                            </TouchableOpacity>
                          ))}
                        </ScrollView>
                      </View>
                    )}

                    {/* Danh sách các Sảnh: Ghi rõ Kho cha › Tên Sảnh */}
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                      {filteredHalls.map(hall => {
                        const isSelected = selectedHall?.id === hall.id;
                        return (
                          <TouchableOpacity
                            key={hall.id}
                            onPress={() => setSelectedHall(hall)}
                            style={[
                              styles.hallPill,
                              isSelected && styles.hallPillActive,
                            ]}
                          >
                            <Text style={[styles.hallPillText, isSelected && styles.hallPillTextActive]}>
                              {hall.warehouse_name ? `[${hall.warehouse_name}] ` : ''}{hall.name}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>

                    {/* Banner hiển thị đường dẫn chính xác của Sảnh đang chọn */}
                    {selectedHall && (
                      <View style={styles.selectedHallBanner}>
                        <Feather name="map-pin" size={13} color="#38bdf8" />
                        <Text style={styles.selectedHallBannerText} numberOfLines={1}>
                          Đang chọn: <Text style={{ color: '#ffffff', fontWeight: '900' }}>{selectedHall.full_path || selectedHall.name}</Text>
                        </Text>
                      </View>
                    )}
                  </View>
                )}
              </View>

              {/* CHUYỂN CHẾ ĐỘ: NHẬP NHANH STT vs BẢNG CHI TIẾT EXCEL */}
              <View style={styles.modeSwitchWrap}>
                <TouchableOpacity
                  onPress={() => setInputMode('QUICK_SEQ')}
                  style={[styles.modeTab, inputMode === 'QUICK_SEQ' && styles.modeTabActive]}
                >
                  <Feather name="zap" size={13} color={inputMode === 'QUICK_SEQ' ? '#ffffff' : '#94a3b8'} />
                  <Text style={[styles.modeTabText, inputMode === 'QUICK_SEQ' && styles.modeTabTextActive]}>
                    Nhập nhanh STT
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => setInputMode('EXCEL_TABLE')}
                  style={[styles.modeTab, inputMode === 'EXCEL_TABLE' && styles.modeTabActive]}
                >
                  <Feather name="grid" size={13} color={inputMode === 'EXCEL_TABLE' ? '#ffffff' : '#94a3b8'} />
                  <Text style={[styles.modeTabText, inputMode === 'EXCEL_TABLE' && styles.modeTabTextActive]}>
                    Bảng chi tiết (Excel)
                  </Text>
                </TouchableOpacity>
              </View>

              {inputMode === 'QUICK_SEQ' ? (
                <>
                  {/* Ô Nhập STT */}
                  <View style={{ marginBottom: 14 }}>
                    <Text style={styles.sectionLabel}>
                      NHẬP STT CỦA CÁC LOT CÓ Ở SẢNH:
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <TextInput
                        value={inputText}
                        onChangeText={setInputText}
                        onSubmitEditing={() => handleAddSeqs(inputText)}
                        placeholder="VD: 1, 1A, 2B, L05 hoặc 1 2A 5..."
                        placeholderTextColor="#64748b"
                        keyboardType="default"
                        autoCapitalize="characters"
                        autoCorrect={false}
                        returnKeyType="done"
                        style={[styles.textInput, { flex: 1, fontSize: 15, fontWeight: '700' }]}
                      />
                      <TouchableOpacity
                        onPress={() => handleAddSeqs(inputText)}
                        style={styles.addBtn}
                      >
                        <Text style={styles.addBtnText}>THÊM</Text>
                      </TouchableOpacity>
                    </View>
                    <Text style={styles.tipText}>
                      💡 Mẹo: Nhập cả chữ và số (VD: 1, 1A, 2B, L05). Dán chuỗi cách nhau bởi dấu cách/phẩy.
                    </Text>
                  </View>

                  {/* Danh sách STT đã nhập */}
                  <View style={{ marginBottom: 14 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={{ color: '#e2e8f0', fontSize: 12, fontWeight: '800' }}>
                          DANH SÁCH LOT ĐÃ NHẬP
                        </Text>
                        <View style={styles.countBadge}>
                          <Text style={styles.countBadgeText}>
                            {lotSeqs.length} LOT
                          </Text>
                        </View>
                      </View>

                      {lotSeqs.length > 0 && (
                        <TouchableOpacity onPress={() => setLotSeqs([])}>
                          <Text style={{ color: '#f43f5e', fontSize: 11, fontWeight: '700' }}>Xóa hết</Text>
                        </TouchableOpacity>
                      )}
                    </View>

                    {lotSeqs.length === 0 ? (
                      <View style={styles.emptyBox}>
                        <Feather name="inbox" size={28} color="#475569" style={{ marginBottom: 6 }} />
                        <Text style={{ color: '#64748b', fontSize: 12, fontWeight: '600', textAlign: 'center' }}>
                          Chưa có STT nào. Hãy nhập STT vào ô phía trên.
                        </Text>
                      </View>
                    ) : (
                      <View style={styles.chipsContainer}>
                        {lotSeqs.map(seq => (
                          <View key={seq} style={styles.seqChip}>
                            <Text style={styles.seqChipText}>
                              #{seq}
                            </Text>
                            <TouchableOpacity onPress={() => handleRemoveSeq(seq)} style={{ padding: 2 }}>
                              <Feather name="x" size={14} color="#94a3b8" />
                            </TouchableOpacity>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                </>
              ) : (
                /* CHẾ ĐỘ BẢNG CHI TIẾT EXCEL (#, thông tin, tag, ngày) - Dạng Card thoáng rộng cho Mobile */
                <View style={{ marginBottom: 14 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={styles.sectionLabel}>
                        DANH SÁCH HÀNG KÊ KHAI:
                      </Text>
                      <View style={styles.countBadge}>
                        <Text style={styles.countBadgeText}>
                          {excelRows.length} DÒNG
                        </Text>
                      </View>
                    </View>

                    <TouchableOpacity onPress={handleAddRow} style={styles.addRowTopBtn}>
                      <Feather name="plus" size={13} color="#38bdf8" />
                      <Text style={styles.addRowTopBtnText}>+ Thêm dòng</Text>
                    </TouchableOpacity>
                  </View>

                  {/* Danh sách từng dòng dạng Card rộng rãi 100% màn hình */}
                  <View style={{ gap: 10 }}>
                    {excelRows.map((row, index) => {
                      const datesList = (row.dates && row.dates.length > 0)
                        ? row.dates
                        : parseDatesFromString(row.date);

                      return (
                        <View key={row.id} style={styles.excelCard}>
                          {/* Header của từng dòng: STT & Nút xóa dòng */}
                          <View style={styles.excelCardHeader}>
                            <View style={styles.excelCardSeqBadge}>
                              <Text style={styles.excelCardSeqLabel}>DÒNG #{row.seq || (index + 1)}</Text>
                            </View>

                            {excelRows.length > 1 && (
                              <TouchableOpacity
                                onPress={() => handleRemoveRow(row.id)}
                                style={styles.excelCardDeleteBtn}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                              >
                                <Feather name="trash-2" size={14} color="#f43f5e" />
                              </TouchableOpacity>
                            )}
                          </View>

                          {/* Khu vực Ngày hàng (Bấm mở Lịch, hỗ trợ nhiều ngày) */}
                          <View style={{ marginTop: 8 }}>
                            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                              <Text style={styles.excelFieldLabel}>NGÀY HÀNG (CHỌN ĐƯỢC NHIỀU NGÀY):</Text>
                              <TouchableOpacity
                                onPress={() => handleOpenCalendar(row)}
                                style={styles.openCalendarBtn}
                              >
                                <Feather name="calendar" size={12} color="#38bdf8" />
                                <Text style={styles.openCalendarBtnText}>Mở lịch</Text>
                              </TouchableOpacity>
                            </View>

                            <View style={styles.dateChipsWrap}>
                              {datesList.length === 0 ? (
                                <TouchableOpacity
                                  onPress={() => handleOpenCalendar(row)}
                                  style={styles.emptyDatePrompt}
                                >
                                  <Feather name="calendar" size={13} color="#64748b" />
                                  <Text style={styles.emptyDatePromptText}>Bấm để mở lịch chọn ngày...</Text>
                                </TouchableOpacity>
                              ) : (
                                datesList.map(d => (
                                  <View key={d} style={styles.dateTagChip}>
                                    <Feather name="calendar" size={11} color="#38bdf8" />
                                    <Text style={styles.dateTagChipText}>{d}</Text>
                                    <TouchableOpacity
                                      onPress={() => handleRemoveSingleDate(row.id, d)}
                                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                                      style={{ padding: 2 }}
                                    >
                                      <Feather name="x" size={12} color="#94a3b8" />
                                    </TouchableOpacity>
                                  </View>
                                ))
                              )}

                              {datesList.length > 0 && (
                                <TouchableOpacity
                                  onPress={() => handleOpenCalendar(row)}
                                  style={styles.addMoreDateBtn}
                                >
                                  <Feather name="plus" size={11} color="#38bdf8" />
                                  <Text style={styles.addMoreDateBtnText}>+ Thêm ngày</Text>
                                </TouchableOpacity>
                              )}
                            </View>
                          </View>

                          {/* Ô THÔNG TIN HÀNG HÓA & SỐ LƯỢNG - Rộng rãi toàn màn hình */}
                          <View style={{ marginTop: 8 }}>
                            <Text style={styles.excelFieldLabel}>THÔNG TIN HÀNG & SỐ LƯỢNG:</Text>
                            <TextInput
                              value={row.info}
                              onChangeText={(v) => handleUpdateRow(row.id, 'info', v)}
                              placeholder="VD: ria 6 thùng + đô c 2 thùng..."
                              placeholderTextColor="#64748b"
                              multiline
                              style={styles.excelCardInfoInput}
                            />
                          </View>

                          {/* Ô TAG PHÂN LOẠI & Gợi ý nhanh */}
                          <View style={{ marginTop: 8 }}>
                            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                              <Text style={styles.excelFieldLabel}>TAG PHÂN LOẠI:</Text>
                              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4 }}>
                                {['hàng mẫu', 'chờ dán tem', 'hàng trả', 'hàng xá'].map(tag => (
                                  <TouchableOpacity
                                    key={tag}
                                    onPress={() => {
                                      handleUpdateRow(row.id, 'tag', tag);
                                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                    }}
                                    style={[styles.miniTagChip, row.tag === tag && styles.miniTagChipActive]}
                                  >
                                    <Text style={[styles.miniTagChipText, row.tag === tag && styles.miniTagChipTextActive]}>
                                      +{tag}
                                    </Text>
                                  </TouchableOpacity>
                                ))}
                              </ScrollView>
                            </View>

                            <TextInput
                              value={row.tag}
                              onChangeText={(v) => handleUpdateRow(row.id, 'tag', v)}
                              placeholder="VD: hàng mẫu, chờ tem, hàng trả..."
                              placeholderTextColor="#64748b"
                              style={styles.excelCardTagInput}
                            />
                          </View>
                        </View>
                      );
                    })}
                  </View>

                  {/* Nút thêm dòng lớn bên dưới */}
                  <TouchableOpacity onPress={handleAddRow} style={styles.addExcelRowBtn}>
                    <Feather name="plus-circle" size={16} color="#38bdf8" />
                    <Text style={styles.addExcelRowBtnText}>+ Thêm dòng kê khai mới</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Ghi chú */}
              <View style={{ marginBottom: 14 }}>
                <Text style={styles.sectionLabel}>
                  GHI CHÚ CHUNG (TÙY CHỌN):
                </Text>
                <TextInput
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Nhập ghi chú ca, vị trí tập kết..."
                  placeholderTextColor="#64748b"
                  style={[styles.textInput, { fontSize: 13 }]}
                />
              </View>
            </ScrollView>

            {/* Footer Buttons */}
            <View style={styles.footerRow}>
              <TouchableOpacity
                onPress={onClose}
                disabled={submitting}
                style={styles.cancelBtn}
              >
                <Text style={styles.cancelBtnText}>ĐÓNG</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleSubmit}
                disabled={submitting || (inputMode === 'QUICK_SEQ' ? lotSeqs.length === 0 : excelRows.filter(r => r.info.trim() || r.seq.trim() || r.tag.trim()).length === 0)}
                style={[
                  styles.submitBtn,
                  (inputMode === 'QUICK_SEQ' ? lotSeqs.length === 0 : excelRows.filter(r => r.info.trim() || r.seq.trim() || r.tag.trim()).length === 0) && { backgroundColor: '#334155' },
                ]}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <>
                    <Feather name="send" size={16} color="#ffffff" />
                    <Text style={styles.submitBtnText}>
                      {inputMode === 'QUICK_SEQ'
                        ? `GỬI LÊN WEB (${lotSeqs.length} LOT)`
                        : `GỬI LÊN WEB (${excelRows.filter(r => r.info.trim() || r.seq.trim() || r.tag.trim()).length} DÒNG)`}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* Modal Lịch Chọn Nhiều Ngày */}
      <Modal
        visible={Boolean(calendarTargetRowId)}
        transparent
        animationType="fade"
        onRequestClose={() => setCalendarTargetRowId(null)}
      >
        <View style={styles.calendarModalOverlay}>
          <View style={styles.calendarModalCard}>
            {/* Header Lịch */}
            <View style={styles.calendarModalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                <View style={styles.calendarIconCircle}>
                  <Feather name="calendar" size={16} color="#38bdf8" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.calendarModalTitle}>CHỌN NGÀY HÀNG HÓA</Text>
                  <Text style={styles.calendarModalSubtitle}>Bấm để chọn / bỏ chọn nhiều ngày</Text>
                </View>
              </View>
              <TouchableOpacity
                onPress={() => setCalendarTargetRowId(null)}
                style={styles.closeBtn}
              >
                <Feather name="x" size={18} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            {/* Thanh hiển thị các ngày đã chọn */}
            <View style={styles.selectedDatesBar}>
              <Text style={styles.selectedDatesBarTitle}>
                ĐÃ CHỌN ({calendarSelectedDates.length} NGÀY):
              </Text>
              {calendarSelectedDates.length === 0 ? (
                <Text style={styles.noDateSelectedText}>Chưa có ngày nào (bấm chọn ngày bên dưới)</Text>
              ) : (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                  {calendarSelectedDates.map(d => (
                    <View key={d} style={styles.modalDateChip}>
                      <Text style={styles.modalDateChipText}>{d}</Text>
                      <TouchableOpacity
                        onPress={() => setCalendarSelectedDates(prev => prev.filter(x => x !== d))}
                        style={{ padding: 1 }}
                      >
                        <Feather name="x" size={11} color="#94a3b8" />
                      </TouchableOpacity>
                    </View>
                  ))}
                </ScrollView>
              )}
            </View>

            {/* Bộ chuyển tháng/năm */}
            <View style={styles.calendarNavRow}>
              <TouchableOpacity onPress={handlePrevMonth} style={styles.calendarNavBtn}>
                <Feather name="chevron-left" size={18} color="#38bdf8" />
              </TouchableOpacity>
              <Text style={styles.calendarMonthTitle}>
                Tháng {calendarMonth + 1} / {calendarYear}
              </Text>
              <TouchableOpacity onPress={handleNextMonth} style={styles.calendarNavBtn}>
                <Feather name="chevron-right" size={18} color="#38bdf8" />
              </TouchableOpacity>
            </View>

            {/* Header các thứ trong tuần */}
            <View style={styles.weekDaysRow}>
              {['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map((w, idx) => (
                <Text key={w} style={[styles.weekDayText, idx >= 5 && { color: '#f87171' }]}>
                  {w}
                </Text>
              ))}
            </View>

            {/* Lưới ngày 7 cột */}
            <View style={styles.calendarGrid}>
              {calendarDaysData.map((day, idx) => {
                if (day === null) {
                  return <View key={'empty_' + idx} style={styles.calendarDayCell} />;
                }
                const dStr = String(day).padStart(2, '0');
                const mStr = String(calendarMonth + 1).padStart(2, '0');
                const dateFormatted = `${dStr}/${mStr}/${calendarYear}`;
                const isSelected = calendarSelectedDates.includes(dateFormatted);

                const now = new Date();
                const isToday =
                  now.getFullYear() === calendarYear &&
                  now.getMonth() === calendarMonth &&
                  now.getDate() === day;

                return (
                  <TouchableOpacity
                    key={'day_' + day}
                    style={[
                      styles.calendarDayCell,
                      isSelected && styles.calendarDayCellSelected,
                      isToday && !isSelected && styles.calendarDayCellToday,
                    ]}
                    onPress={() => handleToggleDate(day)}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.calendarDayText,
                        isSelected && styles.calendarDayTextSelected,
                        isToday && !isSelected && styles.calendarDayTextToday,
                      ]}
                    >
                      {day}
                    </Text>
                    {isSelected && <View style={styles.selectedDot} />}
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Phím tắt chọn nhanh */}
            <View style={styles.quickDateActionsRow}>
              <TouchableOpacity
                style={styles.quickActionBtn}
                onPress={() => handleQuickAddDate('today')}
              >
                <Text style={styles.quickActionBtnText}>+ Hôm nay</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.quickActionBtn}
                onPress={() => handleQuickAddDate('yesterday')}
              >
                <Text style={styles.quickActionBtnText}>+ Hôm qua</Text>
              </TouchableOpacity>
              {calendarSelectedDates.length > 0 && (
                <TouchableOpacity
                  style={[styles.quickActionBtn, { backgroundColor: '#e11d4822', borderColor: '#f43f5e55' }]}
                  onPress={() => handleQuickAddDate('clear')}
                >
                  <Text style={[styles.quickActionBtnText, { color: '#f43f5e' }]}>Xóa hết</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Nút Hoàn tất */}
            <View style={styles.calendarModalFooter}>
              <TouchableOpacity
                onPress={() => setCalendarTargetRowId(null)}
                style={styles.cancelDateBtn}
              >
                <Text style={styles.cancelDateBtnText}>HỦY</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleConfirmCalendar}
                style={styles.confirmDateBtn}
              >
                <Feather name="check" size={15} color="#ffffff" />
                <Text style={styles.confirmDateBtnText}>
                  XÁC NHẬN ({calendarSelectedDates.length} NGÀY)
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  modalCard: {
    backgroundColor: '#111827',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#1e293b',
    maxHeight: '90%',
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#0b1324',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  headerIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: '#0284c7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.3,
  },
  headerSubtitle: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionLabel: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  toggleCustomText: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '700',
  },
  textInput: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#ffffff',
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#334155',
  },
  whFilterPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  whFilterPillActive: {
    backgroundColor: '#3b82f6',
    borderColor: '#60a5fa',
  },
  whFilterPillText: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '700',
  },
  whFilterPillTextActive: {
    color: '#ffffff',
    fontWeight: '900',
  },
  hallPill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  hallPillActive: {
    backgroundColor: '#0284c7',
    borderColor: '#38bdf8',
  },
  hallPillText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
  },
  hallPillTextActive: {
    color: '#ffffff',
    fontWeight: '900',
  },
  selectedHallBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#082f49',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#0284c7',
  },
  selectedHallBannerText: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '700',
    flex: 1,
  },
  addBtn: {
    backgroundColor: '#0284c7',
    paddingHorizontal: 16,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addBtnText: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 14,
  },
  tipText: {
    color: '#64748b',
    fontSize: 10,
    marginTop: 4,
  },
  countBadge: {
    backgroundColor: '#0284c7',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  countBadgeText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '900',
  },
  emptyBox: {
    padding: 24,
    backgroundColor: '#0b1324',
    borderRadius: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  chipsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    maxHeight: 180,
    padding: 4,
  },
  seqChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#38bdf8',
    gap: 6,
  },
  seqChipText: {
    color: '#38bdf8',
    fontSize: 13,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  footerRow: {
    padding: 14,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    flexDirection: 'row',
    gap: 10,
  },
  cancelBtn: {
    flex: 1,
    backgroundColor: '#1e293b',
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnText: {
    color: '#94a3b8',
    fontWeight: '800',
    fontSize: 13,
  },
  submitBtn: {
    flex: 2,
    backgroundColor: '#0284c7',
    paddingVertical: 14,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  submitBtnText: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 13,
  },
  // Mode Switch Tabs
  modeSwitchWrap: {
    flexDirection: 'row',
    backgroundColor: '#0b1324',
    padding: 3,
    borderRadius: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#1e293b',
    gap: 4,
  },
  modeTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: 11,
    gap: 6,
  },
  modeTabActive: {
    backgroundColor: '#0284c7',
  },
  modeTabText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
  },
  modeTabTextActive: {
    color: '#ffffff',
    fontWeight: '900',
  },
  // Excel Card Layout Styles (Tối ưu rộng rãi cho Mobile)
  addRowTopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0369a133',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 0.5,
    borderColor: '#38bdf8',
  },
  addRowTopBtnText: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '800',
  },
  excelCard: {
    backgroundColor: '#0c162d',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1e293b',
    padding: 10,
  },
  excelCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: '#1e293b',
  },
  excelCardSeqBadge: {
    backgroundColor: '#f59e0b1f',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: '#f59e0b66',
  },
  excelCardSeqLabel: {
    color: '#fbbf24',
    fontSize: 11,
    fontWeight: '900',
  },
  excelCardDateField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0f172a',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: '#334155',
  },
  excelCardDateInput: {
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: '700',
    padding: 0,
    minWidth: 70,
  },
  excelCardDeleteBtn: {
    padding: 5,
    borderRadius: 6,
    backgroundColor: '#e11d481a',
  },
  excelFieldLabel: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  excelCardInfoInput: {
    backgroundColor: '#162238',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
    borderWidth: 1,
    borderColor: '#0284c755',
    minHeight: 44,
  },
  excelCardTagInput: {
    backgroundColor: '#0f172a',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '600',
    borderWidth: 0.5,
    borderColor: '#334155',
  },
  miniTagChip: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 7,
    paddingVertical: 2.5,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: '#475569',
  },
  miniTagChipActive: {
    backgroundColor: '#0284c7',
    borderColor: '#38bdf8',
  },
  miniTagChipText: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '700',
  },
  miniTagChipTextActive: {
    color: '#ffffff',
  },
  addExcelRowBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#082f49',
    borderWidth: 1,
    borderColor: '#0284c7',
    borderStyle: 'dashed',
    borderRadius: 12,
    paddingVertical: 10,
    marginTop: 4,
  },
  addExcelRowBtnText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '800',
  },
  // Nút mở lịch & chip ngày trên Card
  openCalendarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0284c722',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: '#38bdf8',
  },
  openCalendarBtnText: {
    color: '#38bdf8',
    fontSize: 10,
    fontWeight: '800',
  },
  dateChipsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0a101f',
    borderRadius: 8,
    padding: 6,
    borderWidth: 0.5,
    borderColor: '#1e293b',
    minHeight: 38,
  },
  dateTagChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0369a133',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: '#38bdf8',
  },
  dateTagChipText: {
    color: '#e0f2fe',
    fontSize: 11,
    fontWeight: '800',
  },
  emptyDatePrompt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
  emptyDatePromptText: {
    color: '#64748b',
    fontSize: 11,
    fontStyle: 'italic',
  },
  addMoreDateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#1e293b',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: '#475569',
  },
  addMoreDateBtnText: {
    color: '#38bdf8',
    fontSize: 10,
    fontWeight: '700',
  },
  // Styles Modal Lịch Chọn Nhiều Ngày
  calendarModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  calendarModalCard: {
    backgroundColor: '#0f172a',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#334155',
    width: '100%',
    maxWidth: 360,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 20,
  },
  calendarModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  calendarIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: '#0284c722',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 0.5,
    borderColor: '#0284c755',
  },
  calendarModalTitle: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '900',
  },
  calendarModalSubtitle: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '600',
  },
  selectedDatesBar: {
    marginTop: 8,
    marginBottom: 8,
    backgroundColor: '#0a0f1d',
    borderRadius: 8,
    padding: 8,
    borderWidth: 0.5,
    borderColor: '#1e293b',
  },
  selectedDatesBarTitle: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '800',
    marginBottom: 4,
  },
  noDateSelectedText: {
    color: '#64748b',
    fontSize: 11,
    fontStyle: 'italic',
  },
  modalDateChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0284c7',
    paddingHorizontal: 7,
    paddingVertical: 2.5,
    borderRadius: 6,
  },
  modalDateChipText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '800',
  },
  calendarNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: 6,
    paddingHorizontal: 4,
  },
  calendarNavBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#1e293b',
  },
  calendarMonthTitle: {
    color: '#e2e8f0',
    fontSize: 14,
    fontWeight: '800',
  },
  weekDaysRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    paddingBottom: 6,
    marginBottom: 4,
  },
  weekDayText: {
    flex: 1,
    textAlign: 'center',
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '800',
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  calendarDayCell: {
    width: `${100 / 7}%`,
    height: 38,
    justifyContent: 'center',
    alignItems: 'center',
    marginVertical: 1,
    borderRadius: 8,
    position: 'relative',
  },
  calendarDayCellSelected: {
    backgroundColor: '#0284c7',
    shadowColor: '#38bdf8',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 3,
  },
  calendarDayCellToday: {
    borderWidth: 1,
    borderColor: '#38bdf8',
  },
  calendarDayText: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '600',
  },
  calendarDayTextSelected: {
    color: '#ffffff',
    fontWeight: '900',
  },
  calendarDayTextToday: {
    color: '#38bdf8',
    fontWeight: '800',
  },
  selectedDot: {
    position: 'absolute',
    bottom: 3,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#ffffff',
  },
  quickDateActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  quickActionBtn: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: '#334155',
  },
  quickActionBtnText: {
    color: '#38bdf8',
    fontSize: 10,
    fontWeight: '700',
  },
  calendarModalFooter: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  cancelDateBtn: {
    flex: 1,
    backgroundColor: '#1e293b',
    paddingVertical: 9,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelDateBtnText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '800',
  },
  confirmDateBtn: {
    flex: 2,
    flexDirection: 'row',
    gap: 6,
    backgroundColor: '#0284c7',
    paddingVertical: 9,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmDateBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '900',
  },
});

