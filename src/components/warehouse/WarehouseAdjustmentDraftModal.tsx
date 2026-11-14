import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import {
  ProposalActionType,
  ProposalItem,
  ProposalSubItem,
} from '../../services/warehouseAdjustmentService';
import { fetchProductsForSuggestions, ProductSuggestion, lookupLotBySttOrCode, LookedUpLot } from '../../services/supabase';
import { matchSearch, calculateSearchScore } from '../../utils/searchUtils';

interface WarehouseAdjustmentDraftModalProps {
  visible: boolean;
  onClose: () => void;
  position: any | null; // PositionItem
  initialItem?: ProposalItem | null;
  onSaveDraftItem: (item: ProposalItem) => void;
  availablePositions?: any[]; // Danh sách toàn bộ vị trí kho để gợi ý
}

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
  availablePositions = [],
}: WarehouseAdjustmentDraftModalProps) {
  // LƯU Ý: Tất cả các hook PHẢI được gọi ở đầu component, TUYỆT ĐỐI không return trước hooks
  const insets = useSafeAreaInsets();
  const isCurrentlyOccupied = Boolean(position?.lot_id);
  const currentQty = position?.quantity ?? 0;
  const currentUnit = position?.unit || 'Thùng';

  const noteInputRef = useRef<any>(null);
  const [actionType, setActionType] = useState<ProposalActionType>('NOTE');
  const [newQtyStr, setNewQtyStr] = useState<string>('0');
  const [targetPosCode, setTargetPosCode] = useState<string>('');
  const [targetPosId, setTargetPosId] = useState<string | null>(null);
  const [onlyEmptySuggestions, setOnlyEmptySuggestions] = useState<boolean>(false);
  const [note, setNote] = useState<string>('');
  const [subItems, setSubItems] = useState<ProposalSubItem[]>([]);

  // State thêm sản phẩm mới vào Lot
  const [showAddProductPanel, setShowAddProductPanel] = useState<boolean>(false);
  const [productCatalog, setProductCatalog] = useState<ProductSuggestion[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState<boolean>(false);
  const [productQuery, setProductQuery] = useState<string>('');
  const [selectedNewProduct, setSelectedNewProduct] = useState<ProductSuggestion | null>(null);
  const [newProductQtyStr, setNewProductQtyStr] = useState<string>('1');
  const [newProductUnit, setNewProductUnit] = useState<string>('Thùng');

  // State gắn STT Lot vào vị trí
  const [assignSttQuery, setAssignSttQuery] = useState<string>('');
  const [searchingLot, setSearchingLot] = useState<boolean>(false);
  const [foundAssignLot, setFoundAssignLot] = useState<LookedUpLot | null>(null);
  const [assignLotError, setAssignLotError] = useState<string | null>(null);

  // Khởi tạo state khi mở modal hoặc thay đổi position / initialItem
  useEffect(() => {
    if (!visible || !position) return;

    if (initialItem) {
      setActionType(initialItem.action_type);
      setNewQtyStr(
        initialItem.new_quantity != null ? String(initialItem.new_quantity) : String(currentQty)
      );
      setTargetPosCode(initialItem.target_position_code || '');
      setTargetPosId(initialItem.target_position_id || null);
      setNote(initialItem.note || '');

      if (initialItem.sub_items && initialItem.sub_items.length > 0) {
        setSubItems(initialItem.sub_items);
      } else {
        const extracted = extractSubItemsFromPosition(position);
        setSubItems(extracted);
      }
      if (initialItem.action_type === 'ASSIGN_LOT' && initialItem.lot_id) {
        setAssignSttQuery(initialItem.lot_stt || initialItem.lot_code || '');
        setFoundAssignLot({
          id: initialItem.lot_id,
          code: initialItem.lot_code || '',
          stt: initialItem.lot_stt || null,
          quantity: initialItem.new_quantity ?? 0,
          unit: initialItem.unit || 'Thùng',
          product_name: initialItem.product_name || '',
          sku: initialItem.sku || null,
          current_position_id: initialItem.target_position_id || null,
          current_position_code: initialItem.target_position_code || null,
        });
        setAssignLotError(null);
      } else {
        setAssignSttQuery('');
        setFoundAssignLot(null);
        setAssignLotError(null);
      }
    } else {
      const defaultAction: ProposalActionType = 'NOTE';
      setActionType(defaultAction);
      setNewQtyStr(String(currentQty));
      setTargetPosCode('');
      setTargetPosId(null);
      setNote('');
      setAssignSttQuery('');
      setFoundAssignLot(null);
      setAssignLotError(null);

      const extracted = extractSubItemsFromPosition(position);
      setSubItems(extracted);
    }

    const shouldAutoOpenAdd = !isCurrentlyOccupied && (!initialItem || initialItem.action_type === 'SET_QTY') && !(initialItem?.sub_items && initialItem.sub_items.length > 0);
    setShowAddProductPanel(shouldAutoOpenAdd);
    if (shouldAutoOpenAdd && productCatalog.length === 0 && !loadingCatalog) {
      setLoadingCatalog(true);
      fetchProductsForSuggestions()
        .then(list => setProductCatalog(list || []))
        .finally(() => setLoadingCatalog(false));
    }
    setProductQuery('');
    setSelectedNewProduct(null);
    setNewProductQtyStr('1');
    setNewProductUnit(position?.unit || 'Thùng');
  }, [visible, position, initialItem, isCurrentlyOccupied, currentQty]);

  const hasMultipleProducts = subItems.length > 1 || subItems.some(s => s.is_new);

  const handleOpenAddProductPanel = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const nextOpen = !showAddProductPanel;
    setShowAddProductPanel(nextOpen);
    if (nextOpen && productCatalog.length === 0 && !loadingCatalog) {
      setLoadingCatalog(true);
      try {
        const list = await fetchProductsForSuggestions();
        setProductCatalog(list || []);
      } finally {
        setLoadingCatalog(false);
      }
    }
  }, [showAddProductPanel, productCatalog.length, loadingCatalog]);

  const filteredProductSuggestions = useMemo(() => {
    if (!showAddProductPanel || productCatalog.length === 0) return [];
    const q = productQuery.trim();
    if (!q) return productCatalog.slice(0, 15);
    return productCatalog
      .filter(p => matchSearch(p, q))
      .sort((a, b) => {
        const sA = calculateSearchScore(a, q);
        const sB = calculateSearchScore(b, q);
        return sB - sA;
      })
      .slice(0, 20);
  }, [showAddProductPanel, productCatalog, productQuery]);

  const handleConfirmAddProductToLot = useCallback(() => {
    if (!selectedNewProduct) return;
    const qty = parseFloat(newProductQtyStr);
    const validQty = isNaN(qty) || qty <= 0 ? 1 : qty;
    const unitVal = newProductUnit.trim() || currentUnit || 'Thùng';

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSubItems(prev => {
      // Nếu là pallet đơn chưa có subItems (trường hợp đặc biệt), giữ lại dòng gốc từ position
      let base = prev;
      if (base.length === 0 && position?.product_name) {
        const baseQty = parseFloat(newQtyStr);
        base = [{
          product_id: null,
          product_name: position.product_name,
          sku: position.sku || null,
          current_quantity: position.quantity != null ? Number(position.quantity) : 0,
          new_quantity: isNaN(baseQty) ? (position.quantity ?? 0) : baseQty,
          unit: position.unit || 'Thùng',
        }];
      } else if (base.length === 1) {
        const baseQty = parseFloat(newQtyStr);
        if (!isNaN(baseQty)) {
          base = [{ ...base[0], new_quantity: baseQty }];
        }
      }

      const next: ProposalSubItem[] = [
        ...base,
        {
          product_id: selectedNewProduct.id,
          product_name: selectedNewProduct.name,
          sku: selectedNewProduct.sku || null,
          current_quantity: 0,
          new_quantity: validQty,
          unit: unitVal,
          is_new: true,
        },
      ];
      const total = next.reduce((sum, item) => sum + (item.new_quantity || 0), 0);
      setNewQtyStr(String(total));
      return next;
    });

    setShowAddProductPanel(false);
    setSelectedNewProduct(null);
    setProductQuery('');
    setNewProductQtyStr('1');
  }, [selectedNewProduct, newProductQtyStr, newProductUnit, currentUnit, position, newQtyStr]);

  const handleRemoveNewSubItem = useCallback((index: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSubItems(prev => {
      const next = prev.filter((_, idx) => idx !== index);
      const total = next.reduce((sum, item) => sum + (item.new_quantity || 0), 0);
      setNewQtyStr(String(total));
      return next;
    });
  }, []);

  // Danh sách vị trí gợi ý thông minh khi chuyển ô (ưu tiên hiển thị từ T1 đến T5, bao gồm cả ô có hàng và ô trống)
  const positionSuggestions = useMemo(() => {
    if (actionType !== 'MOVE' || !availablePositions || availablePositions.length === 0) {
      return [];
    }

    const extractFloor = (code: string): number => {
      const m = (code || '').match(/T(\d+)/i);
      if (!m) return 999;
      const digits = m[1];
      // Ví dụ T101 -> tầng 1, T502 -> tầng 5; còn T1..T5 -> tầng 1..5
      if (digits.length >= 3) {
        return parseInt(digits[0], 10);
      }
      return parseInt(digits, 10);
    };

    const sortPositions = (list: any[]) => {
      return [...list].sort((a, b) => {
        const codeA = (a.code || '').toUpperCase();
        const codeB = (b.code || '').toUpperCase();
        const floorA = extractFloor(codeA);
        const floorB = extractFloor(codeB);

        // Ưu tiên tầng từ T1 đến T5 lên trước
        const isPriorityA = floorA >= 1 && floorA <= 5;
        const isPriorityB = floorB >= 1 && floorB <= 5;
        if (isPriorityA && !isPriorityB) return -1;
        if (!isPriorityA && isPriorityB) return 1;

        if (floorA !== floorB) {
          return floorA - floorB;
        }

        // Cùng tầng thì sắp xếp theo mã vị trí tự nhiên (T101 -> T102 -> ...)
        return codeA.localeCompare(codeB, undefined, { numeric: true });
      });
    };

    const currentPosId = position?.id;
    let pool = availablePositions.filter((p: any) => p.id !== currentPosId);

    if (onlyEmptySuggestions) {
      pool = pool.filter((p: any) => !p.lot_id);
    }

    const query = targetPosCode.trim().toUpperCase();

    if (!query) {
      // Khi chưa gõ từ khóa: gợi ý các ô trong cùng dãy hoặc cùng khu vực, sắp xếp theo tầng T1 -> T5
      const currentPrefix = (position?.code || '').slice(0, 4).toUpperCase();
      if (currentPrefix) {
        const samePrefix = pool.filter((p: any) =>
          (p.code || '').toUpperCase().startsWith(currentPrefix)
        );
        if (samePrefix.length > 0) {
          return sortPositions(samePrefix).slice(0, 20);
        }
      }
      return sortPositions(pool).slice(0, 20);
    }

    const matched = pool.filter((p: any) => (p.code || '').toUpperCase().includes(query));
    return sortPositions(matched).slice(0, 20);
  }, [actionType, availablePositions, targetPosCode, onlyEmptySuggestions, position]);

  const handleSelectTargetPosition = useCallback((targetPos: any) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTargetPosCode(targetPos.code || '');
    setTargetPosId(targetPos.id || null);
  }, []);

  const handleSelectAction = useCallback((type: ProposalActionType) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setActionType(type);

    if (type === 'CLEAR') {
      // Đặt tất cả các sub_items về 0
      setSubItems(prev => prev.map(s => ({ ...s, new_quantity: 0 })));
      setNewQtyStr('0');
    } else if (type === 'NOTE') {
      // Bấm vào "Chỉ ghi chú" -> nhảy thẳng con trỏ vào ô nhập ghi chú
      setTimeout(() => noteInputRef.current?.focus(), 80);
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

  const handleSearchAssignLot = useCallback(async (overrideQuery?: string) => {
    const q = (overrideQuery ?? assignSttQuery).trim().toUpperCase();
    if (!q) {
      setFoundAssignLot(null);
      setAssignLotError('Vui lòng nhập STT (VD: G949) hoặc mã Lot.');
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setAssignLotError(null);

    // 1. Tìm nhanh trong danh sách vị trí hiện có trên bản đồ (hoạt động cả khi offline)
    if (Array.isArray(availablePositions) && availablePositions.length > 0) {
      const localMatch = availablePositions.find((p: any) =>
        p.lot_id && (
          (p.stt || '').toUpperCase() === q ||
          (p.lot_code || '').toUpperCase() === q
        )
      );
      if (localMatch) {
        setFoundAssignLot({
          id: localMatch.lot_id,
          code: localMatch.lot_code || '',
          stt: localMatch.stt || null,
          quantity: Number(localMatch.quantity) || 0,
          unit: localMatch.unit || 'Thùng',
          product_name: localMatch.product_name || `Lot ${localMatch.lot_code || ''}`,
          sku: localMatch.sku || null,
          items: Array.isArray(localMatch.items) ? localMatch.items : undefined,
          current_position_id: localMatch.id,
          current_position_code: localMatch.code,
        });
        return;
      }
    }

    // 2. Tra cứu trên Supabase (tìm được cả các Lot chưa gán vị trí)
    setSearchingLot(true);
    try {
      const remoteLot = await lookupLotBySttOrCode(q);
      if (remoteLot) {
        setFoundAssignLot(remoteLot);
      } else {
        setFoundAssignLot(null);
        setAssignLotError(`Không tìm thấy Lot nào khớp STT/mã "${q}" trong kho hiện tại.`);
      }
    } finally {
      setSearchingLot(false);
    }
  }, [assignSttQuery, availablePositions]);

  const handleSave = () => {
    if (!position) return;

    const cleanStt = assignSttQuery.trim().toUpperCase();
    if (actionType === 'ASSIGN_LOT' && !cleanStt) {
      Alert.alert(
        'Chưa nhập STT Lot',
        'Vui lòng nhập STT của Lot (VD: G57, G88...) cần gắn vào vị trí này.'
      );
      return;
    }

    if (actionType === 'NOTE' && !note.trim()) {
      Alert.alert(
        'Chưa nhập ghi chú',
        'Vui lòng nhập nội dung ghi chú muốn gửi lên Web.'
      );
      return;
    }

    if (!isCurrentlyOccupied && actionType === 'SET_QTY' && subItems.length === 0) {
      Alert.alert(
        'Chưa chọn sản phẩm',
        'Vui lòng chọn ít nhất 1 sản phẩm để tạo Lot mới cho vị trí trống.'
      );
      return;
    }

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

    let resolvedTargetId = targetPosId;
    if (actionType === 'MOVE') {
      if (!resolvedTargetId && targetPosCode.trim() && Array.isArray(availablePositions)) {
        const found = availablePositions.find(
          (p: any) => (p.code || '').trim().toUpperCase() === targetPosCode.trim().toUpperCase()
        );
        if (found) resolvedTargetId = found.id;
      }
    }

    const item: ProposalItem = actionType === 'ASSIGN_LOT'
      ? {
          id: initialItem?.id || `${position.id}-${Date.now()}`,
          position_id: position.id,
          position_code: position.code,
          warehouse_name: position.warehouse_name,
          action_type: 'ASSIGN_LOT',
          lot_id: foundAssignLot?.id || null,
          lot_code: foundAssignLot?.code || null,
          lot_stt: foundAssignLot?.stt || cleanStt,
          product_name: foundAssignLot?.product_name || `Gắn STT ${cleanStt}`,
          sku: foundAssignLot?.sku || null,
          current_quantity: position.quantity ?? 0,
          unit: foundAssignLot?.unit || 'Thùng',
          new_quantity: foundAssignLot?.quantity ?? null,
          target_position_id: foundAssignLot?.current_position_id || null,
          target_position_code: foundAssignLot?.current_position_code || null,
          note: note.trim() || null,
          updated_at: new Date().toISOString(),
        }
      : {
          id: initialItem?.id || `${position.id}-${Date.now()}`,
          position_id: position.id,
          position_code: position.code,
          warehouse_name: position.warehouse_name,
          action_type: actionType,
          lot_id: position.lot_id || null,
          lot_code: position.lot_code || null,
          product_name: position.product_name || (finalSubItems && finalSubItems.length > 0 ? finalSubItems.map(s => s.product_name).join(', ') : null),
          sku: position.sku || (finalSubItems && finalSubItems.length > 0 ? (finalSubItems.map(s => s.sku).filter(Boolean).join(', ') || null) : null),
          current_quantity: position.quantity ?? null,
          unit: position.unit || (finalSubItems && finalSubItems.length > 0 ? finalSubItems[0].unit : 'Thùng'),
          sub_items: finalSubItems,
          new_quantity: parsedNewQty,
          target_position_id: actionType === 'MOVE' ? resolvedTargetId : null,
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
        <View style={[styles.sheetContainer, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
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
                onPress={() => handleSelectAction('NOTE')}
                style={[
                  styles.actionBtn,
                  styles.actionBtnFull,
                  actionType === 'NOTE' && styles.actionBtnActiveNote,
                ]}
              >
                <Ionicons
                  name="chatbox-ellipses-outline"
                  size={19}
                  color={actionType === 'NOTE' ? '#34d399' : '#94a3b8'}
                />
                <Text
                  style={[
                    styles.actionBtnText,
                    actionType === 'NOTE' && { color: '#34d399', fontWeight: '800' },
                  ]}
                >
                  Chỉ ghi chú
                </Text>
                <Text style={styles.actionBtnSub}>Gửi lời nhắn cho Web đọc (không đổi hàng)</Text>
              </TouchableOpacity>

              {isCurrentlyOccupied && (
                <TouchableOpacity
                  onPress={() => handleSelectAction('CLEAR')}
                  style={[
                    styles.actionBtn,
                    styles.actionBtnHalf,
                    actionType === 'CLEAR' && styles.actionBtnActiveClear,
                  ]}
                >
                  <Ionicons
                    name="trash-outline"
                    size={20}
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
              )}

              <TouchableOpacity
                onPress={() => handleSelectAction('ASSIGN_LOT')}
                style={[
                  styles.actionBtn,
                  isCurrentlyOccupied && styles.actionBtnHalf,
                  actionType === 'ASSIGN_LOT' && styles.actionBtnActiveAssign,
                ]}
              >
                <Ionicons
                  name="pricetag-outline"
                  size={20}
                  color={actionType === 'ASSIGN_LOT' ? '#a855f7' : '#94a3b8'}
                />
                <Text
                  style={[
                    styles.actionBtnText,
                    actionType === 'ASSIGN_LOT' && { color: '#c084fc', fontWeight: '800' },
                  ]}
                >
                  Gắn STT Lot
                </Text>
                <Text style={styles.actionBtnSub}>Nhập G57, G88...</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => handleSelectAction('SET_QTY')}
                style={[
                  styles.actionBtn,
                  isCurrentlyOccupied && styles.actionBtnHalf,
                  actionType === 'SET_QTY' && styles.actionBtnActiveQty,
                ]}
              >
                <Ionicons
                  name="calculator-outline"
                  size={20}
                  color={actionType === 'SET_QTY' ? '#fbbf24' : '#94a3b8'}
                />
                <Text
                  style={[
                    styles.actionBtnText,
                    actionType === 'SET_QTY' && { color: '#fbbf24', fontWeight: '800' },
                  ]}
                >
                  {isCurrentlyOccupied ? 'Sửa số lượng' : 'Tạo Lot mới'}
                </Text>
                <Text style={styles.actionBtnSub}>
                  {!isCurrentlyOccupied
                    ? 'Thêm SP mới'
                    : hasMultipleProducts
                      ? 'Từng dòng SP'
                      : 'Lẻ thùng (25t...)'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => handleSelectAction('MOVE')}
                style={[
                  styles.actionBtn,
                  isCurrentlyOccupied && styles.actionBtnHalf,
                  actionType === 'MOVE' && styles.actionBtnActiveMove,
                ]}
              >
                <Ionicons
                  name="swap-horizontal"
                  size={20}
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
            {actionType === 'ASSIGN_LOT' && (
              <View style={styles.subCard}>
                <Text style={styles.subCardLabel}>NHẬP STT CỦA LOT CẦN GẮN VÀO Ô {position.code}:</Text>
                <View style={styles.assignInputRow}>
                  <TextInput
                    style={styles.assignSttInput}
                    value={assignSttQuery}
                    onChangeText={(txt) => {
                      setAssignSttQuery(txt);
                      setAssignLotError(null);
                      const clean = txt.trim().toUpperCase();
                      if (clean && Array.isArray(availablePositions)) {
                        const localMatch = availablePositions.find((p: any) =>
                          p.lot_id && (
                            (p.stt || '').toUpperCase() === clean ||
                            (p.lot_code || '').toUpperCase() === clean
                          )
                        );
                        if (localMatch) {
                          setFoundAssignLot({
                            id: localMatch.lot_id,
                            code: localMatch.lot_code || '',
                            stt: localMatch.stt || clean,
                            quantity: Number(localMatch.quantity) || 0,
                            unit: localMatch.unit || 'Thùng',
                            product_name: localMatch.product_name || `Lot ${localMatch.lot_code || ''}`,
                            sku: localMatch.sku || null,
                            current_position_id: localMatch.id,
                            current_position_code: localMatch.code,
                          });
                        } else {
                          setFoundAssignLot(null);
                        }
                      } else {
                        setFoundAssignLot(null);
                      }
                    }}
                    placeholder="VD: G57, G88..."
                    placeholderTextColor="#64748b"
                    autoCapitalize="characters"
                    returnKeyType="done"
                  />
                  <TouchableOpacity
                    onPress={() => handleSearchAssignLot()}
                    disabled={searchingLot}
                    style={styles.assignSearchBtn}
                  >
                    <Ionicons name="search" size={16} color="#ffffff" />
                    <Text style={styles.assignSearchBtnText}>
                      {searchingLot ? 'Đang tìm...' : 'Kiểm tra'}
                    </Text>
                  </TouchableOpacity>
                </View>

                <Text style={{ color: '#94a3b8', fontSize: 11, marginTop: 6 }}>
                  Chỉ cần nhập STT rồi bấm Lưu nháp — Web sẽ tự đối chiếu & gán Lot khi duyệt.
                </Text>

                {assignLotError && (
                  <View style={styles.assignErrorBox}>
                    <Ionicons name="information-circle" size={15} color="#fbbf24" />
                    <Text style={[styles.assignErrorText, { color: '#fde68a' }]}>
                      {assignLotError} (Vẫn có thể lưu nháp để Web kiểm tra)
                    </Text>
                  </View>
                )}

                {foundAssignLot && (
                  <View style={styles.foundLotCard}>
                    <View style={styles.foundLotTopRow}>
                      {foundAssignLot.stt && (
                        <View style={styles.foundLotSttBadge}>
                          <Text style={styles.foundLotSttText}>STT: {foundAssignLot.stt}</Text>
                        </View>
                      )}
                      <Text style={styles.foundLotCodeText}>{foundAssignLot.code}</Text>
                    </View>
                    <Text style={styles.foundLotProductText} numberOfLines={2}>
                      {foundAssignLot.product_name}
                    </Text>
                    <Text style={styles.foundLotQtyText}>
                      Số lượng: <Text style={{ color: '#34d399', fontWeight: '800' }}>{foundAssignLot.quantity} {foundAssignLot.unit}</Text>
                    </Text>
                    {foundAssignLot.current_position_code && foundAssignLot.current_position_code !== position.code && (
                      <View style={styles.foundLotMoveHint}>
                        <Ionicons name="swap-horizontal" size={13} color="#fbbf24" />
                        <Text style={styles.foundLotMoveHintText}>
                          Lot đang ở ô {foundAssignLot.current_position_code} — khi duyệt sẽ tự chuyển sang {position.code}.
                        </Text>
                      </View>
                    )}
                  </View>
                )}
              </View>
            )}

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
                      <View key={sIdx} style={[styles.subItemEditRow, sub.is_new && styles.subItemEditRowNew]}>
                        <View style={{ flex: 1, paddingRight: 8 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            {sub.is_new && (
                              <View style={styles.newSubBadge}>
                                <Text style={styles.newSubBadgeText}>MỚI THÊM</Text>
                              </View>
                            )}
                            <Text style={styles.subItemEditTitle} numberOfLines={2}>
                              {sub.product_name}
                            </Text>
                          </View>
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

                        {/* Nút Hết (0) nhanh hoặc Xóa dòng mới */}
                        {sub.is_new ? (
                          <TouchableOpacity
                            onPress={() => handleRemoveNewSubItem(sIdx)}
                            style={styles.removeNewSubBtn}
                          >
                            <Ionicons name="trash-outline" size={15} color="#f43f5e" />
                          </TouchableOpacity>
                        ) : (
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
                        )}
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
                ) : isCurrentlyOccupied ? (
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
                ) : (
                  <Text style={styles.subCardLabel}>
                    CHỌN SẢN PHẨM ĐỂ TẠO LOT MỚI CHO Ô {position.code}:
                  </Text>
                )}

                {/* Nút & Khung Thêm 1 sản phẩm mới vào Lot hiện tại (hoặc tạo Lot mới cho ô trống) */}
                <View style={[styles.addProductSection, !isCurrentlyOccupied && subItems.length === 0 && { marginTop: 4, borderTopWidth: 0, paddingTop: 0 }]}>
                    <TouchableOpacity
                      onPress={handleOpenAddProductPanel}
                      style={[
                        styles.addProductToggleBtn,
                        showAddProductPanel && styles.addProductToggleBtnActive,
                      ]}
                    >
                      <Ionicons
                        name={showAddProductPanel ? 'chevron-up-circle-outline' : 'add-circle-outline'}
                        size={17}
                        color="#38bdf8"
                      />
                      <Text style={styles.addProductToggleText}>
                        {showAddProductPanel ? 'Đóng khung thêm sản phẩm' : '+ Thêm sản phẩm vào Lot này'}
                      </Text>
                    </TouchableOpacity>

                    {showAddProductPanel && (
                      <View style={styles.addProductPanel}>
                        <Text style={styles.addProductPanelTitle}>
                          CHỌN SẢN PHẨM THÊM VÀO LOT:
                        </Text>
                        <View style={styles.productSearchBox}>
                          <Ionicons name="search" size={15} color="#64748b" />
                          <TextInput
                            style={styles.productSearchInput}
                            value={productQuery}
                            onChangeText={(txt) => {
                              setProductQuery(txt);
                              if (selectedNewProduct) setSelectedNewProduct(null);
                            }}
                            placeholder="Tìm tên SP, SKU hoặc tên viết tắt..."
                            placeholderTextColor="#64748b"
                          />
                          {productQuery.length > 0 && (
                            <TouchableOpacity onPress={() => { setProductQuery(''); setSelectedNewProduct(null); }}>
                              <Ionicons name="close-circle" size={16} color="#64748b" />
                            </TouchableOpacity>
                          )}
                        </View>

                        {!selectedNewProduct ? (
                          <ScrollView style={styles.productListBox} nestedScrollEnabled>
                            {loadingCatalog ? (
                              <Text style={styles.productEmptyText}>Đang tải danh mục sản phẩm...</Text>
                            ) : filteredProductSuggestions.length === 0 ? (
                              <Text style={styles.productEmptyText}>Không tìm thấy sản phẩm phù hợp</Text>
                            ) : (
                              filteredProductSuggestions.map((prod) => (
                                <TouchableOpacity
                                  key={prod.id}
                                  onPress={() => {
                                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                    setSelectedNewProduct(prod);
                                  }}
                                  style={styles.productSuggestionItem}
                                >
                                  <Text style={styles.productSuggestionName} numberOfLines={2}>
                                    {prod.name}
                                  </Text>
                                  <Text style={styles.productSuggestionSku}>
                                    SKU: {prod.sku || '---'}{prod.aliases ? ` • ${prod.aliases}` : ''}
                                  </Text>
                                </TouchableOpacity>
                              ))
                            )}
                          </ScrollView>
                        ) : (
                          <View style={styles.selectedProductBox}>
                            <View style={styles.selectedProductHeader}>
                              <View style={{ flex: 1 }}>
                                <Text style={styles.selectedProductName}>{selectedNewProduct.name}</Text>
                                <Text style={styles.selectedProductSku}>SKU: {selectedNewProduct.sku || '---'}</Text>
                              </View>
                              <TouchableOpacity
                                onPress={() => setSelectedNewProduct(null)}
                                style={styles.changeProdBtn}
                              >
                                <Text style={styles.changeProdBtnText}>Đổi SP</Text>
                              </TouchableOpacity>
                            </View>

                            <View style={styles.newProdInputsRow}>
                              <View style={{ flex: 1 }}>
                                <Text style={styles.newProdLabel}>SỐ LƯỢNG:</Text>
                                <TextInput
                                  style={styles.newProdInput}
                                  value={newProductQtyStr}
                                  onChangeText={setNewProductQtyStr}
                                  keyboardType="numeric"
                                  placeholder="1"
                                  placeholderTextColor="#64748b"
                                  selectTextOnFocus
                                />
                              </View>
                              <View style={{ flex: 1.4 }}>
                                <Text style={styles.newProdLabel}>ĐƠN VỊ:</Text>
                                <TextInput
                                  style={styles.newProdInput}
                                  value={newProductUnit}
                                  onChangeText={setNewProductUnit}
                                  placeholder="Thùng (20kg)..."
                                  placeholderTextColor="#64748b"
                                />
                              </View>
                            </View>

                            <View style={styles.unitQuickRow}>
                              {['Thùng (20kg)', 'Thùng (9.6kg)', 'Thùng', 'Kg', 'Khay'].map((u) => (
                                <TouchableOpacity
                                  key={u}
                                  onPress={() => setNewProductUnit(u)}
                                  style={[
                                    styles.unitQuickChip,
                                    newProductUnit === u && styles.unitQuickChipActive,
                                  ]}
                                >
                                  <Text
                                    style={[
                                      styles.unitQuickChipText,
                                      newProductUnit === u && { color: '#38bdf8', fontWeight: '800' },
                                    ]}
                                  >
                                    {u}
                                  </Text>
                                </TouchableOpacity>
                              ))}
                            </View>

                            <TouchableOpacity
                              onPress={handleConfirmAddProductToLot}
                              style={styles.confirmAddProdBtn}
                            >
                              <Ionicons name="add-circle" size={18} color="#ffffff" />
                              <Text style={styles.confirmAddProdBtnText}>THÊM VÀO LOT NÀY</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      </View>
                    )}
                  </View>
              </View>
            )}

            {actionType === 'MOVE' && (
              <View style={styles.subCard}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <Text style={styles.subCardLabel}>VỊ TRÍ ĐÍCH CHUYỂN ĐẾN (MÃ Ô):</Text>
                  <TouchableOpacity
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setOnlyEmptySuggestions(!onlyEmptySuggestions);
                    }}
                    style={[
                      styles.filterEmptyBtn,
                      onlyEmptySuggestions && styles.filterEmptyBtnActive,
                    ]}
                  >
                    <Ionicons
                      name={onlyEmptySuggestions ? 'checkmark-circle' : 'ellipse-outline'}
                      size={13}
                      color={onlyEmptySuggestions ? '#10b981' : '#64748b'}
                    />
                    <Text style={[styles.filterEmptyText, onlyEmptySuggestions && { color: '#10b981', fontWeight: '800' }]}>
                      Chỉ ô trống
                    </Text>
                  </TouchableOpacity>
                </View>

                {/* Input nhập mã ô */}
                <View style={styles.targetInputContainer}>
                  <TextInput
                    style={styles.targetPosInput}
                    value={targetPosCode}
                    onChangeText={(txt) => {
                      setTargetPosCode(txt);
                      setTargetPosId(null);
                    }}
                    placeholder="Nhập hoặc chọn gợi ý bên dưới..."
                    placeholderTextColor="#64748b"
                    autoCapitalize="characters"
                  />
                  {targetPosCode.length > 0 && (
                    <TouchableOpacity
                      onPress={() => {
                        setTargetPosCode('');
                        setTargetPosId(null);
                      }}
                      style={styles.clearTargetBtn}
                    >
                      <Ionicons name="close-circle" size={18} color="#94a3b8" />
                    </TouchableOpacity>
                  )}
                </View>

                {/* Danh sách gợi ý vị trí */}
                <View style={{ marginTop: 10 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <Text style={styles.suggestionsHeader}>
                      {targetPosCode.trim()
                        ? `GỢI Ý KHỚP TỪ KHÓA (${positionSuggestions.length}):`
                        : `GỢI Ý Ô GẦN KỀ CÙNG DÃY (${positionSuggestions.length}):`}
                    </Text>
                    {targetPosId && (
                      <View style={styles.selectedTargetBadge}>
                        <Ionicons name="checkmark-circle" size={12} color="#10b981" />
                        <Text style={styles.selectedTargetText}>Đã khớp ô</Text>
                      </View>
                    )}
                  </View>

                  {positionSuggestions.length === 0 ? (
                    <Text style={styles.noSuggestionText}>
                      Không tìm thấy vị trí nào phù hợp. Bạn vẫn có thể nhập trực tiếp mã ô.
                    </Text>
                  ) : (
                    <View style={styles.suggestionsGrid}>
                      {positionSuggestions.map((sp: any) => {
                        const isSelected = (sp.code || '').toUpperCase() === targetPosCode.trim().toUpperCase();
                        const isEmpty = !sp.lot_id;
                        return (
                          <TouchableOpacity
                            key={sp.id}
                            onPress={() => handleSelectTargetPosition(sp)}
                            style={[
                              styles.suggestionItem,
                              isSelected && styles.suggestionItemActive,
                              isEmpty ? styles.suggestionItemEmpty : styles.suggestionItemOccupied,
                            ]}
                          >
                            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                              <Text
                                style={[
                                  styles.suggestionCode,
                                  isSelected && { color: '#38bdf8', fontWeight: '900' },
                                ]}
                                numberOfLines={1}
                              >
                                {sp.code}
                              </Text>
                              <View
                                style={[
                                  styles.statusDot,
                                  { backgroundColor: isEmpty ? '#10b981' : '#f59e0b' },
                                ]}
                              />
                            </View>
                            <Text
                              style={[
                                styles.suggestionStatus,
                                { color: isEmpty ? '#34d399' : '#fbbf24' },
                              ]}
                              numberOfLines={1}
                            >
                              {isEmpty ? '🟢 Trống' : `🔴 ${sp.product_name || 'Có hàng'}`}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  )}
                </View>
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

            {/* Ghi chú */}
            <Text style={styles.sectionLabel}>GHI CHÚ:</Text>
            <TextInput
              ref={noteInputRef}
              style={[
                styles.noteInput,
                actionType === 'NOTE' && styles.noteInputActive,
              ]}
              value={note}
              onChangeText={setNote}
              placeholder="Nhập nội dung ghi chú..."
              placeholderTextColor="#64748b"
              multiline
            />
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
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  actionBtn: {
    flex: 1,
    minWidth: '30%',
    backgroundColor: '#1e293b',
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 8,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#334155',
  },
  actionBtnHalf: {
    flexGrow: 1,
    flexBasis: '47%',
  },
  actionBtnFull: {
    flexGrow: 1,
    flexBasis: '100%',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 9,
  },
  actionBtnActiveNote: {
    borderColor: '#10b981',
    backgroundColor: '#10b98118',
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
  actionBtnActiveAssign: {
    borderColor: '#a855f7',
    backgroundColor: '#a855f718',
  },
  assignInputRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  assignSttInput: {
    flex: 1,
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#475569',
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '800',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  assignSearchBtn: {
    backgroundColor: '#7c3aed',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  assignSearchBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
  },
  assignErrorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    backgroundColor: '#f43f5e1a',
    borderWidth: 1,
    borderColor: '#f43f5e44',
    padding: 8,
    borderRadius: 8,
  },
  assignErrorText: {
    color: '#fda4af',
    fontSize: 12,
    flex: 1,
  },
  foundLotCard: {
    marginTop: 10,
    backgroundColor: '#0f172a',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#a855f766',
    gap: 4,
  },
  foundLotTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  foundLotSttBadge: {
    backgroundColor: '#7c3aed33',
    borderWidth: 1,
    borderColor: '#a855f788',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  foundLotSttText: {
    color: '#d8b4fe',
    fontSize: 11,
    fontWeight: '900',
  },
  foundLotCodeText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  foundLotProductText: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 2,
  },
  foundLotQtyText: {
    color: '#94a3b8',
    fontSize: 12,
  },
  foundLotMoveHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
    backgroundColor: '#f59e0b1a',
    padding: 6,
    borderRadius: 6,
  },
  foundLotMoveHintText: {
    color: '#fde68a',
    fontSize: 11,
    flex: 1,
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
    flex: 1,
  },
  targetInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    position: 'relative',
  },
  clearTargetBtn: {
    position: 'absolute',
    right: 12,
    padding: 4,
  },
  filterEmptyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
  },
  filterEmptyBtnActive: {
    backgroundColor: '#064e3b33',
    borderColor: '#059669',
  },
  filterEmptyText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  suggestionsHeader: {
    color: '#94a3b8',
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  selectedTargetBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#064e3b44',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#05966955',
  },
  selectedTargetText: {
    color: '#34d399',
    fontSize: 10,
    fontWeight: '800',
  },
  noSuggestionText: {
    color: '#64748b',
    fontSize: 11.5,
    fontStyle: 'italic',
    paddingVertical: 8,
  },
  suggestionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  suggestionItem: {
    width: '48%',
    backgroundColor: '#0f172a',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  suggestionItemActive: {
    borderColor: '#38bdf8',
    backgroundColor: '#0c4a6e33',
  },
  suggestionItemEmpty: {
    borderColor: '#10b98144',
  },
  suggestionItemOccupied: {
    borderColor: '#f59e0b44',
  },
  suggestionCode: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    flex: 1,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  suggestionStatus: {
    fontSize: 10,
    marginTop: 3,
    fontWeight: '600',
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
    minHeight: 46,
    textAlignVertical: 'top',
    marginBottom: 16,
  },
  noteInputActive: {
    borderColor: '#10b981',
    backgroundColor: '#10b98110',
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
  subItemEditRowNew: {
    borderColor: '#10b98166',
    backgroundColor: '#05966912',
  },
  newSubBadge: {
    backgroundColor: '#10b98126',
    borderWidth: 1,
    borderColor: '#10b98188',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  newSubBadgeText: {
    color: '#34d399',
    fontSize: 9,
    fontWeight: '900',
  },
  removeNewSubBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: '#f43f5e1a',
    borderWidth: 1,
    borderColor: '#f43f5e44',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  addProductSection: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#334155',
    paddingTop: 10,
  },
  addProductToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#0ea5e918',
    borderWidth: 1,
    borderColor: '#0ea5e955',
  },
  addProductToggleBtnActive: {
    backgroundColor: '#0ea5e928',
    borderColor: '#38bdf8',
  },
  addProductToggleText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '800',
  },
  addProductPanel: {
    marginTop: 10,
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  addProductPanelTitle: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  productSearchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 10,
    gap: 6,
  },
  productSearchInput: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 13,
    paddingVertical: 8,
  },
  productListBox: {
    maxHeight: 170,
    marginTop: 8,
  },
  productEmptyText: {
    color: '#64748b',
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: 14,
  },
  productSuggestionItem: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  productSuggestionName: {
    color: '#f1f5f9',
    fontSize: 13,
    fontWeight: '700',
  },
  productSuggestionSku: {
    color: '#64748b',
    fontSize: 11,
    marginTop: 2,
  },
  selectedProductBox: {
    marginTop: 10,
    gap: 10,
  },
  selectedProductHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1e293b',
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#38bdf855',
    gap: 8,
  },
  selectedProductName: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '800',
  },
  selectedProductSku: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 2,
  },
  changeProdBtn: {
    backgroundColor: '#334155',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
  },
  changeProdBtnText: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '700',
  },
  newProdInputsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  newProdLabel: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '800',
    marginBottom: 4,
  },
  newProdInput: {
    backgroundColor: '#1e293b',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '700',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  unitQuickRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  unitQuickChip: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  unitQuickChipActive: {
    borderColor: '#38bdf8',
    backgroundColor: '#0ea5e91a',
  },
  unitQuickChipText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  confirmAddProdBtn: {
    backgroundColor: '#0284c7',
    borderRadius: 10,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  confirmAddProdBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
});
