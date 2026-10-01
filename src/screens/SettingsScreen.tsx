import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  Alert, ActivityIndicator, ScrollView
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { testConnection, DEFAULT_SUPABASE_URL, DEFAULT_ANON_KEY } from '../services/supabase';

export default function SettingsScreen({ onBack }: { onBack: () => void }) {
  const [url, setUrl] = useState(DEFAULT_SUPABASE_URL);
  const [anonKey, setAnonKey] = useState(DEFAULT_ANON_KEY);
  const [systemCode, setSystemCode] = useState('KHO_DONG_LANH');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    const savedUrl = await AsyncStorage.getItem('config_supabase_url');
    const savedKey = await AsyncStorage.getItem('config_supabase_key');
    const savedSys = await AsyncStorage.getItem('config_system_code');
    if (savedUrl) setUrl(savedUrl);
    if (savedKey) setAnonKey(savedKey);
    if (savedSys) setSystemCode(savedSys);
  }

  async function handleSave() {
    await AsyncStorage.setItem('config_supabase_url', url.trim());
    await AsyncStorage.setItem('config_supabase_key', anonKey.trim());
    await AsyncStorage.setItem('config_system_code', systemCode.trim());
    Alert.alert('Thành công', 'Đã lưu cấu hình máy chủ!');
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testConnection();
      setTestResult(res.message);
    } catch (e: any) {
      setTestResult('Lỗi: ' + e.message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Ionicons name="arrow-back" size={22} color="#fff" />
          <Text style={{ color: '#fff', fontWeight: '700' }}>Quay lại</Text>
        </TouchableOpacity>
        <Text style={styles.title}>CÀI ĐẶT HỆ THỐNG</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Tên miền máy chủ Supabase:</Text>
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          placeholder="https://api.chanhthu.click"
          placeholderTextColor="#64748b"
          autoCapitalize="none"
        />

        <Text style={styles.label}>Mã hệ thống kho (system_code):</Text>
        <TextInput
          style={styles.input}
          value={systemCode}
          onChangeText={setSystemCode}
          placeholder="KHO_DONG_LANH"
          placeholderTextColor="#64748b"
        />

        <Text style={styles.label}>Anon Key:</Text>
        <TextInput
          style={[styles.input, { height: 70, fontSize: 11 }]}
          value={anonKey}
          onChangeText={setAnonKey}
          multiline
          placeholder="eyJhbGciOi..."
          placeholderTextColor="#64748b"
        />

        <View style={styles.btnRow}>
          <TouchableOpacity style={styles.testBtn} onPress={handleTest} disabled={testing}>
            {testing ? (
              <ActivityIndicator color="#38bdf8" />
            ) : (
              <>
                <Ionicons name="pulse-outline" size={18} color="#38bdf8" />
                <Text style={styles.testBtnText}>Kiểm tra kết nối</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
            <Ionicons name="save-outline" size={18} color="#fff" />
            <Text style={styles.saveBtnText}>Lưu Cài Đặt</Text>
          </TouchableOpacity>
        </View>

        {testResult && (
          <View style={styles.resultBox}>
            <Text style={styles.resultText}>{testResult}</Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b'
  },
  title: { color: '#fff', fontSize: 16, fontWeight: '900' },
  card: { padding: 16 },
  label: { color: '#cbd5e1', fontSize: 12, fontWeight: '700', marginTop: 12, marginBottom: 4 },
  input: {
    backgroundColor: '#1e293b',
    color: '#fff',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
    fontSize: 13
  },
  btnRow: { flexDirection: 'row', gap: 10, marginTop: 20 },
  testBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1e293b',
    borderColor: '#38bdf8',
    borderWidth: 1,
    paddingVertical: 12,
    borderRadius: 8,
    gap: 6
  },
  testBtnText: { color: '#38bdf8', fontWeight: '800' },
  saveBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#059669',
    paddingVertical: 12,
    borderRadius: 8,
    gap: 6
  },
  saveBtnText: { color: '#fff', fontWeight: '900' },
  resultBox: {
    backgroundColor: '#020617',
    padding: 12,
    borderRadius: 8,
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#334155'
  },
  resultText: { color: '#38bdf8', fontSize: 12, fontWeight: '600' }
});