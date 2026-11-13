import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  ProposalActionType,
  ProposalItem,
  ProposalSubItem,
} from '../../services/warehouseAdjustmentService';

interface WarehouseAdjustmentDraftModalProps {
  visible: boolean;
  onClose: () => void;
  position: any | null; // PositionItem
  initialItem?: ProposalItem | null;
  onSaveDraftItem: (item: ProposalItem) => void;
}

const QUICK_NOTES = [
  'Cont 25 Dice',
  'Xuất Durivy Đen',
  'Xuất xoài VP',
  'Khay 400g',
  'Bốc dở ca 1',
  'Bốc dở ca 2',
  'Lẻ thùng',
  'Hàng mẫu',
  'Trừ vị trí',
];

/**
 * Hàm trích xuất danh sách các dòng sản phẩm con trong pallet
 */
export function extractSubItemsFromPosition(pos: any): ProposalSubItem[] {
  if (!pos || !pos.lot_id) return [];

  // 1. Nếu có mảng items chi tiết từ lot_items
  if (Array.isArray(pos.items) && pos.items.length > 0) {
    const valid = pos.items.filter((it: any) => it && (it.product_name || '').trim());
    if (valid.length > 0) {
      return valid.map((it: any) => ({
        product_id: it.product_id || null,
        product_name: (it.product_name || '').trim(),
        sku: it.sku || pos.sku || null,
        current_quantity: it.quantity != null ? Number(it.quantity) : 0,
        new_quantity: it.quantity != null ? Number(it.quantity) : 0,
        unit: it.unit || pos.unit || 'Thùng',
      }));
    }
  }

  // 2. Nếu tên có dấu phẩy (ghép nhiều sản phẩm)
  const rawNames = (pos.product_name || '').split(',').map((s: string) => s.trim()).filter(Boolean);
  const rawSkus = (pos.sku || '').split(',').map((s: string) => s.trim()).filter(Boolean);
  if (rawNames.length > 1) {
    const totalQty = pos.quantity ? Number(pos.quantity) : 0;
    const eachQty = Number((totalQty / rawNames.length).toFixed(2));
    return rawNames.map((name: string, i: number) => ({
      product_id: null,
      product_name: name,
      sku: rawSkus[i] || pos.sku || null,
      current_quantity: eachQty,
      new_quantity: eachQty,
      unit: pos.unit || 'Thùng',
    }));
  }

  // 3. Nếu là sản phẩm đơn
  if (pos.product_name) {
    return [
      {
        product_id: null,
        product_name: pos.product_name,
        sku: pos.sku || null,
        current_quantity: pos.quantity != null ? Number(pos.quantity) : 0,
        new_quantity: pos.quantity != null ? Number(pos.quantity) : 0,
        unit: pos.unit || 'Thùng',
      },
    ];
  }

  return [];
}

export default function WarehouseAdjustmentDraftModal({
  visible,
  onClose,
  position,
  initialItem,
  onSaveDraftItem,
}: WarehouseAdjustmentDraftModalProps) {
  // LƯU Ý: Tất cả các hook PHẢI được gọi ở đầu component, TUYỆT ĐỐI không return trước hooks
  const isCurrentlyOccupied = Boolean(position?.lot_id);
  const currentQty = position?.quantity ?? 0;
  const currentUnit = position?.unit || 'Thùng';

  const [actionType, setActionType] = useState<ProposalActionType>('CLEAR');
  const [newQtyStr, setNewQtyStr] = useState<string>('0');
  const [targetPosCode, setTargetPosCode] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [subItems, setSubItems] = useState<ProposalSubItem[]>([]);

  // Khởi tạo state khi mở modal hoặc thay đổi position / initialItem
  useEffect(() => {
    if (!visible || !position) return;

    if (initialItem) {
      setActionType(initialItem.action_type);
      setNewQtyStr(
        initialItem.new_quantity != null ? String(initialItem.new_quantity) : String(currentQty)
      );
      setTargetPosCode(initialItem.target_position_code || '');
      setNote(initialItem.note || '');

      if (initialItem.sub_items && initialItem.sub_items.length > 0) {
        setSubItems(initialItem.sub_items);
      } else {
        const extracted = extractSubItemsFromPosition(position);
        setSubItems(extracted);
      }
    } else {
      const defaultAction = isCurrentlyOccupied ? 'CLEAR' : 'SET_QTY';
      setActionType(defaultAction);
      setNewQtyStr(String(currentQty));
      setTargetPosCode('');
      setNote('');

      const extracted = extractSubItemsFromPosition(position);
      setSubItems(extracted);
    }
  }, [visible, position, initialItem, isCurrentlyOccupied, currentQty]);

  const hasMultipleProducts = subItems.length > 1;

  const handleSelectAction = useCallback((type: ProposalActionType) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setActionType(type);

    if (type === 'CLEAR') {
      // Đặt tất cả các sub_items về 0
      setSubItems(prev => prev.map(s => ({ ...s, new_quantity: 0 })));
      setNewQtyStr('0');
    }
  }, []);

  // Tăng giảm số lượng nhanh cho pallet đơn sản phẩm
  const handleQuickAddQty = useCallback((delta: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const curr = parseFloat(newQtyStr) || 0;
    const next = Math.max(0, curr + delta);
    setNewQtyStr(String(next));

    // Cập nhật dòng sub_item đơn nếu có
    setSubItems(prev => {
      if (prev.length === 1) {
        return [{ ...prev[0], new_quantity: next }];
      }
      return prev;
    });
  }, [newQtyStr]);

  // Cập nhật số lượng của 1 dòng sản phẩm con trong pallet hỗn hợp
  const handleUpdateSubItemQty = useCallback((index: number, newQty: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const validQty = Math.max(0, newQty);
    setSubItems(prev => {
      const next = [...prev];
      next[index] = { ...next[index], new_quantity: validQty };
      // Tự động tính tổng
      const total = next.reduce((sum, item) => sum + (item.new_quantity || 0), 0);
      setNewQtyStr(String(total));
      return next;
    });
  }, []);

  // Thay đổi số lượng của 1 dòng qua text input
  const handleSubItemTextChange = useCallback((index: number, text: string) => {
    const parsed = parseFloat(text);
    const validQty = isNaN(parsed) ? 0 : Math.max(0, parsed);
    setSubItems(prev => {
      const next = [...prev];
      next[index] = { ...next[index], new_quantity: validQty };
      const total = next.reduce((sum, item) => sum + (item.new_quantity || 0), 0);
      setNewQtyStr(String(total));
      return next;
    });
  }, []);

  const handleSave = () => {
    if (!position) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    let parsedNewQty: number | null = null;
    let finalSubItems: ProposalSubItem[] | undefined = undefined;

    if (actionType === 'SET_QTY') {
      if (hasMultipleProducts) {
        parsedNewQty = subItems.reduce((sum, item) => sum + (item.new_quantity || 0), 0);
        finalSubItems = subItems;
      } else {
        parsedNewQty = parseFloat(newQtyStr) || 0;
        finalSubItems = subItems.map(s => ({ ...s, new_quantity: parsedNewQty || 0 }));
      }
    } else if (actionType === 'CLEAR') {
      parsedNewQty = 0;
      finalSubItems = subItems.map(s => ({ ...s, new_quantity: 0 }));
    }

    const item: ProposalItem = {
      id: initialItem?.id || `${position.id}-${Date.now()}`,
      position_id: position.id,
      position_code: position.code,
      warehouse_name: position.warehouse_name,
      action_type: actionType,
      lot_id: position.lot_id || null,
      lot_code: position.lot_code || null,
      product_name: position.product_name || null,
      sku: position.sku || null,
      current_quantity: position.quantity ?? null,
      unit: position.unit || 'Thùng',
      sub_items: finalSubItems,
      new_quantity: parsedNewQty,
      target_position_code: actionType === 'MOVE' ? targetPosCode.trim().toUpperCase() : null,
      note: note.trim() || null,
      updated_at: new Date().toISOString(),
    };

    onSaveDraftItem(item);
    onClose();
  };

  if (!visible || !position) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.overlay}
      >
        <View style={styles.sheetContainer}>
          {/* Header */}
          <View style={styles.header}>
            <View>
              <Text style={styles.headerSub}>GHI NHÁP ĐIỀU CHỈNH</Text>
              <Text style={styles.headerTitle}>VỊ TRÍ: {position.code}</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close" size={24} color="#94a3b8" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.scrollBody} keyboardShouldPersistTaps="handled">
            {/* Thẻ hiển thị trạng thái hiện tại của vị trí */}
            <View style={styles.currentCard}>
              <View style={styles.currentCardHeader}>
                <Ionicons
                  name={isCurrentlyOccupied ? 'cube' : 'cube-outline'}
                  size={18}
                  color={isCurrentlyOccupied ? '#fbbf24' : '#34d399'}
                />
                <Text style={styles.currentCardTitle}>
                  {isCurrentlyOccupied
                    ? hasMultipleProducts
                      ? `HIỆN CÓ HÀNG (PALLET HỖN HỢP: ${subItems.length} SẢN PHẨM)`
                      : 'HIỆN CÓ HÀNG'
                    : 'Ô HIỆN ĐANG TRỐNG'}
                </Text>
                {position.stt && (
                  <View style={styles.sttBadge}>
                    <Text style={styles.sttBadgeText}>STT: {position.stt}</Text>
                  </View>
                )}
              </View>

              {isCurrentlyOccupied ? (
                <View style={{ marginTop: 6 }}>
                  {/* Nếu là pallet hỗn hợp nhiều sản phẩm: hiển thị bóc tách từng dòng */}
                  {hasMultipleProducts ? (
                    <View style={styles.subItemsListContainer}>
                      {subItems.map((sub, sIdx) => (
                        <View key={sIdx} style={styles.subItemInfoRow}>
                          <View style={styles.subItemBadge}>
                            <Text style={styles.subItemBadgeText}>SP {sIdx + 1}</Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.subItemName} numberOfLines={1}>
                              {sub.product_name}
                            </Text>
                            {sub.sku && (
                              <Text style={styles.subItemSku}>SKU: {sub.sku}</Text>
                            )}
                          </View>
                          <Text style={styles.subItemQty}>
                            {sub.current_quantity} {sub.unit || currentUnit}
                          </Text>
                        </View>
                      ))}
                    </View>
                  ) : (
                    <Text style={styles.productName} numberOfLines={2}>
                      {position.product_name || 'Hàng đông lạnh'}
                    </Text>
                  )}

                  <View style={styles.metaRow}>
                    {position.lot_code && (
                      <Text style={styles.lotCode}>Lot: {position.lot_code}</Text>
                    )}
                    <Text style={styles.currentQtyText}>
                      Tổng số lượng: <Text style={{ color: '#38bdf8', fontWeight: '800' }}>{currentQty} {currentUnit}</Text>
                    </Text>
                  </View>
                </View>
              ) : (
                <Text style={styles.emptyNote}>Vị trí đang trống, có thể gán hàng hoặc chuyển hàng vào ô này.</Text>
              )}
            </View>

            {/* Chọn Thao Tác Điều Chỉnh */}
            <Text style={styles.sectionLabel}>CHỌN THAO TÁC ĐIỀU CHỈNH:</Text>
            <View style={styles.actionGrid}>
              <TouchableOpacity
                onPress={() => handleSelectAction('CLEAR')}
                style={[
                  styles.actionBtn,
                  actionType === 'CLEAR' && styles.actionBtnActiveClear,
                ]}
              >
                <Ionicons
                  name="trash-outline"
                  size={22}
                  color={actionType === 'CLEAR' ? '#f43f5e' : '#94a3b8'}
                />
                <Text
                  style={[
                    styles.actionBtnText,
                    actionType === 'CLEAR' && { color: '#f43f5e', fontWeight: '800' },
                  ]}
                >
                  Xuất rỗng ô
                </Text>
                <Text style={styles.actionBtnSub}>Trừ vị trí (X)</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => handleSelectAction('SET_QTY')}
                style={[
                  styles.actionBtn,
                  actionType === 'SET_QTY' && styles.actionBtnActiveQty,
                ]}
              >
                <Ionicons
                  name="calculator-outline"
                  size={22}
                  color={actionType === 'SET_QTY' ? '#fbbf24' : '#94a3b8'}
                />
                <Text
                  style={[
                    styles.actionBtnText,
                    actionType === 'SET_QTY' && { color: '#fbbf24', fontWeight: '800' },
                  ]}
                >
                  Sửa số lượng
                </Text>
                <Text style={styles.actionBtnSub}>
                  {hasMultipleProducts ? 'Từng dòng SP' : 'Lẻ thùng (25t...)'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => handleSelectAction('MOVE')}
                style={[
                  styles.actionBtn,
                  actionType === 'MOVE' && styles.actionBtnActiveMove,
                ]}
              >
                <Ionicons
                  name="swap-horizontal"
                  size={22}
                  color={actionType === 'MOVE' ? '#38bdf8' : '#94a3b8'}
                />
                <Text
                  style={[
                    styles.actionBtnText,
                    actionType === 'MOVE' && { color: '#38bdf8', fontWeight: '800' },
                  ]}
                >
                  Chuyển ô
                </Text>
                <Text style={styles.actionBtnSub}>Sang vị trí mới</Text>
              </TouchableOpacity>
            </View>

            {/* Chi Tiết Nhập Liệu Tùy Thao Tác */}
            {actionType === 'SET_QTY' && (
              <View style={styles.subCard}>
                {hasMultipleProducts ? (
                  /* ── GIAO DIỆN CHỈNH SỬA TỪNG DÒNG SẢN PHẨM CON ── */
                  <View>
                    <View style={styles.subItemsEditHeader}>
                      <Text style={styles.subCardLabel}>
                        ĐIỀU CHỈNH SỐ LƯỢNG TỪNG DÒNG ({subItems.length} SẢN PHẨM):
                      </Text>
                    </View>

                    {subItems.map((sub, sIdx) => (
                      <View key={sIdx} style={styles.subItemEditRow}>
                        <View style={{ flex: 1, paddingRight: 8 }}>
                          <Text style={styles.subItemEditTitle} numberOfLines={2}>
                            {sub.product_name}
                          </Text>
                          <Text style={styles.subItemEditMeta}>
                            Hiện có: <Text style={{ color: '#38bdf8', fontWeight: '700' }}>{sub.current_quantity}</Text> {sub.unit}
                          </Text>
                        </View>

                        {/* Cụm chỉnh số lượng cho dòng con */}
                        <View style={styles.stepperContainer}>
                          <TouchableOpacity
                            onPress={() => handleUpdateSubItemQty(sIdx, (sub.new_quantity || 0) - 1)}
                            style={styles.stepperBtn}
                          >
                            <Ionicons name="remove" size={16} color="#cbd5e1" />
                          </TouchableOpacity>

                          <TextInput
                            style={styles.stepperInput}
                            value={String(sub.new_quantity != null ? sub.new_quantity : '')}
                            onChangeText={(txt) => handleSubItemTextChange(sIdx, txt)}
                            keyboardType="numeric"
                            placeholder="0"
                            placeholderTextColor="#64748b"
                            selectTextOnFocus
                          />

                          <TouchableOpacity
                            onPress={() => handleUpdateSubItemQty(sIdx, (sub.new_quantity || 0) + 1)}
                            style={styles.stepperBtn}
                          >
                            <Ionicons name="add" size={16} color="#cbd5e1" />
                          </TouchableOpacity>
                        </View>

                        {/* Nút Hết (0) nhanh */}
                        <TouchableOpacity
                          onPress={() => handleUpdateSubItemQty(sIdx, 0)}
                          style={[
                            styles.quickZeroBtn,
                            sub.new_quantity === 0 && styles.quickZeroBtnActive,
                          ]}
                        >
                          <Text
                            style={[
                              styles.quickZeroBtnText,
                              sub.new_quantity === 0 && { color: '#f43f5e', fontWeight: '800' },
                            ]}
                          >
                            =0
                          </Text>
                        </TouchableOpacity>
                      </View>
                    ))}

                    {/* Dòng tổng kết tự động tính toán */}
                    <View style={styles.totalCalcBar}>
                      <Text style={styles.totalCalcLabel}>TỔNG SỐ LƯỢNG MỚI:</Text>
                      <Text style={styles.totalCalcValue}>
                        {newQtyStr} {currentUnit}
                      </Text>
                    </View>
                  </View>
                ) : (
                  /* ── GIAO DIỆN CHỈNH SỐ LƯỢNG PALLET ĐƠN ── */
                  <View>
                    <Text style={styles.subCardLabel}>
                      SỐ LƯỢNG THỰC TẾ CÒN LẠI ({currentUnit.toUpperCase()}):
                    </Text>
                    <View style={styles.qtyInputRow}>
                      <TextInput
                        style={styles.qtyInput}
                        value={newQtyStr}
                        onChangeText={(txt) => {
                          setNewQtyStr(txt);
                          const parsed = parseFloat(txt) || 0;
                          setSubItems(prev => {
                            if (prev.length === 1) {
                              return [{ ...prev[0], new_quantity: parsed }];
                            }
                            return prev;
                          });
                        }}
                        keyboardType="numeric"
                        placeholder="0"
                        placeholderTextColor="#64748b"
                        selectTextOnFocus
                      />
                      <Text style={styles.unitSuffix}>{currentUnit}</Text>
                    </View>

                    {/* Quick Add Buttons */}
                    <View style={styles.quickAddRow}>
                      {[-10, -5, -1, 1, 5, 10, 20].map((val) => (
                        <TouchableOpacity
                          key={val}
                          onPress={() => handleQuickAddQty(val)}
                          style={styles.quickAddBtn}
                        >
                          <Text style={styles.quickAddBtnText}>
                            {val > 0 ? `+${val}` : `${val}`}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                )}
              </View>
            )}

            {actionType === 'MOVE' && (
              <View style={styles.subCard}>
                <Text style={styles.subCardLabel}>VỊ TRÍ ĐÍCH CHUYỂN ĐẾN (MÃ Ô):</Text>
                <TextInput
                  style={styles.targetPosInput}
                  value={targetPosCode}
                  onChangeText={setTargetPosCode}
                  placeholder="Ví dụ: K3D6O3B1 hoặc K1D2A08T2"
                  placeholderTextColor="#64748b"
                  autoCapitalize="characters"
                />
              </View>
            )}

            {actionType === 'CLEAR' && (
              <View
                style={[
                  styles.subCard,
                  { borderColor: '#f43f5e44', backgroundColor: '#88133722' },
                ]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Ionicons name="information-circle" size={18} color="#f43f5e" />
                  <Text style={{ color: '#fda4af', fontSize: 12, fontWeight: '700', flex: 1 }}>
                    {hasMultipleProducts
                      ? `Xác nhận bốc xuất sạch cả ${subItems.length} sản phẩm (ô trở thành rỗng).`
                      : 'Xác nhận ô này đã bốc xuất sạch hàng (trở thành ô trống).'}
                  </Text>
                </View>
              </View>
            )}

            {/* Ghi chú thực tế */}
            <Text style={styles.sectionLabel}>GHI CHÚ THỰC TẾ (NỘI DUNG NHẮN ZALO / GIẤY):</Text>
            <TextInput
              style={styles.noteInput}
              value={note}
              onChangeText={setNote}
              placeholder="Ví dụ: Cont 25 Dice, Xuất Durivy, Bốc dở ca 1..."
              placeholderTextColor="#64748b"
            />

            <View style={styles.chipsRow}>
              {QUICK_NOTES.map((chip) => (
                <TouchableOpacity
                  key={chip}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setNote((prev) => (prev ? `${prev}, ${chip}` : chip));
                  }}
                  style={styles.chip}
                >
                  <Text style={styles.chipText}>+ {chip}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>

          {/* Footer */}
          <View style={styles.footer}>
            <TouchableOpacity onPress={onClose} style={styles.cancelBtn}>
              <Text style={styles.cancelBtnText}>Hủy</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={handleSave} style={styles.saveBtn}>
              <Ionicons name="checkmark-circle" size={20} color="#fff" />
              <Text style={styles.saveBtnText}>LƯU VÀO PHIẾU NHÁP</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: '#0f172a',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: '#334155',
    maxHeight: '90%',
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderColor: '#1e293b',
  },
  headerSub: {
    color: '#f59e0b',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  headerTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  closeBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#1e293b',
  },
  scrollBody: {
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  currentCard: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 16,
  },
  currentCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  currentCardTitle: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
    flex: 1,
  },
  sttBadge: {
    backgroundColor: '#3b82f622',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#3b82f644',
  },
  sttBadgeText: {
    color: '#60a5fa',
    fontSize: 11,
    fontWeight: '800',
  },
  productName: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
  },
  subItemsListContainer: {
    gap: 6,
    marginTop: 4,
    marginBottom: 4,
  },
  subItemInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
    gap: 8,
  },
  subItemBadge: {
    backgroundColor: '#f59e0b22',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  subItemBadgeText: {
    color: '#fbbf24',
    fontSize: 10,
    fontWeight: '800',
  },
  subItemName: {
    color: '#f1f5f9',
    fontSize: 12,
    fontWeight: '700',
  },
  subItemSku: {
    color: '#64748b',
    fontSize: 10,
  },
  subItemQty: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '800',
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderColor: '#33415566',
  },
  lotCode: {
    color: '#94a3b8',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  currentQtyText: {
    color: '#94a3b8',
    fontSize: 12,
  },
  emptyNote: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 4,
    fontStyle: 'italic',
  },
  sectionLabel: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  actionGrid: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  actionBtn: {
    flex: 1,
    backgroundColor: '#1e293b',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#334155',
  },
  actionBtnActiveClear: {
    borderColor: '#f43f5e',
    backgroundColor: '#88133722',
  },
  actionBtnActiveQty: {
    borderColor: '#fbbf24',
    backgroundColor: '#78350f22',
  },
  actionBtnActiveMove: {
    borderColor: '#38bdf8',
    backgroundColor: '#0369a122',
  },
  actionBtnText: {
    color: '#94a3b8',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 4,
  },
  actionBtnSub: {
    color: '#64748b',
    fontSize: 10,
    marginTop: 2,
    textAlign: 'center',
  },
  subCard: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 16,
  },
  subCardLabel: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '800',
    marginBottom: 8,
  },
  subItemsEditHeader: {
    marginBottom: 6,
  },
  subItemEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  subItemEditTitle: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 16,
  },
  subItemEditMeta: {
    color: '#64748b',
    fontSize: 11,
    marginTop: 2,
  },
  stepperContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#475569',
    overflow: 'hidden',
  },
  stepperBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperInput: {
    width: 48,
    textAlign: 'center',
    color: '#fbbf24',
    fontSize: 14,
    fontWeight: '800',
    paddingVertical: 4,
  },
  quickZeroBtn: {
    marginLeft: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#334155',
    borderWidth: 1,
    borderColor: '#475569',
  },
  quickZeroBtnActive: {
    backgroundColor: '#88133744',
    borderColor: '#f43f5e',
  },
  quickZeroBtnText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
  },
  totalCalcBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
    paddingTop: 10,
    borderTopWidth: 1,
    borderColor: '#334155',
  },
  totalCalcLabel: {
    color: '#f59e0b',
    fontSize: 11,
    fontWeight: '800',
  },
  totalCalcValue: {
    color: '#fbbf24',
    fontSize: 15,
    fontWeight: '900',
  },
  qtyInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 14,
  },
  qtyInput: {
    flex: 1,
    color: '#fbbf24',
    fontSize: 22,
    fontWeight: '800',
    paddingVertical: 10,
  },
  unitSuffix: {
    color: '#94a3b8',
    fontSize: 14,
    fontWeight: '700',
  },
  quickAddRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  quickAddBtn: {
    backgroundColor: '#334155',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#475569',
  },
  quickAddBtnText: {
    color: '#f1f5f9',
    fontSize: 12,
    fontWeight: '700',
  },
  targetPosInput: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    color: '#38bdf8',
    fontSize: 16,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  noteInput: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    color: '#f8fafc',
    fontSize: 13,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 8,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 16,
  },
  chip: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#334155',
  },
  chipText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  footer: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: 1,
    borderColor: '#1e293b',
  },
  cancelBtn: {
    flex: 1,
    backgroundColor: '#1e293b',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  cancelBtnText: {
    color: '#cbd5e1',
    fontSize: 14,
    fontWeight: '700',
  },
  saveBtn: {
    flex: 2,
    backgroundColor: '#059669',
    borderRadius: 12,
    paddingVertical: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    elevation: 3,
  },
  saveBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
});
