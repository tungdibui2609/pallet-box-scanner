import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Image,
  Modal,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, AppThemeColors } from '../../contexts/ThemeContext';
import {
  LocalPickedImage,
  capturePhotoWithCamera,
  pickPhotosFromLibrary,
} from '../../services/operationImagesService';

interface Props {
  images: LocalPickedImage[];
  onChange: (next: LocalPickedImage[]) => void;
  compact?: boolean;
  label?: string;
}

export default function OperationImagePickerBar({
  images,
  onChange,
  compact = false,
  label = 'Ảnh chứng minh (không bắt buộc)',
}: Props) {
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  const [busy, setBusy] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);

  const handleCapture = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const photo = await capturePhotoWithCamera();
      if (photo) {
        onChange([...images, photo]);
      }
    } finally {
      setBusy(false);
    }
  };

  const handlePickLibrary = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const picked = await pickPhotosFromLibrary(5);
      if (picked.length > 0) {
        onChange([...images, ...picked]);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = (localId: string) => {
    onChange(images.filter((img) => img.localId !== localId));
  };

  return (
    <View style={[styles.container, compact && styles.containerCompact]}>
      <View style={styles.headerRow}>
        <Text style={styles.label} numberOfLines={1}>
          {label} {images.length > 0 ? `(${images.length})` : ''}
        </Text>
        <View style={styles.actionsRow}>
          <TouchableOpacity
            onPress={handleCapture}
            disabled={busy}
            style={[styles.btn, styles.btnCamera]}
            activeOpacity={0.75}
          >
            {busy ? (
              <ActivityIndicator size="small" color="#38bdf8" />
            ) : (
              <>
                <Ionicons name="camera-outline" size={15} color="#38bdf8" />
                <Text style={styles.btnCameraText}>Chụp ảnh</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handlePickLibrary}
            disabled={busy}
            style={[styles.btn, styles.btnLibrary]}
            activeOpacity={0.75}
          >
            <Ionicons name="images-outline" size={15} color="#a78bfa" />
            <Text style={styles.btnLibraryText}>Thư viện</Text>
          </TouchableOpacity>
        </View>
      </View>

      {images.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.thumbList}
        >
          {images.map((img) => (
            <View key={img.localId} style={styles.thumbWrap}>
              <TouchableOpacity onPress={() => setPreviewUri(img.uri)} activeOpacity={0.85}>
                <Image source={{ uri: img.uri }} style={styles.thumbImg} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => handleRemove(img.localId)}
                style={styles.removeBtn}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <Ionicons name="close" size={12} color="#fff" />
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}

      <Modal
        visible={!!previewUri}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewUri(null)}
      >
        <View style={styles.previewOverlay}>
          <TouchableOpacity
            style={styles.previewClose}
            onPress={() => setPreviewUri(null)}
          >
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
          {previewUri && (
            <Image
              source={{ uri: previewUri }}
              style={styles.previewImage}
              resizeMode="contain"
            />
          )}
        </View>
      </Modal>
    </View>
  );
}

const createStyles = (c: AppThemeColors, isDark: boolean) => StyleSheet.create({
  container: {
    backgroundColor: isDark ? 'rgba(15, 23, 42, 0.7)' : '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#e2e8f0',
    padding: 10,
    gap: 8,
  },
  containerCompact: {
    paddingVertical: 7,
    paddingHorizontal: 10,
    gap: 6,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  label: {
    color: c.textMuted,
    fontSize: 12,
    fontWeight: '700',
    flex: 1,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  btnCamera: {
    backgroundColor: isDark ? 'rgba(56, 189, 248, 0.12)' : '#e0f2fe',
    borderColor: isDark ? 'rgba(56, 189, 248, 0.35)' : '#bae6fd',
  },
  btnCameraText: {
    color: isDark ? '#38bdf8' : '#0369a1',
    fontSize: 12,
    fontWeight: '700',
  },
  btnLibrary: {
    backgroundColor: isDark ? 'rgba(167, 139, 250, 0.12)' : '#eef2ff',
    borderColor: isDark ? 'rgba(167, 139, 250, 0.35)' : '#c7d2fe',
  },
  btnLibraryText: {
    color: isDark ? '#c4b5fd' : '#4338ca',
    fontSize: 12,
    fontWeight: '700',
  },
  thumbList: {
    gap: 8,
    paddingTop: 2,
  },
  thumbWrap: {
    position: 'relative',
  },
  thumbImg: {
    width: 56,
    height: 56,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: isDark ? '#475569' : '#cbd5e1',
    backgroundColor: c.surface,
  },
  removeBtn: {
    position: 'absolute',
    top: -5,
    right: -5,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: isDark ? '#0f172a' : '#ffffff',
  },
  previewOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.94)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  previewClose: {
    position: 'absolute',
    top: 48,
    right: 20,
    zIndex: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewImage: {
    width: '94%',
    height: '80%',
  },
});
