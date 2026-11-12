import React, { useState, useMemo } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface CalendarPickerModalProps {
  visible: boolean;
  onClose: () => void;
  selectedDates: string[];
  onConfirm: (dates: string[]) => void;
  availableDateKeys?: string[]; // các ngày đã có công việc ghi nhận
  title?: string;
  isMultiSelect?: boolean;
}

export const CalendarPickerModal: React.FC<CalendarPickerModalProps> = ({
  visible,
  onClose,
  selectedDates,
  onConfirm,
  availableDateKeys = [],
  title = 'Chọn ngày xem báo cáo',
  isMultiSelect = true,
}) => {
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // Năm & tháng đang duyệt
  const [currentYear, setCurrentYear] = useState<number>(today.getFullYear());
  const [currentMonth, setCurrentMonth] = useState<number>(today.getMonth() + 1); // 1-12

  // Danh sách các ngày đang tạm chọn trong Modal
  const [tempSelected, setTempSelected] = useState<string[]>([]);

  // Khi modal mở, đồng bộ tempSelected với selectedDates và chuyển view tháng tới ngày đầu tiên được chọn
  React.useEffect(() => {
    if (visible) {
      setTempSelected([...selectedDates]);
      if (selectedDates.length > 0) {
        const first = selectedDates[0];
        const parts = first.split('-');
        if (parts.length === 3) {
          setCurrentYear(Number(parts[0]));
          setCurrentMonth(Number(parts[1]));
        }
      }
    }
  }, [visible, selectedDates]);

  // Tiến / lùi tháng
  const handlePrevMonth = () => {
    if (currentMonth === 1) {
      setCurrentMonth(12);
      setCurrentYear(prev => prev - 1);
    } else {
      setCurrentMonth(prev => prev - 1);
    }
  };

  const handleNextMonth = () => {
    if (currentMonth === 12) {
      setCurrentMonth(1);
      setCurrentYear(prev => prev + 1);
    } else {
      setCurrentMonth(prev => prev + 1);
    }
  };

  const handleJumpToday = () => {
    setCurrentYear(today.getFullYear());
    setCurrentMonth(today.getMonth() + 1);
    if (!tempSelected.includes(todayKey)) {
      if (isMultiSelect) {
        setTempSelected(prev => [...prev, todayKey]);
      } else {
        setTempSelected([todayKey]);
      }
    }
  };

  // Tính ma trận các ngày trong tháng hiện tại
  const calendarDays = useMemo(() => {
    const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
    // Thứ trong tuần của ngày 1 (0: CN, 1: T2, ..., 6: T7)
    const firstDayIndex = new Date(currentYear, currentMonth - 1, 1).getDay();
    // Đổi sang chuẩn T2 = 0, ..., CN = 6
    const startOffset = (firstDayIndex + 6) % 7;

    const days: Array<{
      dateKey: string;
      dayNum: number;
      isCurrentMonth: boolean;
      hasData: boolean;
      isToday: boolean;
    } | null> = [];

    // Ô trống đầu tháng
    for (let i = 0; i < startOffset; i++) {
      days.push(null);
    }

    // Các ngày trong tháng
    for (let d = 1; d <= daysInMonth; d++) {
      const dateKey = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      days.push({
        dateKey,
        dayNum: d,
        isCurrentMonth: true,
        hasData: availableDateKeys.includes(dateKey),
        isToday: dateKey === todayKey,
      });
    }

    return days;
  }, [currentYear, currentMonth, availableDateKeys, todayKey]);

  const toggleDate = (dateKey: string) => {
    if (isMultiSelect) {
      setTempSelected(prev => {
        if (prev.includes(dateKey)) {
          return prev.filter(d => d !== dateKey);
        } else {
          return [...prev, dateKey];
        }
      });
    } else {
      setTempSelected([dateKey]);
    }
  };

  const handleApply = () => {
    onConfirm(tempSelected);
    onClose();
  };

  const dayHeaders = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.container}>
          {/* Header Modal */}
          <View style={styles.header}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={styles.headerIcon}>
                <Ionicons name="calendar" size={18} color="#818cf8" />
              </View>
              <View>
                <Text style={styles.headerTitle}>{title}</Text>
                <Text style={styles.headerSub}>
                  {isMultiSelect
                    ? `Đang chọn: ${tempSelected.length} ngày`
                    : 'Chạm vào ngày để chọn'}
                </Text>
              </View>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close" size={20} color="#94a3b8" />
            </TouchableOpacity>
          </View>

          {/* Điều hướng Tháng / Năm */}
          <View style={styles.monthNavigator}>
            <TouchableOpacity onPress={handlePrevMonth} style={styles.navBtn} activeOpacity={0.7}>
              <Ionicons name="chevron-back" size={18} color="#cbd5e1" />
            </TouchableOpacity>

            <View style={styles.monthDisplay}>
              <Text style={styles.monthText}>
                Tháng {String(currentMonth).padStart(2, '0')} / {currentYear}
              </Text>
            </View>

            <TouchableOpacity onPress={handleNextMonth} style={styles.navBtn} activeOpacity={0.7}>
              <Ionicons name="chevron-forward" size={18} color="#cbd5e1" />
            </TouchableOpacity>
          </View>

          {/* Hàng thứ trong tuần */}
          <View style={styles.weekHeaderRow}>
            {dayHeaders.map((dh, idx) => (
              <View key={dh} style={styles.weekHeaderCell}>
                <Text style={[styles.weekHeaderText, idx >= 5 && styles.weekendText]}>
                  {dh}
                </Text>
              </View>
            ))}
          </View>

          {/* Lưới các ngày */}
          <View style={styles.daysGrid}>
            {calendarDays.map((item, idx) => {
              if (!item) {
                return <View key={`empty-${idx}`} style={styles.dayCell} />;
              }

              const isSelected = tempSelected.includes(item.dateKey);

              return (
                <TouchableOpacity
                  key={item.dateKey}
                  onPress={() => toggleDate(item.dateKey)}
                  style={[
                    styles.dayCell,
                    isSelected && styles.dayCellSelected,
                    item.isToday && !isSelected && styles.dayCellToday,
                  ]}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.dayNumText,
                      isSelected && styles.dayNumTextSelected,
                      item.isToday && !isSelected && styles.dayNumTextToday,
                    ]}
                  >
                    {item.dayNum}
                  </Text>

                  {/* Chấm đánh dấu nếu ngày có dữ liệu ca phát sinh */}
                  {item.hasData && (
                    <View
                      style={[
                        styles.dataDot,
                        isSelected && { backgroundColor: '#fff' },
                      ]}
                    />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Chú thích nhỏ */}
          <View style={styles.legendRow}>
            <View style={styles.legendItem}>
              <View style={[styles.dataDot, { position: 'relative', bottom: 0 }]} />
              <Text style={styles.legendText}>Có dữ liệu</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={styles.legendTodayBox} />
              <Text style={styles.legendText}>Hôm nay</Text>
            </View>
            <TouchableOpacity onPress={handleJumpToday} style={styles.todayBtn} activeOpacity={0.7}>
              <Text style={styles.todayBtnText}>Về hôm nay</Text>
            </TouchableOpacity>
          </View>

          {/* Footer nút hành động */}
          <View style={styles.footer}>
            <TouchableOpacity
              onPress={() => setTempSelected([])}
              style={styles.clearBtn}
              activeOpacity={0.7}
            >
              <Text style={styles.clearBtnText}>Xóa chọn</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={handleApply}
              style={styles.applyBtn}
              activeOpacity={0.8}
            >
              <Ionicons name="checkmark-done" size={16} color="#fff" />
              <Text style={styles.applyBtnText}>
                {isMultiSelect
                  ? `Áp dụng (${tempSelected.length} ngày)`
                  : 'Xác nhận'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  container: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#0f172a',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#334155',
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  headerIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#f8fafc',
  },
  headerSub: {
    fontSize: 11,
    color: '#818cf8',
    fontWeight: '600',
    marginTop: 2,
  },
  closeBtn: {
    padding: 6,
  },
  monthNavigator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: 12,
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 4,
  },
  navBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0f172a',
  },
  monthDisplay: {
    alignItems: 'center',
  },
  monthText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#f8fafc',
  },
  weekHeaderRow: {
    flexDirection: 'row',
    marginBottom: 6,
  },
  weekHeaderCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 4,
  },
  weekHeaderText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
  },
  weekendText: {
    color: '#f43f5e',
  },
  daysGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dayCell: {
    width: `${100 / 7}%`,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    borderRadius: 10,
    marginVertical: 2,
  },
  dayCellSelected: {
    backgroundColor: '#6366f1',
    borderRadius: 10,
  },
  dayCellToday: {
    borderWidth: 1.5,
    borderColor: '#38bdf8',
  },
  dayNumText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#cbd5e1',
  },
  dayNumTextSelected: {
    color: '#ffffff',
    fontWeight: '800',
  },
  dayNumTextToday: {
    color: '#38bdf8',
    fontWeight: '800',
  },
  dataDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#34d399',
    position: 'absolute',
    bottom: 5,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    marginTop: 8,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendTodayBox: {
    width: 10,
    height: 10,
    borderRadius: 3,
    borderWidth: 1.5,
    borderColor: '#38bdf8',
  },
  legendText: {
    fontSize: 10,
    color: '#94a3b8',
    fontWeight: '600',
  },
  todayBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#1e293b',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  todayBtnText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#38bdf8',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  clearBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#94a3b8',
  },
  applyBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#6366f1',
  },
  applyBtnText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#ffffff',
  },
});

