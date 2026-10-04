import React, { createContext, useContext, useState, useEffect } from 'react';
import { UserProfile } from '../types/auth';
import { checkSessionUser, loginUser, logoutUser, getStoredUser } from '../services/auth';

interface AuthContextType {
  user: UserProfile | null;
  isLoading: boolean;
  login: (userOrEmail: string, pass: string) => Promise<{ success: boolean; message?: string }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    initAuth();
  }, []);

  async function initAuth() {
    setIsLoading(true);
    try {
      // First quick load from AsyncStorage for instant UI responsiveness
      const stored = await getStoredUser();
      if (stored) {
        setUser(stored);
      }
      // Then check cloud session
      const freshUser = await checkSessionUser();
      setUser(freshUser);
    } catch (e) {
      console.warn('Lỗi khởi tạo Auth:', e);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleLogin(userOrEmail: string, pass: string) {
    setIsLoading(true);
    try {
      const res = await loginUser(userOrEmail, pass);
      if (res.success && res.user) {
        setUser(res.user);
        return { success: true };
      }
      return { success: false, message: res.message || 'Đăng nhập không thành công' };
    } finally {
      setIsLoading(false);
    }
  }

  async function handleLogout() {
    setIsLoading(true);
    try {
      await logoutUser();
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshUser() {
    const freshUser = await checkSessionUser();
    setUser(freshUser);
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        login: handleLogin,
        logout: handleLogout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
